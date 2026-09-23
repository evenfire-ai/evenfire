import { describe, expect, it, vi } from 'vitest'
import { CONTROL_API_REQUEST_TIMEOUT_MS } from '../src/controlApiClient.js'
import {
  assertBoundedDeadline,
  RequestLimitError,
  STREAM_LIMITS,
  StreamGate,
} from '../src/requestLimits.js'
import { DEFAULT_HEARTBEAT_INTERVAL_MS, MAX_HEARTBEAT_INTERVAL_MS } from '../src/sseHeartbeat.js'

// undici's default headersTimeout and bodyTimeout in the Node 24.16.0 image the
// Host runs; the Host sets neither for its proxy calls.
const HOST_UNDICI_TIMEOUT_MS = 300_000

describe('stream timing invariant', () => {
  it('reaches the first keepalive before the Host HTTP client times out', () => {
    expect(STREAM_LIMITS.maxStreamDurationMs).toBe(1_800_000)
    expect(STREAM_LIMITS.maxQueueWaitMs).toBe(60_000)
    // Nothing is written while a request waits for a slot or for the redeem,
    // so both must end, and one heartbeat interval pass, inside the timeout.
    // The interval is configurable, so the largest one config accepts is the
    // one pinned.
    expect(MAX_HEARTBEAT_INTERVAL_MS).toBe(60_000)
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(MAX_HEARTBEAT_INTERVAL_MS)
    expect(
      STREAM_LIMITS.maxQueueWaitMs + CONTROL_API_REQUEST_TIMEOUT_MS + MAX_HEARTBEAT_INTERVAL_MS
    ).toBeLessThan(HOST_UNDICI_TIMEOUT_MS)
  })
})

describe('assertBoundedDeadline', () => {
  it('refuses a missing or invalid proxy maximum even when the request carries a deadline', () => {
    // Liveness witness: the same request deadline passes with a valid maximum.
    expect(assertBoundedDeadline(1_000, 1_800_000)).toBe(1_000)
    for (const maxDeadlineMs of [undefined, Number.NaN, 0, -1, 1.5]) {
      let caught: unknown
      try {
        assertBoundedDeadline(1_000, maxDeadlineMs as unknown as number)
      } catch (err) {
        caught = err
      }
      expect(caught, `maxDeadlineMs=${String(maxDeadlineMs)}`).toBeInstanceOf(RequestLimitError)
      expect((caught as Error).message).toBe('deadline is invalid')
    }
  })
})

describe('StreamGate', () => {
  it('admits a queued waiter once a running stream releases', async () => {
    const gate = new StreamGate(1, 1)
    const release = await gate.acquire()
    let admitted = false
    const queued = gate.acquire().then(next => {
      admitted = true
      return next
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(admitted).toBe(false)
    release()
    const releaseQueued = await queued
    expect(admitted).toBe(true)
    releaseQueued()
  })

  it('rejects immediately without taking a slot when the signal is already aborted', async () => {
    const gate = new StreamGate(1, 1)
    const abort = new AbortController()
    abort.abort()
    await expect(gate.acquire(abort.signal)).rejects.toBeInstanceOf(RequestLimitError)
    // The running slot was not consumed: a fresh caller is admitted at once.
    const release = await Promise.race([
      gate.acquire(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('slot leaked by aborted caller')), 100)
      ),
    ])
    release()
  })

  it('rejects a queued waiter when its client aborts and frees the queue slot', async () => {
    const gate = new StreamGate(1, 1)
    const release = await gate.acquire()
    const abort = new AbortController()
    const queued = gate.acquire(abort.signal)
    abort.abort()
    await expect(
      Promise.race([
        queued,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('queued waiter ignored abort')), 200)
        ),
      ])
    ).rejects.toBeInstanceOf(RequestLimitError)
    // The queue slot is free again, so a new waiter queues instead of "queue is full".
    const next = gate.acquire()
    release()
    const releaseNext = await next
    releaseNext()
  })

  it('rejects a waiter queued longer than maxQueueWaitMs and frees its queue slot', async () => {
    const gate = new StreamGate(1, 1, 50)
    const release = await gate.acquire()
    const started = Date.now()
    await expect(gate.acquire()).rejects.toMatchObject({
      name: 'RequestLimitError',
      message: 'stream queue wait exceeded',
    })
    // Witness: the waiter was queued for the whole wait, not refused at once.
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
    // The queue slot is free again, so a new waiter queues instead of "queue is full".
    const next = gate.acquire()
    release()
    const releaseNext = await next
    releaseNext()
  })

  // The gate polls for a free slot every 10 ms. A bound that is not a multiple
  // of 10 falls between two polls, so these two cases separate a deadline the
  // gate enforces on its own timer from one it only notices on the next poll.
  it('rejects at maxQueueWaitMs even when a slot frees before the next poll', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      let outcome: string | undefined
      const waiter = gate.acquire().then(
        () => {
          outcome = 'admitted'
        },
        (err: Error) => {
          outcome = err.message
        }
      )
      await vi.advanceTimersByTimeAsync(54)
      // Witness: the waiter is still queued one millisecond before the bound.
      expect(outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(outcome).toBe('stream queue wait exceeded')
      // The poll stopped with the rejection: no timer is left behind.
      expect(vi.getTimerCount()).toBe(0)
      // A slot that frees after the bound and before the next poll (60 ms)
      // must not reach the waiter that was already refused.
      await vi.advanceTimersByTimeAsync(2)
      release()
      await vi.advanceTimersByTimeAsync(10)
      await waiter
      expect(outcome).toBe('stream queue wait exceeded')
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles at maxQueueWaitMs when a slot frees between the last poll and the bound', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      let outcome: string | undefined
      const waiter = gate.acquire().then(
        () => {
          outcome = 'admitted'
        },
        (err: Error) => {
          outcome = err.message
        }
      )
      // Last poll at 50 ms sees the slot taken; it frees at 52 ms.
      await vi.advanceTimersByTimeAsync(52)
      release()
      // Witness: nothing has settled the waiter yet.
      expect(outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(3)
      // The bound is a deadline: the waiter is settled at 55 ms, not at the
      // 60 ms poll, and the deadline does not look at the slot count.
      expect(outcome).toBe('stream queue wait exceeded')
      await waiter
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a maxQueueWaitMs that setTimeout cannot honor', () => {
    // Witness: the bounds themselves are accepted.
    expect(() => new StreamGate(1, 1, 1)).not.toThrow()
    expect(() => new StreamGate(1, 1, 2_147_483_647)).not.toThrow()
    for (const maxQueueWaitMs of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      expect(() => new StreamGate(1, 1, maxQueueWaitMs), String(maxQueueWaitMs)).toThrow(RangeError)
    }
  })

  it('admits a waiter whose slot frees before maxQueueWaitMs', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      let outcome: string | undefined
      const waiter = gate.acquire().then(
        next => {
          outcome = 'admitted'
          return next
        },
        (err: Error) => {
          outcome = err.message
          return undefined
        }
      )
      await vi.advanceTimersByTimeAsync(45)
      release()
      await vi.advanceTimersByTimeAsync(5)
      expect(outcome).toBe('admitted')
      // The deadline timer was cleared on admission, before it could fire.
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(100)
      expect(outcome).toBe('admitted')
      ;(await waiter)?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
