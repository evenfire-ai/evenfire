import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  McpHealthScheduler,
  type SchedulerDeps,
  type SchedulerSnapshot,
} from '../src/mcpHealthScheduler'
import { FAST_POLL_INTERVAL_MS, POLL_INTERVAL_MS, STALE_AFTER_MS } from '../src/mcpServerHealth'
import type { HostRuntimeStatus, McpServerHealthRow } from '../src/types'

// ─── Fake deps ─────────────────────────────────────────────────────────────

type ArmedTimer = { id: number; fireAt: number; fn: () => void }

class FakeClock {
  ms = Date.parse('2026-04-21T18:00:00.000Z')
  advance(by: number) {
    this.ms += by
  }
}

class FakeTimerPool {
  private timers: ArmedTimer[] = []
  private nextId = 1
  constructor(private clock: FakeClock) {}

  setTimer = (fn: () => void, ms: number): (() => void) => {
    const id = this.nextId++
    const fireAt = this.clock.ms + ms
    this.timers.push({ id, fireAt, fn })
    return () => {
      this.timers = this.timers.filter(t => t.id !== id)
    }
  }

  /** Fire the single earliest armed timer (advancing the clock to match). */
  async fireNext(): Promise<void> {
    if (this.timers.length === 0) throw new Error('no timers armed')
    this.timers.sort((a, b) => a.fireAt - b.fireAt)
    const t = this.timers.shift()!
    this.clock.ms = t.fireAt
    t.fn()
    await flushMicrotasks()
  }

  get armedCount(): number {
    return this.timers.length
  }
  get armedDelays(): number[] {
    return this.timers.map(t => t.fireAt - this.clock.ms)
  }
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve()
}

function row(overrides: Partial<McpServerHealthRow> & { name: string }): McpServerHealthRow {
  return {
    state: 'connected',
    expected: true,
    toolCount: 1,
    reason: null,
    message: null,
    observedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeStatus(
  hostRef: string,
  clock: FakeClock,
  mcpServers?: McpServerHealthRow[]
): HostRuntimeStatus {
  return {
    hostRef,
    agent: {
      state: 'idle',
      currentTaskId: null,
      tasksProcessed: 0,
      tasksSucceeded: 0,
      tasksFailed: 0,
      uptime: 0,
    },
    queue: { pending: 0, processing: 0, completed: 0, failed: 0 },
    cronJobs: 0,
    pendingApprovalsCount: 0,
    observedAt: new Date(clock.ms).toISOString(),
    ...(mcpServers ? { mcpServers } : {}),
  }
}

type Harness = {
  clock: FakeClock
  timers: FakeTimerPool
  fetchStatus: ReturnType<typeof vi.fn<(ref: string) => Promise<HostRuntimeStatus | null>>>
  scheduler: McpHealthScheduler
  snapshots: SchedulerSnapshot[]
  deps: SchedulerDeps
}

function makeHarness(
  fetchImplFactory?: (clock: FakeClock) => (ref: string) => Promise<HostRuntimeStatus | null>
): Harness {
  const clock = new FakeClock()
  const timers = new FakeTimerPool(clock)
  const defaultImpl = (ref: string) =>
    Promise.resolve(makeStatus(ref, clock, [row({ name: 's1', state: 'connected', toolCount: 1 })]))
  const impl = fetchImplFactory ? fetchImplFactory(clock) : defaultImpl
  const fetchStatus = vi.fn<(ref: string) => Promise<HostRuntimeStatus | null>>(impl)
  const deps: SchedulerDeps = {
    now: () => clock.ms,
    fetchStatus,
    setTimer: timers.setTimer,
  }
  const scheduler = new McpHealthScheduler(deps)
  const snapshots: SchedulerSnapshot[] = []
  scheduler.subscribe(snap => snapshots.push(snap))
  return { clock, timers, fetchStatus, scheduler, snapshots, deps }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('McpHealthScheduler — lifecycle', () => {
  it('setActiveHostRefs kicks off an immediate fetch per host', async () => {
    const h = makeHarness()
    h.scheduler.setActiveHostRefs(['a', 'b'])
    await flushMicrotasks()
    expect(h.fetchStatus).toHaveBeenCalledTimes(2)
    expect(h.fetchStatus).toHaveBeenCalledWith('a')
    expect(h.fetchStatus).toHaveBeenCalledWith('b')
  })

  it('arms one timer per host after the first fetch resolves', async () => {
    const h = makeHarness()
    h.scheduler.setActiveHostRefs(['a', 'b'])
    await flushMicrotasks()
    expect(h.timers.armedCount).toBe(2)
  })

  it('removing a host cancels its timer and drops its state', async () => {
    const h = makeHarness()
    h.scheduler.setActiveHostRefs(['a', 'b'])
    await flushMicrotasks()
    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    expect(h.timers.armedCount).toBe(1)
    const snap = h.scheduler.snapshot()
    expect(snap.statusByHostRef.has('b')).toBe(false)
  })

  it('dispose cancels every timer and the scheduler becomes inert', async () => {
    const h = makeHarness()
    h.scheduler.setActiveHostRefs(['a', 'b'])
    await flushMicrotasks()
    h.scheduler.dispose()
    expect(h.timers.armedCount).toBe(0)
    h.fetchStatus.mockClear()
    h.scheduler.setActiveHostRefs(['c']) // should be a no-op
    await flushMicrotasks()
    expect(h.fetchStatus).not.toHaveBeenCalled()
  })
})

describe('McpHealthScheduler — pickIntervalMs', () => {
  it('fast-polls while a host has a connecting row', async () => {
    const h = makeHarness(
      clock => ref =>
        Promise.resolve(
          makeStatus(ref, clock, [row({ name: 's1', state: 'connecting', toolCount: 0 })])
        )
    )
    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    expect(h.timers.armedDelays).toEqual([FAST_POLL_INTERVAL_MS])
  })

  it('steady-polls once all rows are connected', async () => {
    const h = makeHarness(
      clock => ref =>
        Promise.resolve(
          makeStatus(ref, clock, [row({ name: 's1', state: 'connected', toolCount: 2 })])
        )
    )
    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    expect(h.timers.armedDelays).toEqual([POLL_INTERVAL_MS])
  })

  it('fast-polls until the first fetch returns (cold open)', () => {
    const deferred: Array<() => void> = []
    const h = makeHarness(
      clock => () =>
        new Promise<HostRuntimeStatus>(resolve => {
          deferred.push(() =>
            resolve(makeStatus('a', clock, [row({ name: 's1', state: 'connected', toolCount: 3 })]))
          )
        })
    )
    h.scheduler.setActiveHostRefs(['a'])
    // No fetch has resolved yet — interval should reflect "cold" state.
    expect(h.scheduler.snapshot().nextIntervalMs).toBe(FAST_POLL_INTERVAL_MS)
  })

  it('fast-polls when the latest snapshot has aged past STALE_AFTER_MS', async () => {
    const h = makeHarness(
      clock => ref =>
        Promise.resolve(
          makeStatus(ref, clock, [row({ name: 's1', state: 'connected', toolCount: 1 })])
        )
    )
    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    expect(h.timers.armedDelays).toEqual([POLL_INTERVAL_MS])

    // Advance the clock past the stale threshold WITHOUT firing the timer.
    h.clock.advance(STALE_AFTER_MS + 1)
    expect(h.scheduler.snapshot().nextIntervalMs).toBe(FAST_POLL_INTERVAL_MS)
  })
})

describe('McpHealthScheduler — pause / resume / refresh', () => {
  it('pause cancels armed timers and blocks resume-triggered re-kicks until resume', async () => {
    const h = makeHarness()
    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    h.fetchStatus.mockClear()

    h.scheduler.pause()
    expect(h.timers.armedCount).toBe(0)

    // Adding a host while paused doesn't kick off a fetch.
    h.scheduler.setActiveHostRefs(['a', 'b'])
    await flushMicrotasks()
    expect(h.fetchStatus).not.toHaveBeenCalled()
  })

  it('resume kicks an immediate refresh for every active host', async () => {
    const h = makeHarness()
    h.scheduler.setActiveHostRefs(['a', 'b'])
    await flushMicrotasks()
    h.fetchStatus.mockClear()

    h.scheduler.pause()
    h.scheduler.resume()
    await flushMicrotasks()
    expect(h.fetchStatus).toHaveBeenCalledTimes(2)
  })

  it('refresh(hostRef) triggers a single out-of-band fetch', async () => {
    const h = makeHarness()
    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    h.fetchStatus.mockClear()

    await h.scheduler.refresh('a')
    expect(h.fetchStatus).toHaveBeenCalledTimes(1)
    expect(h.fetchStatus).toHaveBeenCalledWith('a')
  })

  it('refresh() with no arg refreshes every active host', async () => {
    const h = makeHarness()
    h.scheduler.setActiveHostRefs(['a', 'b'])
    await flushMicrotasks()
    h.fetchStatus.mockClear()

    await h.scheduler.refresh()
    expect(h.fetchStatus).toHaveBeenCalledTimes(2)
  })

  it('refresh while a fetch is already in-flight returns the same promise (no duplicate requests)', () => {
    const deferred: Array<() => void> = []
    const h = makeHarness(
      clock => () =>
        new Promise<HostRuntimeStatus>(resolve => {
          deferred.push(() => resolve(makeStatus('a', clock)))
        })
    )
    h.scheduler.setActiveHostRefs(['a'])
    expect(h.fetchStatus).toHaveBeenCalledTimes(1)

    const p1 = h.scheduler.refresh('a')
    const p2 = h.scheduler.refresh('a')
    expect(p1).toBe(p2)
    expect(h.fetchStatus).toHaveBeenCalledTimes(1)
    deferred.forEach(fn => fn())
  })

  it('refresh on an unknown hostRef is a no-op', async () => {
    const h = makeHarness()
    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    h.fetchStatus.mockClear()
    await h.scheduler.refresh('ghost')
    expect(h.fetchStatus).not.toHaveBeenCalled()
  })
})

describe('McpHealthScheduler — error handling', () => {
  it('captures fetch rejections in lastErrorByHostRef without breaking the loop', async () => {
    const err = new Error('boom')
    const h = makeHarness(() => async () => {
      throw err
    })
    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    const snap = h.scheduler.snapshot()
    expect(snap.lastErrorByHostRef.get('a')).toBe(err)
    // Timer still armed for the next attempt.
    expect(h.timers.armedCount).toBe(1)
  })

  it('clears lastError on the next successful fetch', async () => {
    let shouldFail = true
    const h = makeHarness(clock => async ref => {
      if (shouldFail) throw new Error('transient')
      return makeStatus(ref, clock)
    })
    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    expect(h.scheduler.snapshot().lastErrorByHostRef.has('a')).toBe(true)

    shouldFail = false
    await h.timers.fireNext()
    expect(h.scheduler.snapshot().lastErrorByHostRef.has('a')).toBe(false)
  })

  it('backs off polling on HTTP 429 and resets the backoff after the next success', async () => {
    let mode: 'rate-limit' | 'success' = 'rate-limit'
    const h = makeHarness(clock => async ref => {
      if (mode === 'rate-limit') {
        const err = new Error('429 Too Many Requests') as Error & { status: number }
        err.status = 429
        throw err
      }
      return makeStatus(ref, clock, [row({ name: 's1', state: 'connecting', toolCount: 0 })])
    })

    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    expect(h.timers.armedDelays).toEqual([FAST_POLL_INTERVAL_MS * 2])

    await h.timers.fireNext()
    expect(h.timers.armedDelays).toEqual([FAST_POLL_INTERVAL_MS * 4])

    mode = 'success'
    await h.timers.fireNext()
    expect(h.scheduler.snapshot().lastErrorByHostRef.has('a')).toBe(false)
    expect(h.timers.armedDelays).toEqual([FAST_POLL_INTERVAL_MS])
  })

  it('caps HTTP 429 backoff at the steady poll interval', async () => {
    const h = makeHarness(() => async () => {
      const err = new Error('429 Too Many Requests') as Error & { status: number }
      err.status = 429
      throw err
    })

    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    expect(h.timers.armedDelays).toEqual([FAST_POLL_INTERVAL_MS * 2])

    await h.timers.fireNext()
    expect(h.timers.armedDelays).toEqual([FAST_POLL_INTERVAL_MS * 4])

    await h.timers.fireNext()
    expect(h.timers.armedDelays).toEqual([FAST_POLL_INTERVAL_MS * 8])

    await h.timers.fireNext()
    expect(h.timers.armedDelays).toEqual([POLL_INTERVAL_MS])

    await h.timers.fireNext()
    expect(h.timers.armedDelays).toEqual([POLL_INTERVAL_MS])
  })
})

describe('McpHealthScheduler — subscribe', () => {
  it('calls the subscriber synchronously with the current snapshot on subscribe', () => {
    const h = makeHarness()
    const cb = vi.fn()
    h.scheduler.subscribe(cb)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0]).toMatchObject({ paused: false })
  })

  it('emits on every host state change', async () => {
    const h = makeHarness()
    const cb = vi.fn()
    h.scheduler.subscribe(cb)
    cb.mockClear()
    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    // Emissions: setActiveHostRefs notify + fetch resolved notify = ≥2
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('unsubscribe prevents further emissions', async () => {
    const h = makeHarness()
    const cb = vi.fn()
    const off = h.scheduler.subscribe(cb)
    off()
    cb.mockClear()
    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('McpHealthScheduler — timer firing', () => {
  it('fires the next fetch at the armed interval', async () => {
    const h = makeHarness()
    h.scheduler.setActiveHostRefs(['a'])
    await flushMicrotasks()
    h.fetchStatus.mockClear()
    expect(h.timers.armedDelays).toEqual([POLL_INTERVAL_MS])

    await h.timers.fireNext()
    expect(h.fetchStatus).toHaveBeenCalledTimes(1)
    // A new timer is armed after the fetch resolves.
    expect(h.timers.armedCount).toBe(1)
  })

  it('adds deterministic jitter when multiple hosts poll on the same cadence', async () => {
    const h = makeHarness()
    h.scheduler.setActiveHostRefs(['alpha', 'beta'])
    await flushMicrotasks()

    const delays = h.timers.armedDelays
    expect(delays).toHaveLength(2)
    expect(new Set(delays).size).toBe(2)
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(Math.round(POLL_INTERVAL_MS * 0.9))
      expect(delay).toBeLessThanOrEqual(Math.round(POLL_INTERVAL_MS * 1.1))
    }
  })
})

beforeEach(() => {
  vi.clearAllMocks()
})
