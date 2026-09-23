import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { CONTROL_API_REQUEST_TIMEOUT_MS } from '../src/controlApiClient.js'
import {
  assertBoundedDeadline,
  RequestLimitError,
  STREAM_LIMITS,
  StreamGate,
  VISUAL_STREAM_LIMITS,
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
    // A visual request can wait twice: on visualStreamGate before the body is
    // parsed, then on streamGate when the parsed body no longer needs the
    // visual slot. Both gates share the maxQueueWaitMs default. The interval
    // is configurable, so the largest one config accepts is the one pinned.
    expect(MAX_HEARTBEAT_INTERVAL_MS).toBe(60_000)
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(MAX_HEARTBEAT_INTERVAL_MS)
    expect(
      2 * STREAM_LIMITS.maxQueueWaitMs +
        CONTROL_API_REQUEST_TIMEOUT_MS +
        MAX_HEARTBEAT_INTERVAL_MS
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

// Queues a waiter behind `gate` and records how it settled.
function track(gate: StreamGate, signal?: AbortSignal) {
  const state: { outcome?: string } = {}
  const waiter = gate.acquire(signal).then(
    next => {
      state.outcome = 'admitted'
      return next
    },
    (err: Error) => {
      state.outcome = err.message
      return undefined
    }
  )
  return { state, waiter }
}

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

  it('clears the deadline and the poll when a queued client aborts', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      const abort = new AbortController()
      const { state, waiter } = track(gate, abort.signal)
      await vi.advanceTimersByTimeAsync(20)
      // Witness: the waiter is queued with its deadline, its poll and its
      // abort listener live.
      expect(state.outcome).toBeUndefined()
      expect(vi.getTimerCount()).toBe(2)
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1)
      abort.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(state.outcome).toBe('stream request was aborted')
      expect(vi.getTimerCount()).toBe(0)
      await waiter
      expect(gate.snapshot()).toEqual({ running: 1, queued: 0 })
      release()
    } finally {
      vi.useRealTimers()
    }
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

  it('refuses a waiter at the 60 000 ms default maxQueueWaitMs', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1)
      const release = await gate.acquire()
      const { state, waiter } = track(gate)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(state.outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(state.outcome).toBe('stream queue wait exceeded')
      await waiter
      release()
    } finally {
      vi.useRealTimers()
    }
  })

  // The gate polls for a free slot every 10 ms. A bound that is not a multiple
  // of 10 falls between two polls, so the next two cases separate a deadline
  // the gate enforces on its own timer from one it only notices on the next poll.
  it('rejects at maxQueueWaitMs and leaves no timer or abort listener behind', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      const abort = new AbortController()
      const { state, waiter } = track(gate, abort.signal)
      await vi.advanceTimersByTimeAsync(54)
      // Witness: one millisecond before the bound the waiter is still queued,
      // with its deadline, its poll and its abort listener live.
      expect(state.outcome).toBeUndefined()
      expect(gate.snapshot()).toEqual({ running: 1, queued: 1 })
      expect(vi.getTimerCount()).toBe(2)
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(state.outcome).toBe('stream queue wait exceeded')
      expect(vi.getTimerCount()).toBe(0)
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0)
      await waiter
      // The queue slot was returned exactly once: one new waiter queues and
      // the one after it finds the queue full.
      expect(gate.snapshot()).toEqual({ running: 1, queued: 0 })
      const next = gate.acquire()
      await expect(gate.acquire()).rejects.toThrow('stream queue is full')
      release()
      await vi.advanceTimersByTimeAsync(10)
      ;(await next)()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles at maxQueueWaitMs when a slot frees between the last poll and the bound', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      const { state, waiter } = track(gate)
      // Last poll at 50 ms sees the slot taken; it frees at 52 ms.
      await vi.advanceTimersByTimeAsync(52)
      release()
      // Witness: nothing has settled the waiter yet.
      expect(state.outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(3)
      // The bound is a deadline: the waiter is settled at 55 ms, not at the
      // 60 ms poll, and the deadline does not look at the slot count.
      expect(state.outcome).toBe('stream queue wait exceeded')
      await waiter
      expect(gate.snapshot()).toEqual({ running: 0, queued: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a waiter when the poll due at the bound finds a free slot', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 50)
      const release = await gate.acquire()
      const { state, waiter } = track(gate)
      await vi.advanceTimersByTimeAsync(45)
      release()
      expect(state.outcome).toBeUndefined()
      // The deadline and the 50 ms poll fall due together; the poll must not
      // admit a waiter whose wait has reached the bound.
      await vi.advanceTimersByTimeAsync(5)
      expect(state.outcome).toBe('stream queue wait exceeded')
      await waiter
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a waiter whose poll runs after the bound because the event loop stalled', async () => {
    const gate = new StreamGate(1, 1, 200)
    const release = await gate.acquire()
    const queuedAt = performance.now()
    const { state, waiter } = track(gate)
    await new Promise(resolve => setTimeout(resolve, 20))
    // Witness: the poll has run and found the slot taken.
    expect(state.outcome).toBeUndefined()
    // Hold the event loop past the bound, then free the slot before any timer
    // can run. The next poll and the deadline are now both overdue, and Node
    // runs the poll first because it was due first.
    while (performance.now() - queuedAt < 230) {
      // busy wait
    }
    release()
    ;(await waiter)?.()
    expect(state.outcome).toBe('stream queue wait exceeded')
  })

  it('admits a waiter whose slot frees before maxQueueWaitMs', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      const abort = new AbortController()
      const { state, waiter } = track(gate, abort.signal)
      await vi.advanceTimersByTimeAsync(45)
      // Witness: the abort listener is registered while the waiter is queued.
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1)
      release()
      await vi.advanceTimersByTimeAsync(5)
      expect(state.outcome).toBe('admitted')
      // The deadline timer and the abort listener were cleared on admission.
      expect(vi.getTimerCount()).toBe(0)
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(100)
      expect(state.outcome).toBe('admitted')
      expect(gate.snapshot()).toEqual({ running: 1, queued: 0 })
      ;(await waiter)?.()
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

  it('refuses a slot or queue size the gate cannot enforce', () => {
    // Witness: the smallest sizes are accepted, including a gate with no queue.
    expect(() => new StreamGate(1, 0)).not.toThrow()
    for (const maxConcurrent of [0, -1, 1.5, Number.NaN]) {
      expect(() => new StreamGate(maxConcurrent, 1), `maxConcurrent=${maxConcurrent}`).toThrow(RangeError)
    }
    for (const maxQueued of [-1, 1.5, Number.NaN]) {
      expect(() => new StreamGate(1, maxQueued), `maxQueued=${maxQueued}`).toThrow(RangeError)
    }
  })

  it('pins the visual 2/8 sibling against the ordinary 8/16 stream gate', () => {
    expect(VISUAL_STREAM_LIMITS).toEqual({ maxConcurrentStreams: 2, maxQueuedRequests: 8 })
    expect(STREAM_LIMITS.maxConcurrentStreams).toBe(8)
    expect(STREAM_LIMITS.maxQueuedRequests).toBe(16)
  })

  it('rejects the 11th visual waiter once 2 are running and 8 are queued', async () => {
    const gate = new StreamGate(
      VISUAL_STREAM_LIMITS.maxConcurrentStreams,
      VISUAL_STREAM_LIMITS.maxQueuedRequests
    )
    const held = [await gate.acquire(), await gate.acquire()]
    const queued = Array.from({ length: VISUAL_STREAM_LIMITS.maxQueuedRequests }, () =>
      gate.acquire()
    )
    await expect(gate.acquire()).rejects.toBeInstanceOf(RequestLimitError)
    for (const release of held) release()
    for (const waiter of queued) (await waiter)()
  })
})
