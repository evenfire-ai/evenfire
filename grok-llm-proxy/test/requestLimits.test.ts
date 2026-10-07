import { getEventListeners } from 'node:events'
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
  it('T-KI-1-grok reaches the first keepalive before the Host HTTP client times out', () => {
    expect(STREAM_LIMITS.maxStreamDurationMs).toBe(1_800_000)
    expect(STREAM_LIMITS.maxQueueWaitMs).toBe(60_000)
    expect(CONTROL_API_REQUEST_TIMEOUT_MS).toBe(15_000)
    // Nothing is written while a request waits for a slot or for the redeem,
    // so both must end, and one heartbeat interval pass, inside the timeout.
    // Every wait a request performs (the body budget, the stream gate) is
    // bounded by one admission clock of maxQueueWaitMs from arrival (#739 D1),
    // so the queue time counts once. The interval is configurable, so the
    // largest one config accepts is the one pinned.
    expect(MAX_HEARTBEAT_INTERVAL_MS).toBe(60_000)
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(MAX_HEARTBEAT_INTERVAL_MS)
    const firstKeepaliveBy =
      STREAM_LIMITS.maxQueueWaitMs + CONTROL_API_REQUEST_TIMEOUT_MS + MAX_HEARTBEAT_INTERVAL_MS
    expect(firstKeepaliveBy).toBe(135_000)
    expect(HOST_UNDICI_TIMEOUT_MS).toBe(300_000)
    expect(firstKeepaliveBy).toBeLessThan(HOST_UNDICI_TIMEOUT_MS)
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

  it('grants a freed slot to the head waiter, not to a newcomer', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1)
      const release = await gate.acquire()
      const head = track(gate)
      // Witness: the head waiter is queued and holds the one queue place.
      await expect(gate.acquire()).rejects.toThrow('stream queue is full')
      expect(head.state.outcome).toBeUndefined()
      release()
      const newcomer = track(gate)
      await vi.advanceTimersByTimeAsync(0)
      expect(head.state.outcome).toBe('admitted')
      expect(newcomer.state.outcome).toBeUndefined()
      // Witness: the newcomer is queued behind the head, not refused.
      await expect(gate.acquire()).rejects.toThrow('stream queue is full')
      ;(await head.waiter)?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(newcomer.state.outcome).toBe('admitted')
      ;(await newcomer.waiter)?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('admits a waiter at the first release while newcomers keep arriving', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const held: Array<() => void> = [await gate.acquire()]
      const outcomes: string[] = []
      const enter = (label: string) =>
        gate.acquire().then(
          next => {
            outcomes.push(`${label}:admitted`)
            held.push(next)
          },
          (err: Error) => {
            outcomes.push(`${label}:${err.message}`)
          }
        )
      void enter('waiter')
      // One release and one new arrival every 3 ms, past the 55 ms bound.
      for (let tick = 1; tick <= 20; tick += 1) {
        const release = held.shift()
        // Witness: a slot is held at every tick, so each release is a real hand-off.
        expect(release).toBeDefined()
        release?.()
        void enter(`tick${tick}`)
        await vi.advanceTimersByTimeAsync(3)
        if (tick === 1) expect(outcomes).toEqual(['waiter:admitted'])
      }
      expect(outcomes.filter(outcome => !outcome.endsWith(':admitted'))).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('makes a release idempotent', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(2, 1)
      const first = await gate.acquire()
      const second = await gate.acquire()
      first()
      first()
      // One slot is free and one is held, so the next caller is admitted at once.
      const third = track(gate)
      await vi.advanceTimersByTimeAsync(0)
      expect(third.state.outcome).toBe('admitted')
      // Both slots are held again: a double release must not have freed a second one.
      const fourth = track(gate)
      await vi.advanceTimersByTimeAsync(0)
      expect(fourth.state.outcome).toBeUndefined()
      // Witness: the fourth caller is queued, and a release of a held slot admits it.
      second()
      await vi.advanceTimersByTimeAsync(0)
      expect(fourth.state.outcome).toBe('admitted')
      ;(await third.waiter)?.()
      ;(await fourth.waiter)?.()
    } finally {
      vi.useRealTimers()
    }
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

  it('clears the deadline timer and the abort listener when a queued client aborts', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      const abort = new AbortController()
      const { state, waiter } = track(gate, abort.signal)
      await vi.advanceTimersByTimeAsync(20)
      // Witness: the waiter is queued with its one deadline timer and its
      // abort listener live.
      expect(state.outcome).toBeUndefined()
      expect(vi.getTimerCount()).toBe(1)
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1)
      abort.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(state.outcome).toBe('stream request was aborted')
      expect(vi.getTimerCount()).toBe(0)
      await waiter
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

  it('T-AC-3-grok rejects a waiter at its admission deadline when that comes before maxQueueWaitMs', async () => {
    const gate = new StreamGate(1, 1, 60_000)
    const release = await gate.acquire()
    const started = Date.now()
    const queued = gate.acquire(undefined, started + 50)
    // Witness: the waiter really queued, so the one queue slot is taken.
    await expect(gate.acquire()).rejects.toMatchObject({
      name: 'RequestLimitError',
      message: 'stream queue is full',
    })
    await expect(
      Promise.race([
        queued,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('the admission deadline did not end the wait')), 1_000)
        ),
      ])
    ).rejects.toMatchObject({ name: 'RequestLimitError', message: 'stream queue wait exceeded' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
    // The queue slot is free again, so a new waiter queues instead of "queue is full".
    const next = gate.acquire()
    release()
    const releaseNext = await next
    releaseNext()
  })

  // The admission deadline shortens the bound the gate's own timer enforces.
  // maxQueueWaitMs is 60 000 ms here, so only a timer armed with deadlineAt can
  // settle the waiter at 55 ms.
  it('T-AC-3b-grok settles at deadlineAt on the deadline timer, not at maxQueueWaitMs', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 60_000)
      const release = await gate.acquire()
      const state: { outcome?: string } = {}
      const waiter = gate.acquire(undefined, Date.now() + 55).then(
        () => {
          state.outcome = 'admitted'
        },
        (err: Error) => {
          state.outcome = err.message
        }
      )
      await vi.advanceTimersByTimeAsync(54)
      // Witness: one millisecond before the deadline the waiter is still
      // queued, holding the one queue slot.
      expect(state.outcome).toBeUndefined()
      await expect(gate.acquire()).rejects.toThrow('stream queue is full')
      await vi.advanceTimersByTimeAsync(1)
      expect(state.outcome).toBe('stream queue wait exceeded')
      expect(vi.getTimerCount()).toBe(0)
      await waiter
      // The queue slot is free again: a new waiter queues and is admitted
      // once the running stream releases.
      const next = gate.acquire()
      release()
      await vi.advanceTimersByTimeAsync(0)
      ;(await next)()
    } finally {
      vi.useRealTimers()
    }
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

  it('rejects at maxQueueWaitMs and leaves no timer or abort listener behind', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      const abort = new AbortController()
      const { state, waiter } = track(gate, abort.signal)
      await vi.advanceTimersByTimeAsync(54)
      // Witness: one millisecond before the bound the waiter is still queued,
      // with its one deadline timer and its abort listener live.
      expect(state.outcome).toBeUndefined()
      expect(vi.getTimerCount()).toBe(1)
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(state.outcome).toBe('stream queue wait exceeded')
      expect(vi.getTimerCount()).toBe(0)
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0)
      await waiter
      // The queue slot was returned exactly once: one new waiter queues and
      // the one after it finds the queue full.
      const next = gate.acquire()
      await expect(gate.acquire()).rejects.toThrow('stream queue is full')
      release()
      await vi.advanceTimersByTimeAsync(0)
      ;(await next)()
    } finally {
      vi.useRealTimers()
    }
  })

  it('admits a waiter whose slot frees 3 ms before the bound, at the release', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      const { state, waiter } = track(gate)
      await vi.advanceTimersByTimeAsync(52)
      // Witness: the waiter is still queued, holding the one queue place.
      expect(state.outcome).toBeUndefined()
      await expect(gate.acquire()).rejects.toThrow('stream queue is full')
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(state.outcome).toBe('admitted')
      // The deadline timer was cleared at the grant: passing the bound
      // changes nothing.
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(3)
      expect(state.outcome).toBe('admitted')
      ;(await waiter)?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('admits a waiter whose slot frees 1 ms before the bound and keeps it admitted at the bound', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 50)
      const release = await gate.acquire()
      const { state, waiter } = track(gate)
      await vi.advanceTimersByTimeAsync(49)
      // Witness: one millisecond before the bound the waiter is still queued.
      expect(state.outcome).toBeUndefined()
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(state.outcome).toBe('admitted')
      await vi.advanceTimersByTimeAsync(1)
      expect(state.outcome).toBe('admitted')
      ;(await waiter)?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a waiter whose slot frees after the bound because the event loop stalled', async () => {
    const gate = new StreamGate(1, 1, 500)
    const release = await gate.acquire()
    const { state, waiter } = track(gate)
    // Read after acquire() has recorded its own start, so the block below
    // measures at least as long as the gate does. Read before it, a runner
    // pause between the two reads would come out of the 30 ms margin.
    const queuedAt = performance.now()
    await new Promise(resolve => setTimeout(resolve, 20))
    // Witness: the waiter is still queued after the 20 ms wait. The 500 ms
    // bound leaves 25x that wait, so a paused runner does not fire the
    // deadline first; without this witness the deadline could do the rejecting
    // and the test would pass with the elapsed check removed.
    expect(state.outcome).toBeUndefined()
    // Hold the event loop past the bound, then free the slot before any timer
    // can run. The deadline timer is overdue, and the release must reject the
    // head waiter instead of granting it the slot.
    while (performance.now() - queuedAt < 530) {
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
})
