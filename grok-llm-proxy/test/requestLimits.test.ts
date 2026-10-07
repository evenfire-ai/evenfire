import { describe, expect, it, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { CONTROL_API_REQUEST_TIMEOUT_MS } from '../src/controlApiClient.js'
import {
  RequestLimitError,
  STREAM_LIMITS,
  StreamGate,
  VISUAL_PER_HOST_MAX_ADMITTED,
  VISUAL_STREAM_LIMITS,
  assertBoundedDeadline,
  visualStreamGate,
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

  it('clears the deadline when a queued client aborts', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      const abort = new AbortController()
      const { state, waiter } = track(gate, abort.signal)
      await vi.advanceTimersByTimeAsync(20)
      // Witness: the waiter is queued with its deadline and its abort
      // listener live, and the gate keeps no other timer.
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
      // No caller deadline governed this wait, so a dead ticket cannot be inferred.
      kind: 'queue_wait',
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
    ).rejects.toMatchObject({
      name: 'RequestLimitError',
      message: 'stream queue wait exceeded',
      // The caller's deadline ended the wait; the server reads this, not the clock.
      kind: 'deadline',
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
    // The queue slot is free again, so a new waiter queues instead of "queue is full".
    const next = gate.acquire()
    release()
    const releaseNext = await next
    releaseNext()
  })

  // The admission deadline shortens the bound the gate's own timer enforces.
  // A timer armed with maxQueueWaitMs would leave the waiter queued past
  // 55 ms; only the deadline timer settles it there.
  it('T-AC-3b-grok settles at deadlineAt on the deadline timer, not on the next poll', async () => {
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
      await vi.advanceTimersByTimeAsync(10)
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

  // The gate keeps one timer per waiter, its deadline. A release hands the
  // slot to the oldest waiter in the same turn, so the bound and a release
  // are the only events that settle a waiter.
  it('rejects at maxQueueWaitMs and leaves no timer or abort listener behind', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      const abort = new AbortController()
      const { state, waiter } = track(gate, abort.signal)
      await vi.advanceTimersByTimeAsync(54)
      // Witness: one millisecond before the bound the waiter is still queued,
      // with its deadline and its abort listener live, and no other timer.
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
      await vi.advanceTimersByTimeAsync(10)
      ;(await next)()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands a slot that frees 3 ms before the bound to the waiter in the same turn', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 55)
      const release = await gate.acquire()
      const { state, waiter } = track(gate)
      await vi.advanceTimersByTimeAsync(52)
      // Witness: still queued 3 ms before the bound.
      expect(state.outcome).toBeUndefined()
      release()
      await vi.advanceTimersByTimeAsync(0)
      // No poll interval separates the release from the grant, and the grant
      // cleared the deadline timer.
      expect(state.outcome).toBe('admitted')
      expect(gate.snapshot()).toEqual({ running: 1, queued: 0 })
      expect(vi.getTimerCount()).toBe(0)
      ;(await waiter)?.()
      expect(gate.snapshot()).toEqual({ running: 0, queued: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a waiter whose bound and a release fall due in the same millisecond', async () => {
    vi.useFakeTimers()
    try {
      const gate = new StreamGate(1, 1, 50)
      const release = await gate.acquire()
      const { state, waiter } = track(gate)
      // Armed after the waiter's deadline timer with the same due time, so the
      // deadline runs first.
      setTimeout(release, 50)
      await vi.advanceTimersByTimeAsync(49)
      expect(state.outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(state.outcome).toBe('stream queue wait exceeded')
      await waiter
      // The release found nobody queued, so the slot was freed, not leaked.
      expect(gate.snapshot()).toEqual({ running: 0, queued: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a waiter that a release reaches after the bound because the event loop stalled', async () => {
    const gate = new StreamGate(1, 1, 500)
    const release = await gate.acquire()
    const { state, waiter } = track(gate)
    // Read after acquire() has recorded its own start, so the block below
    // measures at least as long as the gate does. Read before it, a runner
    // pause between the two reads would come out of the 30 ms margin.
    const queuedAt = performance.now()
    await new Promise(resolve => setTimeout(resolve, 20))
    // Witness: the waiter is still queued. The 500 ms bound leaves 25x the
    // 20 ms wait, so a paused runner does not fire the deadline first.
    expect(state.outcome).toBeUndefined()
    // Hold the event loop past the bound, then free the slot before any timer
    // can run. The deadline is overdue, so only the elapsed check in the
    // hand-off can refuse the waiter.
    while (performance.now() - queuedAt < 530) {
      // busy wait
    }
    release()
    // Settled in the release turn, before the deadline timer could run: the
    // hand-off refused the waiter and, with nobody left, freed the slot.
    expect(gate.snapshot()).toEqual({ running: 0, queued: 0 })
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

  // Grant order. A release hands its slot to the oldest waiter in the same
  // turn, and a caller that arrives while anyone is queued queues behind them.
  describe('FIFO hand-off', () => {
    function named(
      gate: StreamGate,
      name: string,
      order: string[],
      signal?: AbortSignal,
      deadlineAt?: number
    ) {
      const state: { outcome?: string; release?: () => void } = {}
      const waiter = gate.acquire(signal, deadlineAt).then(
        release => {
          order.push(name)
          state.outcome = 'admitted'
          state.release = release
        },
        (err: RequestLimitError) => {
          state.outcome = err.kind
        }
      )
      return { state, waiter }
    }

    it('grants the older of two waiters queued at different times first', async () => {
      vi.useFakeTimers()
      try {
        const gate = new StreamGate(1, 2, 60_000)
        const hold = await gate.acquire()
        const order: string[] = []
        const older = named(gate, 'older', order)
        await vi.advanceTimersByTimeAsync(5)
        const newer = named(gate, 'newer', order)
        await vi.advanceTimersByTimeAsync(7)
        // Witness: both are queued behind the held slot.
        expect(gate.snapshot()).toEqual({ running: 1, queued: 2 })
        hold()
        await vi.advanceTimersByTimeAsync(20)
        expect(order).toEqual(['older'])
        expect(newer.state.outcome).toBeUndefined()
        expect(gate.snapshot()).toEqual({ running: 1, queued: 1 })
        older.state.release!()
        await vi.advanceTimersByTimeAsync(0)
        expect(order).toEqual(['older', 'newer'])
        newer.state.release!()
        await Promise.all([older.waiter, newer.waiter])
        expect(gate.snapshot()).toEqual({ running: 0, queued: 0 })
      } finally {
        vi.useRealTimers()
      }
    })

    it('queues a caller that arrives in the release turn behind the waiter', async () => {
      vi.useFakeTimers()
      try {
        const gate = new StreamGate(1, 2, 60_000)
        const hold = await gate.acquire()
        const order: string[] = []
        const queued = named(gate, 'queued', order)
        await vi.advanceTimersByTimeAsync(3)
        hold()
        const late = named(gate, 'late', order)
        // The released slot went to the queued waiter, so the late caller
        // queued instead of taking it.
        expect(gate.snapshot()).toEqual({ running: 1, queued: 1 })
        await vi.advanceTimersByTimeAsync(20)
        expect(order).toEqual(['queued'])
        expect(late.state.outcome).toBeUndefined()
        queued.state.release!()
        await vi.advanceTimersByTimeAsync(0)
        expect(order).toEqual(['queued', 'late'])
        late.state.release!()
        await Promise.all([queued.waiter, late.waiter])
        expect(gate.snapshot()).toEqual({ running: 0, queued: 0 })
      } finally {
        vi.useRealTimers()
      }
    })

    it('skips an aborted head and grants the waiter behind it', async () => {
      vi.useFakeTimers()
      try {
        const gate = new StreamGate(1, 2, 60_000)
        const hold = await gate.acquire()
        const order: string[] = []
        const abort = new AbortController()
        const head = named(gate, 'head', order, abort.signal)
        const next = named(gate, 'next', order)
        abort.abort()
        await vi.advanceTimersByTimeAsync(0)
        expect(head.state.outcome).toBe('aborted')
        // Only the aborted waiter left the queue.
        expect(gate.snapshot()).toEqual({ running: 1, queued: 1 })
        hold()
        await vi.advanceTimersByTimeAsync(0)
        expect(order).toEqual(['next'])
        next.state.release!()
        await Promise.all([head.waiter, next.waiter])
        expect(gate.snapshot()).toEqual({ running: 0, queued: 0 })
      } finally {
        vi.useRealTimers()
      }
    })

    it('removes only the waiter whose deadline expires and returns its queue place', async () => {
      vi.useFakeTimers()
      try {
        const gate = new StreamGate(1, 2, 60_000)
        const hold = await gate.acquire()
        const order: string[] = []
        const early = named(gate, 'early', order, undefined, Date.now() + 30)
        const later = named(gate, 'later', order)
        await vi.advanceTimersByTimeAsync(29)
        // Witness: both are queued one millisecond before the first deadline.
        expect(gate.snapshot()).toEqual({ running: 1, queued: 2 })
        await expect(gate.acquire()).rejects.toMatchObject({ kind: 'queue_full' })
        await vi.advanceTimersByTimeAsync(1)
        expect(early.state.outcome).toBe('deadline')
        expect(later.state.outcome).toBeUndefined()
        expect(gate.snapshot()).toEqual({ running: 1, queued: 1 })
        // The freed queue place takes a new waiter, which queues behind `later`.
        const third = named(gate, 'third', order)
        expect(gate.snapshot()).toEqual({ running: 1, queued: 2 })
        hold()
        await vi.advanceTimersByTimeAsync(0)
        expect(order).toEqual(['later'])
        later.state.release!()
        await vi.advanceTimersByTimeAsync(0)
        expect(order).toEqual(['later', 'third'])
        third.state.release!()
        await Promise.all([early.waiter, later.waiter, third.waiter])
        expect(gate.snapshot()).toEqual({ running: 0, queued: 0 })
      } finally {
        vi.useRealTimers()
      }
    })

    it('passes a slot past a head whose bound a stalled event loop overran', async () => {
      const gate = new StreamGate(1, 2, 5_000)
      const hold = await gate.acquire()
      const order: string[] = []
      const startedAt = Date.now()
      const head = named(gate, 'head', order, undefined, startedAt + 50)
      const next = named(gate, 'next', order)
      const queuedAt = performance.now()
      // Hold the event loop past the head's bound so its deadline timer
      // cannot run before the release.
      while (performance.now() - queuedAt < 80) {
        // busy wait
      }
      hold()
      // The hand-off refused the overdue head and granted the next waiter in
      // the same turn: one slot running, nobody queued.
      expect(gate.snapshot()).toEqual({ running: 1, queued: 0 })
      await Promise.resolve()
      await head.waiter
      expect(head.state.outcome).toBe('deadline')
      await vi.waitFor(() => expect(order).toEqual(['next']))
      next.state.release!()
      await next.waiter
      expect(gate.snapshot()).toEqual({ running: 0, queued: 0 })
    })

    it('ignores a second call of the same release', async () => {
      vi.useFakeTimers()
      try {
        const gate = new StreamGate(1, 2, 60_000)
        const hold = await gate.acquire()
        const order: string[] = []
        const first = named(gate, 'first', order)
        const second = named(gate, 'second', order)
        hold()
        hold()
        await vi.advanceTimersByTimeAsync(0)
        // One release handed over one slot.
        expect(order).toEqual(['first'])
        expect(gate.snapshot()).toEqual({ running: 1, queued: 1 })
        first.state.release!()
        await vi.advanceTimersByTimeAsync(0)
        expect(order).toEqual(['first', 'second'])
        second.state.release!()
        second.state.release!()
        await Promise.all([first.waiter, second.waiter])
        expect(gate.snapshot()).toEqual({ running: 0, queued: 0 })
      } finally {
        vi.useRealTimers()
      }
    })
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
      expect(() => new StreamGate(maxConcurrent, 1), `maxConcurrent=${maxConcurrent}`).toThrow(
        RangeError
      )
    }
    for (const maxQueued of [-1, 1.5, Number.NaN]) {
      expect(() => new StreamGate(1, maxQueued), `maxQueued=${maxQueued}`).toThrow(RangeError)
    }
  })

  // A V2 body above the ordinary cap keeps its image bytes resident for the
  // whole upstream stream, so it takes a 1-wide sibling of the 8-wide gate.
  // Widening it needs a new memory measurement against the 2048Mi limit.
  it('pins the visual 1/4 sibling, its per-host share, and the ordinary 8/16 gate', () => {
    expect(VISUAL_STREAM_LIMITS).toEqual({ maxConcurrentStreams: 1, maxQueuedRequests: 4 })
    expect(VISUAL_PER_HOST_MAX_ADMITTED).toBe(2)
    expect(STREAM_LIMITS.maxConcurrentStreams).toBe(8)
    expect(STREAM_LIMITS.maxQueuedRequests).toBe(16)
  })

  it('rejects the 6th visual waiter once 1 is running and 4 are queued', async () => {
    const gate = new StreamGate(
      VISUAL_STREAM_LIMITS.maxConcurrentStreams,
      VISUAL_STREAM_LIMITS.maxQueuedRequests
    )
    const held = await gate.acquire()
    const queued = Array.from({ length: VISUAL_STREAM_LIMITS.maxQueuedRequests }, () =>
      gate.acquire()
    )
    // Witness: the four waiters are queued, not refused, before the sixth.
    expect(gate.snapshot()).toEqual({ running: 1, queued: 4 })
    await expect(gate.acquire()).rejects.toBeInstanceOf(RequestLimitError)
    held()
    // Each waiter releases its slot as soon as it gets one, so the cleanup
    // does not depend on the grant order.
    await Promise.all(queued.map(async waiter => (await waiter)()))
    expect(gate.snapshot()).toEqual({ running: 0, queued: 0 })
  })

  it('builds the shared visual gate from VISUAL_STREAM_LIMITS', async () => {
    const { maxConcurrentStreams, maxQueuedRequests } = VISUAL_STREAM_LIMITS
    const held: Array<() => void> = []
    for (let i = 0; i < maxConcurrentStreams; i += 1) held.push(await visualStreamGate.acquire())
    expect(visualStreamGate.snapshot()).toEqual({ running: maxConcurrentStreams, queued: 0 })
    // Width: every caller past maxConcurrentStreams queues instead of running.
    const queued = Array.from({ length: maxQueuedRequests }, () => visualStreamGate.acquire())
    expect(visualStreamGate.snapshot()).toEqual({
      running: maxConcurrentStreams,
      queued: maxQueuedRequests,
    })
    // Queue capacity: the caller after maxQueuedRequests is refused.
    await expect(visualStreamGate.acquire()).rejects.toMatchObject({ kind: 'queue_full' })
    for (const release of held) release()
    // Each waiter releases its slot as soon as it gets one, so the cleanup
    // does not depend on the grant order.
    await Promise.all(queued.map(async waiter => (await waiter)()))
    expect(visualStreamGate.snapshot()).toEqual({ running: 0, queued: 0 })
  })
})

/**
 * Records how an acquire settled: `admitted`, or the refusal's kind and wire
 * code. Unset while the waiter is still queued.
 */
function settled(waiter: Promise<() => void>) {
  const state: { outcome?: 'admitted' | { kind: string; code: string } } = {}
  const done = waiter.then(
    release => {
      state.outcome = 'admitted'
      release()
    },
    (err: RequestLimitError) => {
      state.outcome = { kind: err.kind, code: err.code }
    }
  )
  return { state, done }
}

describe('StreamGate refusal identity', () => {
  const FAKE_CLOCK = {
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] as Array<
      'setTimeout' | 'clearTimeout' | 'Date' | 'performance'
    >,
  }
  const WAIT_MS = STREAM_LIMITS.maxQueueWaitMs

  // The visual gate's own wait is the request's admission clock, so its caller
  // passes the arrival instant. The refusal must not depend on how many ms
  // passed between the arrival stamp and the enqueue.
  it('refuses visual waiters enqueued 0, 1 and 5 ms after arrival as visual_gate at arrival + maxQueueWaitMs', async () => {
    vi.useFakeTimers(FAKE_CLOCK)
    try {
      const gate = new StreamGate(1, 4, WAIT_MS, 'visual_gate')
      const held = await gate.acquire()
      const arrivedAt = Date.now()
      const admissionDeadlineAt = arrivedAt + WAIT_MS
      const atZero = settled(gate.acquire(undefined, admissionDeadlineAt, arrivedAt))
      await vi.advanceTimersByTimeAsync(1)
      const atOne = settled(gate.acquire(undefined, admissionDeadlineAt, arrivedAt))
      await vi.advanceTimersByTimeAsync(4)
      const atFive = settled(gate.acquire(undefined, admissionDeadlineAt, arrivedAt))

      await vi.advanceTimersByTimeAsync(WAIT_MS - 5 - 1)
      // Witness: one millisecond before the admission clock runs out, all
      // three waiters are still queued, so none was refused early.
      expect(Date.now()).toBe(admissionDeadlineAt - 1)
      expect(gate.snapshot()).toEqual({ running: 1, queued: 3 })
      expect([atZero.state.outcome, atOne.state.outcome, atFive.state.outcome]).toEqual([
        undefined,
        undefined,
        undefined,
      ])

      await vi.advanceTimersByTimeAsync(1)
      await Promise.all([atZero.done, atOne.done, atFive.done])
      expect(Date.now()).toBe(admissionDeadlineAt)
      const queueWait = { kind: 'queue_wait', code: 'visual_gate' }
      expect(atZero.state.outcome).toEqual(queueWait)
      expect(atOne.state.outcome).toEqual(queueWait)
      expect(atFive.state.outcome).toEqual(queueWait)
      expect(gate.snapshot()).toEqual({ running: 1, queued: 0 })
      held()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a visual waiter whose caller deadline is strictly earlier than arrival + maxQueueWaitMs as deadline', async () => {
    vi.useFakeTimers(FAKE_CLOCK)
    try {
      const gate = new StreamGate(1, 4, WAIT_MS, 'visual_gate')
      const held = await gate.acquire()
      const arrivedAt = Date.now()
      await vi.advanceTimersByTimeAsync(5)
      const callerDeadlineAt = arrivedAt + WAIT_MS - 1
      const waiter = settled(gate.acquire(undefined, callerDeadlineAt, arrivedAt))

      await vi.advanceTimersByTimeAsync(callerDeadlineAt - 1 - Date.now())
      // Witness: still queued one millisecond before the caller's deadline.
      expect(waiter.state.outcome).toBeUndefined()
      expect(gate.snapshot()).toEqual({ running: 1, queued: 1 })

      await vi.advanceTimersByTimeAsync(1)
      await waiter.done
      expect(Date.now()).toBe(callerDeadlineAt)
      expect(waiter.state.outcome).toEqual({ kind: 'deadline', code: 'provider_unavailable' })
      held()
    } finally {
      vi.useRealTimers()
    }
  })

  // The ordinary gate measures its own bound from the enqueue. A caller
  // deadline that lands exactly on that bound is the admission clock running
  // out, which is answered with provider_unavailable.
  it('refuses an ordinary waiter whose caller deadline ties its own bound as deadline', async () => {
    vi.useFakeTimers(FAKE_CLOCK)
    try {
      const gate = new StreamGate(1, 1)
      const held = await gate.acquire()
      const enqueuedAt = Date.now()
      const waiter = settled(gate.acquire(undefined, enqueuedAt + WAIT_MS))

      await vi.advanceTimersByTimeAsync(WAIT_MS - 1)
      // Witness: still queued one millisecond before the shared bound.
      expect(waiter.state.outcome).toBeUndefined()
      expect(gate.snapshot()).toEqual({ running: 1, queued: 1 })

      await vi.advanceTimersByTimeAsync(1)
      await waiter.done
      expect(Date.now() - enqueuedAt).toBe(WAIT_MS)
      expect(waiter.state.outcome).toEqual({ kind: 'deadline', code: 'provider_unavailable' })
      held()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses an ordinary waiter whose caller deadline is 1 ms past its own bound as queue_wait', async () => {
    vi.useFakeTimers(FAKE_CLOCK)
    try {
      const gate = new StreamGate(1, 1)
      const held = await gate.acquire()
      const enqueuedAt = Date.now()
      const waiter = settled(gate.acquire(undefined, enqueuedAt + WAIT_MS + 1))

      await vi.advanceTimersByTimeAsync(WAIT_MS - 1)
      // Witness: still queued one millisecond before the gate's own bound.
      expect(waiter.state.outcome).toBeUndefined()
      expect(gate.snapshot()).toEqual({ running: 1, queued: 1 })

      await vi.advanceTimersByTimeAsync(1)
      await waiter.done
      // The gate's own bound ended the wait, not the later caller deadline.
      expect(Date.now() - enqueuedAt).toBe(WAIT_MS)
      expect(waiter.state.outcome).toEqual({ kind: 'queue_wait', code: 'proxy_capacity_exceeded' })
      held()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a queue wait start that is not a finite epoch time', async () => {
    const gate = new StreamGate(1, 1)
    for (const start of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(gate.acquire(undefined, undefined, start), String(start)).rejects.toThrow(
        RangeError
      )
    }
    // Witness: the refusal took no slot, and a finite start is accepted.
    expect(gate.snapshot()).toEqual({ running: 0, queued: 0 })
    const release = await gate.acquire(undefined, undefined, Date.now())
    expect(gate.snapshot()).toEqual({ running: 1, queued: 0 })
    release()
  })
})
