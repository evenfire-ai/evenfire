/**
 * Stage 3 (stateless-agents) — push heartbeat emitter + reversible DRAINING
 * fence unit tests. Fake timers + injected fetch: no real network, no real
 * clock. The route-level 503 fence is covered by
 * `src/__tests__/server.drainingFence.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CronScheduler } from '../../agent/cronScheduler'
import { parseStatelessHeartbeatIntervalMs } from '../../config'
import { CronManageTool } from '../../core/tools/cronManage'
import { MessageQueue } from '../../queue/messageQueue'
import {
  type HeartbeatConditions,
  type HeartbeatFetch,
  StatelessHeartbeat,
  type StatelessHeartbeatOptions,
} from '../statelessHeartbeat'

interface RecordedCall {
  url: string
  init: { method: string; headers: Record<string, string>; body: string }
}

type FakeResponse = { ok: boolean; status: number; json(): Promise<unknown> }

function jsonResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function makeHarness(overrides: Partial<StatelessHeartbeatOptions> = {}) {
  const conditions: HeartbeatConditions = {
    activeTask: false,
    awaitingApproval: false,
    pendingResults: false,
    activeCronSchedules: false,
  }
  const calls: RecordedCall[] = []
  let responder: () => Promise<FakeResponse> = async () => jsonResponse(200, { drain: false })
  const fetchImpl: HeartbeatFetch = async (url, init) => {
    calls.push({ url, init })
    return responder()
  }
  const flush = vi.fn(async () => {})
  const refreshOnUnauthorized = vi.fn(async () => {})
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const heartbeat = new StatelessHeartbeat({
    enabled: true,
    hostRef: 'chatllm',
    podUid: 'pod-uid-123',
    gatewayBaseUrl: 'http://workflow-approval-gateway:8092',
    intervalMs: 30_000,
    getAccessToken: () => 'runtime-token',
    refreshOnUnauthorized,
    getConditions: () => ({ ...conditions }),
    flushFinalCheckpoint: flush,
    fetchImpl,
    logger,
    ...overrides,
  })
  return {
    heartbeat,
    conditions,
    calls,
    flush,
    refreshOnUnauthorized,
    logger,
    setResponder(next: () => Promise<FakeResponse>): void {
      responder = next
    },
    payloadOf(index: number): Record<string, unknown> {
      return JSON.parse(calls[index].init.body) as Record<string, unknown>
    },
  }
}

describe('StatelessHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is a no-op when the stateless lifecycle flag is off: no timer, no fetch', async () => {
    // Deliberately garbage identity fields: with enabled=false the emitter
    // must neither validate nor emit.
    const h = makeHarness({ enabled: false, hostRef: '', podUid: '', intervalMs: -1 })
    h.heartbeat.start()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.calls).toHaveLength(0)
    expect(h.heartbeat.isIntakeFenced()).toBe(false)
  })

  it('fails loud at construction on missing identity or a bad interval when enabled', () => {
    expect(() => makeHarness({ hostRef: '  ' })).toThrow(/hostRef must be non-empty/)
    expect(() => makeHarness({ podUid: '' })).toThrow(/CLERUM_POD_UID/)
    expect(() => makeHarness({ gatewayBaseUrl: '' })).toThrow(/MCP_HOST_GATEWAY_URL/)
    expect(() => makeHarness({ intervalMs: 0 })).toThrow(/positive integer/)
    expect(() => makeHarness({ intervalMs: 1.5 })).toThrow(/positive integer/)
  })

  it('POSTs the schemaVersion-1 payload with auth header; each D8 condition toggles its field and activeWork', async () => {
    const h = makeHarness()
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.calls[0].url).toBe(
      'http://workflow-approval-gateway:8092/api/v1/mcp-host/hosts/heartbeat'
    )
    expect(h.calls[0].init.method).toBe('POST')
    expect(h.calls[0].init.headers.Authorization).toBe('Bearer runtime-token')
    expect(h.payloadOf(0)).toMatchObject({
      schemaVersion: 1,
      hostRef: 'chatllm',
      podUid: 'pod-uid-123',
      state: 'active',
      activeWork: false,
      conditions: {
        activeTask: false,
        awaitingApproval: false,
        pendingResults: false,
        activeCronSchedules: false,
      },
    })

    h.conditions.activeTask = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.payloadOf(1)).toMatchObject({
      activeWork: true,
      conditions: {
        activeTask: true,
        awaitingApproval: false,
        pendingResults: false,
        activeCronSchedules: false,
      },
    })

    h.conditions.activeTask = false
    h.conditions.awaitingApproval = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.payloadOf(2)).toMatchObject({
      activeWork: true,
      conditions: {
        activeTask: false,
        awaitingApproval: true,
        pendingResults: false,
        activeCronSchedules: false,
      },
    })

    h.conditions.awaitingApproval = false
    h.conditions.pendingResults = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.payloadOf(3)).toMatchObject({
      activeWork: true,
      conditions: {
        activeTask: false,
        awaitingApproval: false,
        pendingResults: true,
        activeCronSchedules: false,
      },
    })

    h.heartbeat.stop()
  })

  it('lastActivityTs advances when intake activity is recorded', async () => {
    const h = makeHarness()
    const t0 = Date.now()
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.payloadOf(0).lastActivityTs).toBe(t0)

    // Intake accepted at t0+30s — the next payload must carry the new mark.
    h.heartbeat.noteIntakeActivity()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.payloadOf(1).lastActivityTs).toBe(t0 + 30_000)

    h.heartbeat.stop()
  })

  it('accepted intake triggers an immediate heartbeat with fresh activity', async () => {
    const h = makeHarness()
    const t0 = Date.now()
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    h.heartbeat.noteIntakeActivity()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.calls).toHaveLength(2)
    expect(h.payloadOf(1).lastActivityTs).toBe(t0 + 31_000)

    h.heartbeat.stop()
  })

  it('drain:true fences intake; drained is reported only after the turn finishes AND the checkpoint flushes', async () => {
    const h = makeHarness()
    h.conditions.activeTask = true // in-flight turn keeps running through the fence
    h.setResponder(async () => jsonResponse(200, { drain: true }))
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.heartbeat.getState()).toBe('draining')
    expect(h.heartbeat.isIntakeFenced()).toBe(true)

    // Turn still in flight: no final flush, still reporting 'draining'.
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.flush).not.toHaveBeenCalled()
    expect(h.payloadOf(1).state).toBe('draining')

    // Turn finishes → exactly one final checkpoint → subsequent heartbeat
    // reports 'drained' and intake stays fenced.
    h.conditions.activeTask = false
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.flush).toHaveBeenCalledTimes(1)
    expect(h.payloadOf(2).state).toBe('drained')
    expect(h.heartbeat.isIntakeFenced()).toBe(true)

    // Flush runs once per drain episode, not once per tick.
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.flush).toHaveBeenCalledTimes(1)
    expect(h.payloadOf(3).state).toBe('drained')

    h.heartbeat.stop()
  })

  it('drain:false while draining cancels the drain: fence lifts immediately, no restart', async () => {
    const h = makeHarness()
    h.conditions.activeTask = true
    let drain = true
    h.setResponder(async () => jsonResponse(200, { drain }))
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.heartbeat.isIntakeFenced()).toBe(true)

    drain = false
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.heartbeat.getState()).toBe('active')
    expect(h.heartbeat.isIntakeFenced()).toBe(false)

    // Back at the NORMAL cadence after the cancel: nothing fires before the
    // full interval elapses.
    const callsAfterCancel = h.calls.length
    await vi.advanceTimersByTimeAsync(29_999)
    expect(h.calls).toHaveLength(callsAfterCancel)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.calls).toHaveLength(callsAfterCancel + 1)

    h.heartbeat.stop()
  })

  it('work starting DURING the final flush aborts the drained transition; drained lands once idle again', async () => {
    const h = makeHarness()
    h.setResponder(async () => jsonResponse(200, { drain: true }))
    // Internally-generated work (e.g. a cron dispatch or an approval
    // resolution) starts while the final checkpoint flush is awaited — the
    // pre-flush gate saw an idle host, so only the post-flush re-read can
    // catch it. Without it the emitter reports 'drained' with a turn
    // mid-flight and HCC suspends the pod, killing the run.
    h.flush.mockImplementationOnce(async () => {
      h.conditions.activeTask = true
    })
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000) // tick 1 → enters draining
    expect(h.heartbeat.getState()).toBe('draining')

    // Tick 2: flush runs, work starts mid-flush → NO drained report this tick.
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.flush).toHaveBeenCalledTimes(1)
    expect(h.heartbeat.getState()).toBe('draining')
    expect(h.payloadOf(1).state).toBe('draining')
    expect(h.payloadOf(1)).toMatchObject({ activeWork: true })
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("condition 'activeTask'"))

    // Tick 3: the turn is still running → the pre-flush gate holds (no flush).
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.flush).toHaveBeenCalledTimes(1)
    expect(h.payloadOf(2).state).toBe('draining')

    // Turn finishes → the next tick re-runs the flush and commits drained.
    h.conditions.activeTask = false
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.flush).toHaveBeenCalledTimes(2)
    expect(h.heartbeat.getState()).toBe('drained')
    expect(h.payloadOf(3).state).toBe('drained')

    h.heartbeat.stop()
  })

  it('awaitingApproval or pendingResults appearing during the flush also aborts the drained transition', async () => {
    for (const condition of ['awaitingApproval', 'pendingResults'] as const) {
      const h = makeHarness()
      h.setResponder(async () => jsonResponse(200, { drain: true }))
      h.flush.mockImplementationOnce(async () => {
        h.conditions[condition] = true
      })
      h.heartbeat.start()

      await vi.advanceTimersByTimeAsync(30_000) // → draining
      await vi.advanceTimersByTimeAsync(7_500) // flush + mid-flight condition
      expect(h.heartbeat.getState()).toBe('draining')
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`condition '${condition}'`)
      )

      h.heartbeat.stop()
    }
  })

  it('a drain-cancel resets the drained latch: the next drain runs a fresh final checkpoint', async () => {
    const h = makeHarness()
    let drain = true
    h.setResponder(async () => jsonResponse(200, { drain }))
    h.heartbeat.start()

    // Episode 1: idle host → draining, then drained with one flush.
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.heartbeat.getState()).toBe('drained')
    expect(h.flush).toHaveBeenCalledTimes(1)

    // Cancel from DRAINED: fence lifts too (reversible even after drained).
    drain = false
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.heartbeat.getState()).toBe('active')
    expect(h.heartbeat.isIntakeFenced()).toBe(false)

    // Episode 2: a later drain flushes AGAIN before reporting drained.
    drain = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.heartbeat.getState()).toBe('draining')
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.heartbeat.getState()).toBe('drained')
    expect(h.flush).toHaveBeenCalledTimes(2)

    h.heartbeat.stop()
  })

  it('accelerates to max(interval/4, 1s) while draining', async () => {
    const h = makeHarness()
    h.conditions.activeTask = true
    h.setResponder(async () => jsonResponse(200, { drain: true }))
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000) // tick 1 → enters draining
    expect(h.calls).toHaveLength(1)

    // Accelerated: 30_000 / 4 = 7_500. Nothing at 7_499, fires at 7_500.
    await vi.advanceTimersByTimeAsync(7_499)
    expect(h.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.calls).toHaveLength(3)

    h.heartbeat.stop()
  })

  it('clamps the accelerated cadence at the 1s floor', async () => {
    const h = makeHarness({ intervalMs: 2_000 })
    h.conditions.activeTask = true
    h.setResponder(async () => jsonResponse(200, { drain: true }))
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(2_000) // tick 1 → draining
    expect(h.calls).toHaveLength(1)
    // 2_000 / 4 = 500 → clamped to 1_000.
    await vi.advanceTimersByTimeAsync(999)
    expect(h.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.calls).toHaveLength(2)

    h.heartbeat.stop()
  })

  it('tolerates 404 from an older gateway: one warn, heartbeats continue at the normal cadence', async () => {
    const h = makeHarness()
    h.setResponder(async () => jsonResponse(404, { error: 'not found' }))
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(90_000)
    expect(h.calls).toHaveLength(3)
    expect(h.logger.warn).toHaveBeenCalledTimes(1)
    expect(h.logger.warn.mock.calls[0][0]).toContain('rollout skew')
    expect(h.logger.error).not.toHaveBeenCalled()
    expect(h.heartbeat.getState()).toBe('active')

    h.heartbeat.stop()
  })

  it('logs 5xx loudly with rate-limited repeats and never stops the interval', async () => {
    const h = makeHarness({ intervalMs: 10_000 })
    h.setResponder(async () => jsonResponse(500, {}))
    h.heartbeat.start()

    // 5 failing ticks inside the 60s suppression window → exactly one log.
    await vi.advanceTimersByTimeAsync(50_000)
    expect(h.calls).toHaveLength(5)
    expect(h.logger.error).toHaveBeenCalledTimes(1)

    // Past the suppression window the failure is re-logged.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.calls).toHaveLength(7)
    expect(h.logger.error).toHaveBeenCalledTimes(2)

    h.heartbeat.stop()
  })

  it('a rejecting fetch does not kill the interval', async () => {
    const h = makeHarness()
    h.setResponder(async () => {
      throw new Error('ECONNREFUSED')
    })
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(90_000)
    expect(h.calls).toHaveLength(3)
    expect(h.logger.error).toHaveBeenCalled()
    expect(h.heartbeat.getState()).toBe('active')

    h.heartbeat.stop()
  })

  it('a malformed response body (missing boolean drain) is an error, not a silent verdict', async () => {
    const h = makeHarness()
    h.setResponder(async () => jsonResponse(200, { drain: 'yes' }))
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.calls).toHaveLength(2)
    expect(h.logger.error).toHaveBeenCalled()
    expect(h.heartbeat.getState()).toBe('active')
    expect(h.heartbeat.isIntakeFenced()).toBe(false)

    h.heartbeat.stop()
  })

  it('a token source that throws is logged loudly and the emitter keeps ticking', async () => {
    const h = makeHarness({
      getAccessToken: () => {
        throw new Error('MCP_HOST_RUNTIME_ACCESS_TOKEN is required for the stateless heartbeat')
      },
    })
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(90_000)
    expect(h.calls).toHaveLength(0) // token is read before the POST goes out
    expect(h.logger.error).toHaveBeenCalled()
    expect(h.heartbeat.getState()).toBe('active')

    h.heartbeat.stop()
  })

  it('H2: a fenced intake sets pendingIntake=true on the next heartbeat; a drain-cancel clears it', async () => {
    const h = makeHarness()
    h.conditions.activeTask = true
    let drain = true
    h.setResponder(async () => jsonResponse(200, { drain }))
    h.heartbeat.start()

    // Enter draining. The first payload predates any fenced intake.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.heartbeat.isIntakeFenced()).toBe(true)
    expect(h.payloadOf(0).pendingIntake).toBe(false)

    // A new message hits the fence (the route calls noteFencedIntake on 503).
    h.heartbeat.noteFencedIntake()
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.payloadOf(1).pendingIntake).toBe(true)

    // Signal persists across ticks until HCC actually cancels the drain.
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.payloadOf(2).pendingIntake).toBe(true)

    // Drain-cancel lifts the fence AND clears the self-heal signal.
    drain = false
    await vi.advanceTimersByTimeAsync(7_500)
    expect(h.heartbeat.isIntakeFenced()).toBe(false)
    const afterCancel = h.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.payloadOf(afterCancel).pendingIntake).toBe(false)

    h.heartbeat.stop()
  })

  it('M3: a 401 triggers a single token refresh then a retry that succeeds — no throw, no error log', async () => {
    const h = makeHarness()
    let attempt = 0
    h.setResponder(async () => {
      attempt += 1
      // First POST of the tick 401s; the post-refresh retry succeeds.
      return attempt === 1 ? jsonResponse(401, {}) : jsonResponse(200, { drain: false })
    })
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000)
    // Two POSTs in the one tick: original + retry.
    expect(h.calls).toHaveLength(2)
    expect(h.refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect(h.logger.warn).toHaveBeenCalled()
    expect(h.logger.warn.mock.calls[0][0]).toContain('refreshing the runtime token')
    // A successful retry is NOT an error.
    expect(h.logger.error).not.toHaveBeenCalled()
    expect(h.heartbeat.getState()).toBe('active')

    h.heartbeat.stop()
  })

  it('M3: a persistent 401 (refresh then still 401) throws loud once per tick — refresh runs exactly once, no retry loop', async () => {
    const h = makeHarness({ intervalMs: 10_000 })
    // Every POST 401s, before and after the refresh.
    h.setResponder(async () => jsonResponse(401, {}))
    h.heartbeat.start()

    // One tick: original 401 → refresh once → retry 401 → throw (logged loud).
    await vi.advanceTimersByTimeAsync(10_000)
    // Exactly two POSTs (original + single retry), refresh exactly once — no loop.
    expect(h.calls).toHaveLength(2)
    expect(h.refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect(h.logger.error).toHaveBeenCalledTimes(1)
    expect(h.heartbeat.getState()).toBe('active')
    // The interval keeps running: the next tick fires and retries the pattern.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.calls).toHaveLength(4)
    expect(h.refreshOnUnauthorized).toHaveBeenCalledTimes(2)

    h.heartbeat.stop()
  })

  it('M3: without a refresh hook, a 401 throws loud immediately with no retry', async () => {
    const h = makeHarness({ intervalMs: 10_000, refreshOnUnauthorized: undefined })
    h.setResponder(async () => jsonResponse(401, {}))
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(10_000)
    // No retry: a single POST, straight to the loud throw.
    expect(h.calls).toHaveLength(1)
    expect(h.logger.error).toHaveBeenCalledTimes(1)
    expect(h.heartbeat.getState()).toBe('active')

    h.heartbeat.stop()
  })

  it('wake recovery: a fenced intake while draining triggers an immediate out-of-cycle beat', async () => {
    const h = makeHarness()
    h.conditions.activeTask = true
    h.setResponder(async () => jsonResponse(200, { drain: true }))
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000) // tick 1 -> draining, next armed at 7_500
    expect(h.calls).toHaveLength(1)

    // A message hits the fence 1s into the 7.5s accelerated wait: the armed
    // timer is rescheduled to fire NOW, not at the accelerated interval.
    await vi.advanceTimersByTimeAsync(1_000)
    h.heartbeat.noteFencedIntake()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls).toHaveLength(2)
    expect(h.payloadOf(1).pendingIntake).toBe(true)

    h.heartbeat.stop()
  })

  it('wake recovery: a burst of fenced intakes yields exactly ONE immediate beat (edge-triggered), then the 1s floor', async () => {
    const h = makeHarness()
    h.conditions.activeTask = true
    h.setResponder(async () => jsonResponse(200, { drain: true }))
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000) // tick 1 -> draining
    expect(h.calls).toHaveLength(1)

    // Burst of fenced 503s: only the first (false->true edge) reschedules.
    h.heartbeat.noteFencedIntake()
    h.heartbeat.noteFencedIntake()
    h.heartbeat.noteFencedIntake()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls).toHaveLength(2)

    // More fenced hits while already pending: no extra immediate beats.
    h.heartbeat.noteFencedIntake()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls).toHaveLength(2)

    // Next beat at the pendingIntake floor (1s), not interval/4 (7.5s).
    await vi.advanceTimersByTimeAsync(999)
    expect(h.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.calls).toHaveLength(3)

    h.heartbeat.stop()
  })

  it('wake recovery: while pendingIntake && draining the delay floors at 1s; drain-cancel restores the normal cadence', async () => {
    const h = makeHarness()
    h.conditions.activeTask = true
    let drain = true
    h.setResponder(async () => jsonResponse(200, { drain }))
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000) // tick 1 -> draining
    h.heartbeat.noteFencedIntake()
    await vi.advanceTimersByTimeAsync(0) // immediate beat (edge)
    expect(h.calls).toHaveLength(2)

    // Still draining + pendingIntake: successive beats every 1s, not 7.5s.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.calls).toHaveLength(4)

    // The wake lands: drain-cancel clears pendingIntake and lifts the fence.
    drain = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.calls).toHaveLength(5)
    expect(h.heartbeat.getState()).toBe('active')
    expect(h.heartbeat.isIntakeFenced()).toBe(false)

    // Back at the NORMAL cadence after the cancel.
    await vi.advanceTimersByTimeAsync(29_999)
    expect(h.calls).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.calls).toHaveLength(6)

    h.heartbeat.stop()
  })

  it('wake recovery: an immediate beat requested while a POST is in flight does not double-post', async () => {
    const h = makeHarness()
    h.conditions.activeTask = true
    h.setResponder(async () => jsonResponse(200, { drain: true }))
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000) // tick 1 -> draining, next at 7_500
    expect(h.calls).toHaveLength(1)

    // Make the NEXT POST hang until released.
    let release!: (value: FakeResponse) => void
    h.setResponder(
      () =>
        new Promise<FakeResponse>(resolve => {
          release = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(7_500) // tick 2 starts, POST in flight
    expect(h.calls).toHaveLength(2)

    // Fenced intake mid-flight: no armed timer exists (tick() nulls it on
    // entry) -> no reschedule, no second POST for this tick.
    h.heartbeat.noteFencedIntake()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls).toHaveLength(2)

    // The in-flight tick completes and re-arms at the 1s pendingIntake floor.
    h.setResponder(async () => jsonResponse(200, { drain: true }))
    release(jsonResponse(200, { drain: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(h.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.calls).toHaveLength(3)

    h.heartbeat.stop()
  })
})

describe('parseStatelessHeartbeatIntervalMs (config load validation)', () => {
  it('returns the 30s default when unset or empty', () => {
    expect(parseStatelessHeartbeatIntervalMs(undefined)).toBe(30_000)
    expect(parseStatelessHeartbeatIntervalMs('')).toBe(30_000)
    expect(parseStatelessHeartbeatIntervalMs('   ')).toBe(30_000)
  })

  it('parses an explicitly-set positive integer', () => {
    expect(parseStatelessHeartbeatIntervalMs('15000')).toBe(15_000)
    expect(parseStatelessHeartbeatIntervalMs('1')).toBe(1)
  })

  it('fails config load loudly on garbage values', () => {
    for (const bad of ['banana', '0', '-5', '1.5', '10s', 'NaN', 'Infinity']) {
      expect(() => parseStatelessHeartbeatIntervalMs(bad)).toThrow(/not a positive integer/)
    }
  })
})

// ─── Cron×stateless — activeCronSchedules condition ─────────────────────────

describe('StatelessHeartbeat — activeCronSchedules condition (cron×stateless)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('folds activeCronSchedules into activeWork exactly like the sibling conditions', async () => {
    const h = makeHarness()
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.payloadOf(0)).toMatchObject({
      activeWork: false,
      conditions: {
        activeTask: false,
        awaitingApproval: false,
        pendingResults: false,
        activeCronSchedules: false,
      },
    })

    h.conditions.activeCronSchedules = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.payloadOf(1)).toMatchObject({
      activeWork: true,
      conditions: {
        activeTask: false,
        awaitingApproval: false,
        pendingResults: false,
        activeCronSchedules: true,
      },
    })

    h.conditions.activeCronSchedules = false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.payloadOf(2)).toMatchObject({ activeWork: false })

    h.heartbeat.stop()
  })

  it('reports cron_manage-created schedules through the real CronScheduler supplier', async () => {
    const scheduler = new CronScheduler(new MessageQueue(), {
      statelessLifecycle: true,
      allowEnabledJobs: true,
    })
    const tool = new CronManageTool(scheduler, undefined, true, true)
    const h = makeHarness({
      getConditions: () => ({
        activeTask: false,
        awaitingApproval: false,
        pendingResults: false,
        activeCronSchedules: scheduler.hasEnabledJobs(),
      }),
    })

    try {
      h.heartbeat.start()

      await vi.advanceTimersByTimeAsync(30_000)
      expect(h.payloadOf(0)).toMatchObject({
        activeWork: false,
        conditions: { activeCronSchedules: false },
      })

      const created = await tool.execute({
        action: 'create',
        name: 'cron-heartbeat-integration',
        schedule: '0 3 1 1 *',
        task: 'reply tick',
      })
      expect(created.is_error).toBe(false)
      expect(scheduler.hasEnabledJobs()).toBe(true)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(h.payloadOf(1)).toMatchObject({
        activeWork: true,
        conditions: { activeCronSchedules: true },
      })
    } finally {
      h.heartbeat.stop()
      scheduler.stop()
    }
  })

  it('a schedule enabled DURING the final flush aborts the drained transition', async () => {
    const h = makeHarness()
    h.setResponder(async () => jsonResponse(200, { drain: true }))
    h.flush.mockImplementationOnce(async () => {
      h.conditions.activeCronSchedules = true
    })
    h.heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000) // → draining
    await vi.advanceTimersByTimeAsync(7_500) // flush + mid-flight schedule enable
    expect(h.heartbeat.getState()).toBe('draining')
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("condition 'activeCronSchedules'")
    )

    h.heartbeat.stop()
  })
})
