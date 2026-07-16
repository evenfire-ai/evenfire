import { Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HeartbeatPayload,
  StatelessLifecycleReconcilerPort,
  StatelessLifecycleTracker,
  parseHeartbeatPayload,
} from '../src/statelessLifecycleTracker'
import { HostCRD, HostCrdStatus } from '../src/types'

const NOW = Date.parse('2026-07-03T12:00:00.000Z')
const MIN = 60_000
const HOUR = 3_600_000

function makeHost(status?: HostCrdStatus): HostCRD {
  return {
    name: 'stateless-host',
    namespace: 'mcp-host',
    spec: {
      host: 'stateless-host',
      contextRef: 'context-a',
      secretRef: 'host-secret',
      lifecycle: { stateless: true },
    },
    status: status ?? { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
  }
}

type MockPort = {
  [K in keyof StatelessLifecycleReconcilerPort]: Mock
}

function makePort(): MockPort {
  return {
    getEffectiveLifecycle: vi.fn().mockReturnValue({ stateless: true, state: 'active' }),
    getWakeRequestedGeneration: vi.fn().mockReturnValue(0),
    // Fresh read defaults to echoing the caller's host -- cache and server
    // agree unless a test overrides it (cache-stale resolution suite).
    readFreshHost: vi.fn().mockImplementation(async (host: HostCRD) => host),
    suspendHostFromHeartbeat: vi.fn().mockResolvedValue(undefined),
    markHostActiveFromHeartbeat: vi.fn().mockResolvedValue(undefined),
    publishSuspendBlockedReason: vi.fn().mockResolvedValue(undefined),
    // Default: a young pod (1 minute old) — max-uptime never fires.
    findPodCreationTimestamp: vi.fn().mockResolvedValue(new Date(NOW - MIN)),
  }
}

function makeTracker(options: {
  port: MockPort
  host?: HostCRD | undefined
  idleMinutes?: number
  idleFloorMinutes?: number
  drainGraceMs?: number
  maxUptimeHours?: number
}): StatelessLifecycleTracker {
  return new StatelessLifecycleTracker({
    idleMinutes: options.idleMinutes ?? 30,
    idleFloorMinutes: options.idleFloorMinutes ?? 15,
    drainGraceMs: options.drainGraceMs ?? 60_000,
    maxUptimeHours: options.maxUptimeHours ?? 72,
    reconciler: options.port as unknown as StatelessLifecycleReconcilerPort,
    getHost: () => options.host ?? makeHost(),
    now: () => NOW,
  })
}

function payload(overrides: Partial<HeartbeatPayload> = {}): HeartbeatPayload {
  return {
    schemaVersion: 1,
    hostRef: 'stateless-host',
    podUid: 'pod-a',
    activeWork: false,
    conditions: {
      activeTask: false,
      awaitingApproval: false,
      pendingResults: false,
      activeCronSchedules: false,
    },
    lastActivityTs: NOW - 5 * MIN,
    state: 'active',
    ...overrides,
  }
}

describe('parseHeartbeatPayload — strict shape', () => {
  it('accepts the canonical emitter payload', () => {
    const result = parseHeartbeatPayload(payload())
    expect(result).toEqual({ ok: true, payload: payload() })
  })

  it('rejects a wrong schemaVersion', () => {
    const result = parseHeartbeatPayload({ ...payload(), schemaVersion: 2 })
    expect(result).toEqual({ ok: false, error: 'schemaVersion must be 1' })
  })

  it('rejects non-boolean fields', () => {
    expect(parseHeartbeatPayload({ ...payload(), activeWork: 'yes' }).ok).toBe(false)
    expect(
      parseHeartbeatPayload({
        ...payload(),
        conditions: { activeTask: 1, awaitingApproval: false, pendingResults: false },
      }).ok
    ).toBe(false)
  })

  it('rejects a non-finite lastActivityTs and unknown states', () => {
    expect(parseHeartbeatPayload({ ...payload(), lastActivityTs: Number.NaN }).ok).toBe(false)
    expect(parseHeartbeatPayload({ ...payload(), lastActivityTs: -1 }).ok).toBe(false)
    expect(parseHeartbeatPayload({ ...payload(), state: 'paused' }).ok).toBe(false)
  })

  it('rejects non-object bodies', () => {
    expect(parseHeartbeatPayload(null).ok).toBe(false)
    expect(parseHeartbeatPayload([]).ok).toBe(false)
    expect(parseHeartbeatPayload('{}').ok).toBe(false)
  })
})

describe('StatelessLifecycleTracker — D8 idle rule', () => {
  it('answers drain:false while activeWork=true regardless of lastActivityTs', async () => {
    const port = makePort()
    const tracker = makeTracker({ port })
    const verdict = await tracker.handleHeartbeat(
      payload({
        activeWork: true,
        conditions: {
          activeTask: true,
          awaitingApproval: false,
          pendingResults: false,
          activeCronSchedules: false,
        },
        lastActivityTs: NOW - 10 * HOUR,
      })
    )
    expect(verdict).toEqual({ drain: false })
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })

  it('answers drain:true once idle exceeds T_idle', async () => {
    const port = makePort()
    const tracker = makeTracker({ port })
    const verdict = await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))
    expect(verdict).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
    // Decision only — the tracker never scales; suspension waits for the
    // drained report (or grace expiry).
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })

  it('enforces the idle floor when idleMinutes is configured below it', async () => {
    const port = makePort()
    const tracker = makeTracker({ port, idleMinutes: 1, idleFloorMinutes: 15 })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 10 * MIN }))).toEqual({
      drain: false,
    })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 16 * MIN }))).toEqual({
      drain: true,
      entryWakeHandledGeneration: 0,
    })
  })

  it('answers drain:false while lastActivityTs is fresh', async () => {
    const port = makePort()
    const tracker = makeTracker({ port })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 1 * MIN }))).toEqual({
      drain: false,
    })
  })

  it('never drains a host whose assessed lifecycle is not stateless', async () => {
    const port = makePort()
    port.getEffectiveLifecycle.mockReturnValue({ stateless: false, state: 'active' })
    const tracker = makeTracker({ port })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 10 * HOUR }))).toEqual({
      drain: false,
    })
  })

  it('answers drain:false for an unknown host', async () => {
    const port = makePort()
    const tracker = new StatelessLifecycleTracker({
      idleMinutes: 30,
      idleFloorMinutes: 15,
      drainGraceMs: 60_000,
      maxUptimeHours: 72,
      reconciler: port as unknown as StatelessLifecycleReconcilerPort,
      getHost: () => undefined,
      now: () => NOW,
    })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 10 * HOUR }))).toEqual({
      drain: false,
    })
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })
})

describe('StatelessLifecycleTracker — pending wake wins', () => {
  it('answers drain:false when wakeRequested > wakeHandledGeneration even while idle', async () => {
    const port = makePort()
    port.getWakeRequestedGeneration.mockReturnValue(5)
    const tracker = makeTracker({
      port,
      host: makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 3 } }),
    })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 10 * HOUR }))).toEqual({
      drain: false,
    })
  })

  it('cancels a drained report when a wake is pending (no suspension)', async () => {
    const port = makePort()
    port.getWakeRequestedGeneration.mockReturnValue(2)
    const tracker = makeTracker({ port })
    const verdict = await tracker.handleHeartbeat(
      payload({ state: 'drained', lastActivityTs: NOW - 10 * HOUR })
    )
    expect(verdict).toEqual({ drain: false })
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })

  it('holds idle drain after a newly handled wake generation reaches the tracker', async () => {
    const port = makePort()
    const host = makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 1 } })
    const tracker = makeTracker({ port, host })

    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 10 * HOUR }))).toEqual({
      drain: true,
      entryWakeHandledGeneration: 1,
    })

    host.status = { lifecycle: { state: 'active', wakeHandledGeneration: 2 } }
    expect(
      await tracker.handleHeartbeat(payload({ podUid: 'pod-b', lastActivityTs: NOW - 10 * HOUR }))
    ).toEqual({ drain: false })
    expect(
      await tracker.handleHeartbeat(
        payload({ podUid: 'pod-b', state: 'drained', lastActivityTs: NOW - 10 * HOUR })
      )
    ).toEqual({ drain: false })
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })
})

describe('StatelessLifecycleTracker — cache-stale wakePending resolution', () => {
  it('proceeds with the drain when the fresh read shows the wake generation handled', async () => {
    const port = makePort()
    port.getWakeRequestedGeneration.mockReturnValue(5)
    port.readFreshHost.mockResolvedValue(
      makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 5 } })
    )
    const tracker = makeTracker({
      port,
      host: makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 3 } }),
    })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 10 * HOUR }))).toEqual({
      drain: true,
      entryWakeHandledGeneration: 3,
    })
    expect(port.readFreshHost).toHaveBeenCalledTimes(1)
  })

  it('keeps drain:false when the fresh read still shows the wake pending', async () => {
    const port = makePort()
    port.getWakeRequestedGeneration.mockReturnValue(5)
    port.readFreshHost.mockResolvedValue(
      makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 3 } })
    )
    const tracker = makeTracker({
      port,
      host: makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 3 } }),
    })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 10 * HOUR }))).toEqual({
      drain: false,
    })
    expect(port.readFreshHost).toHaveBeenCalledTimes(1)
  })

  it('keeps the conservative drain:false when the fresh read fails (retried next beat)', async () => {
    const port = makePort()
    port.getWakeRequestedGeneration.mockReturnValue(5)
    port.readFreshHost.mockRejectedValue(new Error('apiserver unavailable'))
    const tracker = makeTracker({
      port,
      host: makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 3 } }),
    })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 10 * HOUR }))).toEqual({
      drain: false,
    })
  })

  it('does not fresh-read at all when the cached view has no pending wake', async () => {
    const port = makePort()
    port.getWakeRequestedGeneration.mockReturnValue(2)
    const tracker = makeTracker({
      port,
      host: makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 2 } }),
    })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 10 * HOUR }))).toEqual({
      drain: true,
      entryWakeHandledGeneration: 2,
    })
    expect(port.readFreshHost).not.toHaveBeenCalled()
  })
})

describe('StatelessLifecycleTracker — tracker-side cancel-drain', () => {
  it('reverts a draining Host to active on activity evidence (drain:false)', async () => {
    const port = makePort()
    const host = makeHost({ lifecycle: { state: 'draining', wakeHandledGeneration: 0 } })
    const tracker = makeTracker({ port, host })
    const verdict = await tracker.handleHeartbeat(
      payload({
        activeWork: true,
        conditions: {
          activeTask: true,
          awaitingApproval: false,
          pendingResults: false,
          activeCronSchedules: false,
        },
        lastActivityTs: NOW - 1000,
      })
    )
    expect(verdict).toEqual({ drain: false })
    expect(port.markHostActiveFromHeartbeat).toHaveBeenCalledTimes(1)
    expect(port.markHostActiveFromHeartbeat).toHaveBeenCalledWith(host)
  })

  it('does not revert when the Host is already active', async () => {
    const port = makePort()
    const host = makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 0 } })
    const tracker = makeTracker({ port, host })
    const verdict = await tracker.handleHeartbeat(
      payload({
        activeWork: true,
        conditions: {
          activeTask: true,
          awaitingApproval: false,
          pendingResults: false,
          activeCronSchedules: false,
        },
        lastActivityTs: NOW - 1000,
      })
    )
    expect(verdict).toEqual({ drain: false })
    expect(port.markHostActiveFromHeartbeat).not.toHaveBeenCalled()
  })

  it('never revives a suspended Host (that is the wake fast-path job)', async () => {
    const port = makePort()
    const host = makeHost({
      lifecycle: { state: 'suspended', wakeHandledGeneration: 1, reason: 'idle' },
    })
    const tracker = makeTracker({ port, host })
    const verdict = await tracker.handleHeartbeat(
      payload({
        activeWork: true,
        conditions: {
          activeTask: true,
          awaitingApproval: false,
          pendingResults: false,
          activeCronSchedules: false,
        },
        lastActivityTs: NOW - 1000,
      })
    )
    expect(verdict).toEqual({ drain: false })
    expect(port.markHostActiveFromHeartbeat).not.toHaveBeenCalled()
  })

  it('reverts a draining Host when a wake is pending even before the fast-path lands', async () => {
    const port = makePort()
    port.getWakeRequestedGeneration.mockReturnValue(1)
    const host = makeHost({ lifecycle: { state: 'draining', wakeHandledGeneration: 0 } })
    const tracker = makeTracker({ port, host })
    // Idle payload → the standalone wakePending branch decides drain:false.
    const verdict = await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))
    expect(verdict).toEqual({ drain: false })
    expect(port.markHostActiveFromHeartbeat).toHaveBeenCalledTimes(1)
    expect(port.markHostActiveFromHeartbeat).toHaveBeenCalledWith(host)
  })

  it('keeps drain:false, logs loudly, and never throws when the revert write fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const port = makePort()
      port.markHostActiveFromHeartbeat.mockRejectedValue(new Error('api down'))
      const host = makeHost({ lifecycle: { state: 'draining', wakeHandledGeneration: 0 } })
      const tracker = makeTracker({ port, host })
      const verdict = await tracker.handleHeartbeat(
        payload({
          activeWork: true,
          conditions: {
            activeTask: true,
            awaitingApproval: false,
            pendingResults: false,
            activeCronSchedules: false,
          },
          lastActivityTs: NOW - 1000,
        })
      )
      expect(verdict).toEqual({ drain: false })
      expect(
        errorSpy.mock.calls.filter(args => String(args[0]).includes('Cancel-drain revert failed'))
      ).toHaveLength(1)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('StatelessLifecycleTracker — podUid ordering', () => {
  it('discards heartbeats from a retired pod and logs the discard once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const port = makePort()
      const tracker = makeTracker({ port })
      // pod-a is current and idle → drain:true
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-a', lastActivityTs: NOW - 31 * MIN }))
      ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
      // pod-b (never seen) is a newer pod after a wake → accepted
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-b', lastActivityTs: NOW - 1 * MIN }))
      ).toEqual({ drain: false })
      // pod-a is now retired: its (idle) heartbeat is discarded → drain:false
      const stale = await tracker.handleHeartbeat(
        payload({ podUid: 'pod-a', lastActivityTs: NOW - 31 * MIN })
      )
      expect(stale).toEqual({ drain: false })
      const staleLogs = warnSpy.mock.calls.filter(args =>
        String(args[0]).includes('stale pod "pod-a"')
      )
      expect(staleLogs).toHaveLength(1)
      // Repeated stale heartbeats stay discarded but are not re-logged.
      await tracker.handleHeartbeat(payload({ podUid: 'pod-a', lastActivityTs: NOW - 31 * MIN }))
      expect(
        warnSpy.mock.calls.filter(args => String(args[0]).includes('stale pod "pod-a"'))
      ).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('StatelessLifecycleTracker — drained report and drain grace', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("suspends through the reconciler on a 'drained' report (reason 'idle')", async () => {
    const port = makePort()
    const host = makeHost()
    const tracker = makeTracker({ port, host })
    const verdict = await tracker.handleHeartbeat(
      payload({ state: 'drained', lastActivityTs: NOW - 31 * MIN })
    )
    expect(verdict).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledTimes(1)
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledWith(host, 'idle', 0)
    // Stale lastActivityTs → no fresh-activity supersede, no revert.
    expect(port.markHostActiveFromHeartbeat).not.toHaveBeenCalled()
  })

  it("passes the entry snapshot's handled generation as the AP-1 suspend epoch", async () => {
    const port = makePort()
    port.getWakeRequestedGeneration.mockReturnValue(4)
    const host = makeHost({ lifecycle: { state: 'draining', wakeHandledGeneration: 4 } })
    const tracker = makeTracker({ port, host })
    const verdict = await tracker.handleHeartbeat(
      payload({ state: 'drained', lastActivityTs: NOW - 31 * MIN })
    )
    expect(verdict).toEqual({ drain: true, entryWakeHandledGeneration: 4 })
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledTimes(1)
    // The epoch is the generation the DECISION saw (4), never a hardcoded 0 —
    // the executor's commit guard compares fresh against exactly this value.
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledWith(host, 'idle', 4)
  })

  it('suspends when the drain grace expires after an acked drain without a drained report', async () => {
    const port = makePort()
    const host = makeHost()
    const tracker = makeTracker({ port, host, drainGraceMs: 60_000 })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))).toEqual({
      drain: true,
      entryWakeHandledGeneration: 0,
    })
    // The emitter ACKS the drain on its next beat (state 'draining') but the
    // 'drained' report never lands → the grace expiry force-suspends.
    expect(
      await tracker.handleHeartbeat(payload({ state: 'draining', lastActivityTs: NOW - 31 * MIN }))
    ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledTimes(1)
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledWith(host, 'idle', 0)
  })

  it('cancels the drain grace when activity resumes', async () => {
    const port = makePort()
    const tracker = makeTracker({ port, drainGraceMs: 60_000 })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))).toEqual({
      drain: true,
      entryWakeHandledGeneration: 0,
    })
    // Activity resumed before the grace expired → verdict flips, grace disarmed.
    expect(
      await tracker.handleHeartbeat(
        payload({
          activeWork: true,
          conditions: {
            activeTask: true,
            awaitingApproval: false,
            pendingResults: false,
            activeCronSchedules: false,
          },
          lastActivityTs: NOW - 1000,
        })
      )
    ).toEqual({ drain: false })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })

  it('skips the grace-expiry suspension when a wake arrived meanwhile', async () => {
    const port = makePort()
    const tracker = makeTracker({ port, drainGraceMs: 60_000 })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))).toEqual({
      drain: true,
      entryWakeHandledGeneration: 0,
    })
    port.getWakeRequestedGeneration.mockReturnValue(9)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })
})

describe('StatelessLifecycleTracker — grace-expiry wakePending fresh-read guard (KZ-R1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Drive the tracker to a force-suspend grace expiry: a drain verdict arms the
  // grace, then an acked 'draining' beat (with no 'drained' report) makes the
  // expiry force-suspend UNLESS a wake is pending. Each case controls the cached
  // vs fresh wake generation to exercise the new guard.
  async function armForceSuspendGrace(tracker: StatelessLifecycleTracker): Promise<void> {
    // Hosts differ per test (wakeHandledGeneration 0 vs 5), so the shared
    // helper matches the drain flag only; the verdict-epoch value is pinned
    // by the dedicated epoch tests.
    expect(
      await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))
    ).toMatchObject({ drain: true })
    expect(
      await tracker.handleHeartbeat(payload({ state: 'draining', lastActivityTs: NOW - 31 * MIN }))
    ).toMatchObject({ drain: true })
  }

  it('does NOT suspend when the cache says not-pending but a FRESH read shows a wake pending', async () => {
    const port = makePort()
    // Cached host: handled==requested (5) → cache reads NOT pending.
    const host = makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 5 } })
    port.getWakeRequestedGeneration.mockReturnValue(5)
    // Fresh read: handled=3 < requested 5 → the wake is actually still pending.
    port.readFreshHost.mockResolvedValue(
      makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 3 } })
    )
    const tracker = makeTracker({ port, host, drainGraceMs: 60_000 })
    await armForceSuspendGrace(tracker)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(port.readFreshHost).toHaveBeenCalled()
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })

  it('does NOT suspend when the cache ALREADY shows a wake pending (short-circuits the fresh read)', async () => {
    const port = makePort()
    // Arm the grace with a NON-pending host (default gen 0 == requested 0), then
    // make the wake pending in-cache only at expiry — mirrors the existing
    // "wake arrived meanwhile" test so handleHeartbeat still answers drain:true.
    const tracker = makeTracker({ port, drainGraceMs: 60_000 })
    await armForceSuspendGrace(tracker)
    // Cache now reports a wake pending (requested 9 > handled 0).
    port.getWakeRequestedGeneration.mockReturnValue(9)
    port.readFreshHost.mockClear()

    await vi.advanceTimersByTimeAsync(60_000)
    // Cache pending is trusted directly — no fresh read is issued for the gate.
    expect(port.readFreshHost).not.toHaveBeenCalled()
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })

  it('suspends when the cache AND the fresh read agree the wake is handled (not pending)', async () => {
    const port = makePort()
    // Cached host: handled==requested (5) → not pending.
    const host = makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 5 } })
    port.getWakeRequestedGeneration.mockReturnValue(5)
    // Fresh read agrees: handled=5 → still not pending → suspend proceeds.
    port.readFreshHost.mockResolvedValue(
      makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 5 } })
    )
    const tracker = makeTracker({ port, host, drainGraceMs: 60_000 })
    await armForceSuspendGrace(tracker)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(port.readFreshHost).toHaveBeenCalled()
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledTimes(1)
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledWith(host, 'idle', 5)
  })

  it('fail-conservative: a fresh-read error at grace expiry skips the suspend for this cycle', async () => {
    const port = makePort()
    // Cache not pending, but the confirming fresh read throws → never suspend
    // over a possibly-pending wake.
    const host = makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 5 } })
    port.getWakeRequestedGeneration.mockReturnValue(5)
    port.readFreshHost.mockRejectedValue(new Error('apiserver unavailable'))
    const tracker = makeTracker({ port, host, drainGraceMs: 60_000 })
    await armForceSuspendGrace(tracker)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(port.readFreshHost).toHaveBeenCalled()
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })
})

describe('StatelessLifecycleTracker — drained report superseded by fresh activity', () => {
  it('cancels the drain instead of suspending when lastActivityTs is fresher than T_idle', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const port = makePort()
      const host = makeHost({ lifecycle: { state: 'draining', wakeHandledGeneration: 0 } })
      const tracker = makeTracker({ port, host })
      // A turn was accepted and served ~5s before the emitter's final flush
      // reported 'drained' — the drain decision is stale.
      const verdict = await tracker.handleHeartbeat(
        payload({
          state: 'drained',
          lastActivityTs: NOW - 5000,
          activeWork: true,
          conditions: {
            activeTask: true,
            awaitingApproval: false,
            pendingResults: false,
            activeCronSchedules: false,
          },
        })
      )
      expect(verdict).toEqual({ drain: false })
      expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
      // The CR (still 'draining') reverts to active through the seam so the
      // emitter un-fences on its next answered beat.
      expect(port.markHostActiveFromHeartbeat).toHaveBeenCalledTimes(1)
      expect(port.markHostActiveFromHeartbeat).toHaveBeenCalledWith(host)
      expect(port.publishSuspendBlockedReason).toHaveBeenCalledWith(
        host,
        'SuspendBlocked: activeTask'
      )
      const supersededLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('phase=drained_report_superseded'))
      expect(supersededLines).toEqual([
        `[StatelessSuspend] host=stateless-host phase=drained_report_superseded reason=fresh_activity ts=${NOW}`,
      ])
      tracker.stop()
    } finally {
      logSpy.mockRestore()
    }
  })

  it('suspends anyway when fresh activity coincides with an exceeded max-uptime ceiling', async () => {
    const port = makePort()
    port.findPodCreationTimestamp.mockResolvedValue(new Date(NOW - 73 * HOUR))
    const host = makeHost({ lifecycle: { state: 'draining', wakeHandledGeneration: 0 } })
    const tracker = makeTracker({ port, host, maxUptimeHours: 72 })
    const verdict = await tracker.handleHeartbeat(
      payload({ state: 'drained', lastActivityTs: NOW - 5000 })
    )
    // An uptime-exceeded drain is not superseded by activity: suspend.
    expect(verdict).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledTimes(1)
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledWith(host, 'idle', 0)
    expect(port.markHostActiveFromHeartbeat).not.toHaveBeenCalled()
  })

  it('answers drain:false without a revert when the CR is already active', async () => {
    const port = makePort()
    const host = makeHost({ lifecycle: { state: 'active', wakeHandledGeneration: 0 } })
    const tracker = makeTracker({ port, host })
    const verdict = await tracker.handleHeartbeat(
      payload({ state: 'drained', lastActivityTs: NOW - 5000 })
    )
    expect(verdict).toEqual({ drain: false })
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
    // cancelDrainOnEvidence no-ops on a non-draining CR — no revert needed.
    expect(port.markHostActiveFromHeartbeat).not.toHaveBeenCalled()
    expect(port.publishSuspendBlockedReason).toHaveBeenCalledWith(
      host,
      'SuspendBlocked: recentActivity'
    )
  })
})

describe('StatelessLifecycleTracker — suspend-blocked reason', () => {
  it('publishes the blocking D8 condition, priority-ordered', async () => {
    const port = makePort()
    const host = makeHost()
    const tracker = makeTracker({ port, host })
    await tracker.handleHeartbeat(
      payload({
        activeWork: true,
        conditions: {
          activeTask: true,
          awaitingApproval: true,
          pendingResults: false,
          activeCronSchedules: false,
        },
      })
    )
    expect(port.publishSuspendBlockedReason).toHaveBeenLastCalledWith(
      host,
      'SuspendBlocked: awaitingApproval'
    )
    await tracker.handleHeartbeat(
      payload({
        activeWork: true,
        conditions: {
          activeTask: false,
          awaitingApproval: false,
          pendingResults: true,
          activeCronSchedules: false,
        },
      })
    )
    expect(port.publishSuspendBlockedReason).toHaveBeenLastCalledWith(
      host,
      'SuspendBlocked: pendingResults'
    )
    await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 1 * MIN }))
    expect(port.publishSuspendBlockedReason).toHaveBeenLastCalledWith(
      host,
      'SuspendBlocked: recentActivity'
    )
  })

  it('publishes awaitingApproval as the blocking D8 condition (MEDIUM-5)', async () => {
    // The hardest refusal to induce live: a heartbeat whose ONLY active-work
    // signal is conditions.awaitingApproval. With activeTask false it must be
    // the winning (priority-ordered) block reason, so the tracker publishes
    // 'SuspendBlocked: awaitingApproval' instead of suspending.
    const port = makePort()
    const host = makeHost()
    const tracker = makeTracker({ port, host })
    await tracker.handleHeartbeat(
      payload({
        activeWork: true,
        conditions: {
          activeTask: false,
          awaitingApproval: true,
          pendingResults: false,
          activeCronSchedules: false,
        },
      })
    )
    expect(port.publishSuspendBlockedReason).toHaveBeenLastCalledWith(
      host,
      'SuspendBlocked: awaitingApproval'
    )
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })

  it('does not publish a reason when the verdict is drain:true', async () => {
    const port = makePort()
    const tracker = makeTracker({ port })
    await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))
    expect(port.publishSuspendBlockedReason).not.toHaveBeenCalled()
  })
})

describe('StatelessLifecycleTracker — max-uptime ceiling', () => {
  it('forces drain:true past the ceiling regardless of activity (decision only)', async () => {
    const port = makePort()
    port.findPodCreationTimestamp.mockResolvedValue(new Date(NOW - 73 * HOUR))
    const tracker = makeTracker({ port, maxUptimeHours: 72 })
    const verdict = await tracker.handleHeartbeat(
      payload({
        activeWork: true,
        conditions: {
          activeTask: true,
          awaitingApproval: false,
          pendingResults: false,
          activeCronSchedules: false,
        },
        lastActivityTs: NOW - 1000,
      })
    )
    expect(verdict).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
    // The ceiling only changes the VERDICT — no direct scale/suspend call.
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })

  it('caches the pod creationTimestamp per podUid (one lookup)', async () => {
    const port = makePort()
    const tracker = makeTracker({ port })
    await tracker.handleHeartbeat(payload())
    await tracker.handleHeartbeat(payload())
    expect(port.findPodCreationTimestamp).toHaveBeenCalledTimes(1)
  })

  it('leaves the ceiling unapplied (drain:false) when the pod age lookup fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const port = makePort()
      port.findPodCreationTimestamp.mockRejectedValue(new Error('api blip'))
      const tracker = makeTracker({ port })
      expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 1 * MIN }))).toEqual({
        drain: false,
      })
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('StatelessLifecycleTracker — HCC restart amnesia', () => {
  it('a FRESH tracker answers drain:true from the payload alone when idle', async () => {
    const port = makePort()
    const tracker = makeTracker({ port })
    // First heartbeat this tracker instance has ever seen — the decision
    // derives from payload.lastActivityTs, not from HCC-side memory.
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 2 * HOUR }))).toEqual({
      drain: true,
      entryWakeHandledGeneration: 0,
    })
  })

  it('a FRESH tracker never suspends immediately after restart on recent activity', async () => {
    const port = makePort()
    const tracker = makeTracker({ port })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 2 * MIN }))).toEqual({
      drain: false,
    })
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })
})

describe('StatelessLifecycleTracker — construction (fail-loud)', () => {
  it('rejects non-positive configuration', () => {
    const port = makePort()
    const base = {
      idleMinutes: 30,
      idleFloorMinutes: 15,
      drainGraceMs: 60_000,
      maxUptimeHours: 72,
      reconciler: port as unknown as StatelessLifecycleReconcilerPort,
      getHost: () => undefined,
    }
    expect(() => new StatelessLifecycleTracker({ ...base, idleMinutes: 0 })).toThrow(/idleMinutes/)
    expect(() => new StatelessLifecycleTracker({ ...base, idleFloorMinutes: -1 })).toThrow(
      /idleFloorMinutes/
    )
    expect(() => new StatelessLifecycleTracker({ ...base, drainGraceMs: 0 })).toThrow(
      /drainGraceMs/
    )
    expect(() => new StatelessLifecycleTracker({ ...base, maxUptimeHours: Number.NaN })).toThrow(
      /maxUptimeHours/
    )
  })
})

describe('StatelessLifecycleTracker — structured suspend-phase timestamps (Stage 6, W2)', () => {
  it('emits drain_answered when the idle gate first answers drain:true', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const port = makePort()
      const tracker = makeTracker({ port })
      const verdict = await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))
      expect(verdict).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
      const suspendLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.startsWith('[StatelessSuspend]'))
      expect(suspendLines).toEqual([
        `[StatelessSuspend] host=stateless-host phase=drain_answered ts=${NOW}`,
      ])
      tracker.stop()
    } finally {
      logSpy.mockRestore()
    }
  })

  it('emits drained_reported when the pod reports state=drained', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const port = makePort()
      const tracker = makeTracker({ port })
      const verdict = await tracker.handleHeartbeat(
        payload({ state: 'drained', lastActivityTs: NOW - 31 * MIN })
      )
      expect(verdict).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
      expect(port.suspendHostFromHeartbeat).toHaveBeenCalledTimes(1)
      const suspendLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.startsWith('[StatelessSuspend]'))
      expect(suspendLines).toEqual([
        `[StatelessSuspend] host=stateless-host phase=drained_reported ts=${NOW}`,
      ])
      tracker.stop()
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe('StatelessLifecycleTracker — ack-aware drain-grace expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Mutable clock: `this.now()` advances in lockstep with the fake timers so
   * armedAtMs / lastBeat.atMs comparisons reflect real elapsed time across
   * grace windows (the shared makeTracker pins now() to a constant).
   */
  function makeClockTracker(options: { port: MockPort; host: HostCRD; drainGraceMs?: number }): {
    tracker: StatelessLifecycleTracker
    tick: (ms: number) => Promise<void>
  } {
    const clock = { ms: NOW }
    const tracker = new StatelessLifecycleTracker({
      idleMinutes: 30,
      idleFloorMinutes: 15,
      drainGraceMs: options.drainGraceMs ?? 60_000,
      maxUptimeHours: 72,
      reconciler: options.port as unknown as StatelessLifecycleReconcilerPort,
      getHost: () => options.host,
      now: () => clock.ms,
    })
    const tick = async (ms: number): Promise<void> => {
      clock.ms += ms
      await vi.advanceTimersByTimeAsync(ms)
    }
    return { tracker, tick }
  }

  it('re-arms instead of suspending when the emitter never acked the drain (last beat active)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const port = makePort()
      const host = makeHost()
      const { tracker, tick } = makeClockTracker({ port, host })
      expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))).toEqual({
        drain: true,
        entryWakeHandledGeneration: 0,
      })
      // Grace expires while the last beat (same pod, at arming) still says
      // state:'active' — the emitter provably never heard the verdict.
      await tick(60_000)
      expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
      const rearmLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('phase=grace_rearmed'))
      expect(rearmLines).toEqual([
        `[StatelessSuspend] host=stateless-host phase=grace_rearmed reason=drain_not_acked ts=${NOW + 60_000}`,
      ])
      // The emitter acks on its next beat (state 'draining') but never
      // reports drained → the re-armed grace expiry now force-suspends.
      expect(
        await tracker.handleHeartbeat(
          payload({ state: 'draining', lastActivityTs: NOW - 31 * MIN })
        )
      ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
      await tick(60_000)
      expect(port.suspendHostFromHeartbeat).toHaveBeenCalledTimes(1)
      expect(port.suspendHostFromHeartbeat).toHaveBeenCalledWith(host, 'idle', 0)
      tracker.stop()
    } finally {
      logSpy.mockRestore()
    }
  })

  it('suspends when the emitter goes silent (no beat since the re-armed window)', async () => {
    const port = makePort()
    const host = makeHost()
    const { tracker, tick } = makeClockTracker({ port, host })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))).toEqual({
      drain: true,
      entryWakeHandledGeneration: 0,
    })
    // First expiry: the arming beat itself (state 'active', atMs equals
    // armedAtMs) counts as "beats flowed since arming" → one re-arm. This is
    // load-bearing: with a grace shorter than the beat interval the first
    // window only ever contains the arming beat.
    await tick(60_000)
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
    // Second expiry: NO beat since the re-arm — dead/wedged emitter, nothing
    // live to kill. The FEED kept flowing (a successful poll after the
    // re-arm, recent at expiry), so the silence is attributable to the
    // EMITTER → suspend (dead-emitter path preserved).
    await tick(30_000)
    tracker.noteSuccessfulPoll(30_000)
    await tick(30_000)
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledTimes(1)
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledWith(host, 'idle', 0)
  })

  it("a retired pod's beat does not count as the current pod's ack/liveness", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const port = makePort()
      const host = makeHost()
      const { tracker, tick } = makeClockTracker({ port, host })
      // pod-a beats (recent activity), then pod-b replaces it → pod-a retired.
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-a', lastActivityTs: NOW - 1 * MIN }))
      ).toEqual({ drain: false })
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-b', lastActivityTs: NOW - 31 * MIN }))
      ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
      // First expiry re-arms off pod-b's own (active) arming beat.
      await tick(60_000)
      expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
      // A STALE pod-a beat (state 'active') arrives inside the re-armed
      // window: discarded — it must NOT register as pod-b's ack/liveness.
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-a', lastActivityTs: NOW - 1 * MIN }))
      ).toEqual({ drain: false })
      // Had the stale beat counted, this expiry would re-arm again; instead
      // pod-b has been silent since the re-arm while the FEED kept flowing
      // (successful poll after the re-arm) → suspend.
      await tick(30_000)
      tracker.noteSuccessfulPoll(30_000)
      await tick(30_000)
      expect(port.suspendHostFromHeartbeat).toHaveBeenCalledTimes(1)
      expect(port.suspendHostFromHeartbeat).toHaveBeenCalledWith(host, 'idle', 0)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('re-arm followed by an activity beat cancels the drain — no suspend ever', async () => {
    const port = makePort()
    const host = makeHost({ lifecycle: { state: 'draining', wakeHandledGeneration: 0 } })
    const { tracker, tick } = makeClockTracker({ port, host })
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))).toEqual({
      drain: true,
      entryWakeHandledGeneration: 0,
    })
    // Grace expires unacked → re-arm, no suspend.
    await tick(60_000)
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
    // The next beat carries activity → drain cancelled via the existing
    // paths: grace cleared + CR reverted to active through the seam.
    expect(
      await tracker.handleHeartbeat(
        payload({
          activeWork: true,
          conditions: {
            activeTask: true,
            awaitingApproval: false,
            pendingResults: false,
            activeCronSchedules: false,
          },
          lastActivityTs: NOW + 60_000 - 1000,
        })
      )
    ).toEqual({ drain: false })
    expect(port.markHostActiveFromHeartbeat).toHaveBeenCalledTimes(1)
    await tick(300_000)
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })

  it('FIX 4: a feed outage across the grace re-arms (reason=feed_outage) instead of suspending; the recovered feed suspends', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const port = makePort()
      const host = makeHost()
      const { tracker, tick } = makeClockTracker({ port, host })
      expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))).toEqual({
        drain: true,
        entryWakeHandledGeneration: 0,
      })
      // First expiry: arming beat counts as flowing → re-arm (drain_not_acked).
      await tick(60_000)
      expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
      // Second expiry: NO beat since the re-arm, and NO successful poll was
      // ever reported — the silence is unattributable (the feed may be out,
      // the emitter may be alive and beating into the void) → re-arm, never
      // force-suspend on feed silence.
      await tick(60_000)
      expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
      const feedOutageLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('reason=feed_outage'))
      expect(feedOutageLines).toEqual([
        `[StatelessSuspend] host=stateless-host phase=grace_rearmed reason=feed_outage ts=${NOW + 120_000}`,
      ])
      // Feed recovers: a successful poll after the latest re-arm, recent at
      // the next expiry — the emitter is still silent → NOW it suspends.
      await tick(30_000)
      tracker.noteSuccessfulPoll(30_000)
      await tick(30_000)
      expect(port.suspendHostFromHeartbeat).toHaveBeenCalledTimes(1)
      expect(port.suspendHostFromHeartbeat).toHaveBeenCalledWith(host, 'idle', 0)
      tracker.stop()
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe('StatelessLifecycleTracker — grace-expiry ack-aware re-arm over live pending work (C2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // A genuine pending intake keeps the emitter fenced in state:'draining' while
  // still reporting activeWork:true. onDrainGraceExpired consults the cached
  // last beat; before C2 it re-armed ONLY on state==='active', so a
  // draining+activeWork:true last beat would force-suspend over live work.
  // We keep the grace armed for the activeWork beat by making the pod exceed
  // max-uptime (so the non-idle beat still arms rather than cancelling), which
  // isolates the activeWork re-arm decision from the wakePending/idle paths.
  it('re-arms (does NOT suspend) when the last beat is draining + activeWork:true from the same pod after arming', async () => {
    const port = makePort()
    const host = makeHost()
    // Pod is old → max-uptime exceeded, so a non-idle (activeWork:true) beat
    // still answers drain:true and keeps the grace armed instead of cancelling.
    port.findPodCreationTimestamp.mockResolvedValue(new Date(NOW - 100 * HOUR))
    const tracker = makeTracker({ port, host, drainGraceMs: 60_000, maxUptimeHours: 72 })

    // Beat 1: arm the grace (uptime-exceeded → drain:true).
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 1000 }))).toEqual({
      drain: true,
      entryWakeHandledGeneration: 0,
    })
    // Beat 2: the emitter acked (state 'draining') but a pending intake keeps
    // activeWork:true. Uptime-exceeded keeps the grace armed and records the
    // activeWork:true beat as the last beat.
    expect(
      await tracker.handleHeartbeat(
        payload({
          state: 'draining',
          activeWork: true,
          conditions: {
            activeTask: true,
            awaitingApproval: false,
            pendingResults: false,
            activeCronSchedules: false,
          },
          lastActivityTs: NOW - 1000,
        })
      )
    ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })

    await vi.advanceTimersByTimeAsync(60_000)

    // C2: the grace expiry re-armed over live pending work — NO suspend.
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
  })

  it('still suspends when the last beat is draining + activeWork:false (acked, no live work) — existing behavior preserved', async () => {
    const port = makePort()
    const host = makeHost()
    const tracker = makeTracker({ port, host, drainGraceMs: 60_000 })

    // Beat 1: idle → arm the grace.
    expect(await tracker.handleHeartbeat(payload({ lastActivityTs: NOW - 31 * MIN }))).toEqual({
      drain: true,
      entryWakeHandledGeneration: 0,
    })
    // Beat 2: acked drain (state 'draining') with NO active work and stale
    // activity → the emitter is idle+acked, the drained report just never
    // landed. This is the legitimate force-suspend case.
    expect(
      await tracker.handleHeartbeat(payload({ state: 'draining', lastActivityTs: NOW - 31 * MIN }))
    ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledTimes(1)
    expect(port.suspendHostFromHeartbeat).toHaveBeenCalledWith(host, 'idle', 0)
  })
})

describe('StatelessLifecycleTracker — stale suspend commit answers drain:false (FIX 2)', () => {
  it("answers drain:false and logs when the suspend outcome is 'skipped_stale'", async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const port = makePort()
      // The executor's commit-point guards refused the drained evidence as
      // aged (wake handled past the epoch / wake pending / drain overturned).
      port.suspendHostFromHeartbeat.mockResolvedValue('skipped_stale')
      const host = makeHost({ lifecycle: { state: 'draining', wakeHandledGeneration: 0 } })
      const tracker = makeTracker({ port, host })
      const verdict = await tracker.handleHeartbeat(
        payload({ state: 'drained', lastActivityTs: NOW - 31 * MIN })
      )
      // drain:false → the pod UN-FENCES; answering drain:true here would
      // re-fence a just-woken pod on evidence the commit itself rejected.
      expect(verdict).toEqual({ drain: false })
      expect(port.suspendHostFromHeartbeat).toHaveBeenCalledTimes(1)
      const skippedLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('phase=drained_suspend_skipped_stale'))
      expect(skippedLines).toEqual([
        `[StatelessSuspend] host=stateless-host phase=drained_suspend_skipped_stale ts=${NOW}`,
      ])
      tracker.stop()
    } finally {
      logSpy.mockRestore()
    }
  })

  it("keeps drain:true for the idempotent already-suspended retry ('already_suspended')", async () => {
    const port = makePort()
    port.suspendHostFromHeartbeat.mockResolvedValue('already_suspended')
    const host = makeHost({ lifecycle: { state: 'suspended', wakeHandledGeneration: 2 } })
    const tracker = makeTracker({ port, host })
    const verdict = await tracker.handleHeartbeat(
      payload({ state: 'drained', lastActivityTs: NOW - 31 * MIN })
    )
    expect(verdict).toEqual({ drain: true, entryWakeHandledGeneration: 2 })
    tracker.stop()
  })

  it("keeps drain:true when the commit lands ('suspended')", async () => {
    const port = makePort()
    port.suspendHostFromHeartbeat.mockResolvedValue('suspended')
    const host = makeHost({ lifecycle: { state: 'draining', wakeHandledGeneration: 0 } })
    const tracker = makeTracker({ port, host })
    const verdict = await tracker.handleHeartbeat(
      payload({ state: 'drained', lastActivityTs: NOW - 31 * MIN })
    )
    expect(verdict).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
    tracker.stop()
  })
})

describe('StatelessLifecycleTracker — grace-expiry ownership re-validation (FIX 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts the force-suspend when the pod is replaced during the fresh-read await', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const port = makePort()
      const host = makeHost()
      let resolveFresh: ((h: HostCRD) => void) | undefined
      const tracker = makeTracker({ port, host, drainGraceMs: 60_000 })
      // Arm + ack so the expiry would legitimately force-suspend pod-a.
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-a', lastActivityTs: NOW - 31 * MIN }))
      ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
      expect(
        await tracker.handleHeartbeat(
          payload({ podUid: 'pod-a', state: 'draining', lastActivityTs: NOW - 31 * MIN })
        )
      ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
      // The expiry's fresh read HANGS — a pod replacement lands meanwhile.
      port.readFreshHost.mockImplementation(
        () =>
          new Promise<HostCRD>(res => {
            resolveFresh = res
          })
      )
      await vi.advanceTimersByTimeAsync(60_000)
      expect(resolveFresh).toBeDefined()
      // pod-b (a fresh roll, same creationTimestamp granularity) replaces
      // pod-a while the expiry is parked on its await.
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-b', lastActivityTs: NOW - 1 * MIN }))
      ).toEqual({ drain: false })
      resolveFresh?.(makeHost())
      await vi.advanceTimersByTimeAsync(0)
      // The aged expiry MUST abort: pod-b owns the decision now. Suspending
      // would kill the live replacement pod on misattributed silence.
      expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
      const abortLines = warnSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('aborted after the fresh read'))
      expect(abortLines).toHaveLength(1)
      tracker.stop()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('aborts the force-suspend when a new grace was re-armed during the fresh-read await', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const port = makePort()
      const host = makeHost()
      let resolveFresh: ((h: HostCRD) => void) | undefined
      const tracker = makeTracker({ port, host, drainGraceMs: 60_000 })
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-a', lastActivityTs: NOW - 31 * MIN }))
      ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
      expect(
        await tracker.handleHeartbeat(
          payload({ podUid: 'pod-a', state: 'draining', lastActivityTs: NOW - 31 * MIN })
        )
      ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
      port.readFreshHost.mockImplementation(
        () =>
          new Promise<HostCRD>(res => {
            resolveFresh = res
          })
      )
      await vi.advanceTimersByTimeAsync(60_000)
      expect(resolveFresh).toBeDefined()
      // A NEW drain:true beat re-arms a fresh grace while the aged expiry is
      // parked — the new arming owns the decision (its own window must run).
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-a', lastActivityTs: NOW - 31 * MIN }))
      ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
      resolveFresh?.(makeHost())
      await vi.advanceTimersByTimeAsync(0)
      expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
      const abortLines = warnSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('aborted after the fresh read'))
      expect(abortLines).toHaveLength(1)
      tracker.stop()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('StatelessLifecycleTracker — out-of-order pod replay tie-break (FIX 5)', () => {
  it('a straggler beat of an OLDER pod never retires the live current pod', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const port = makePort()
      port.findPodCreationTimestamp.mockImplementation(async (_host: HostCRD, uid: string) =>
        uid === 'pod-old' ? new Date(NOW - 10 * MIN) : new Date(NOW - 1 * MIN)
      )
      const tracker = makeTracker({ port })
      // The live pod beats first (post-HCC-restart, fresh tracker).
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-new', lastActivityTs: NOW - 1 * MIN }))
      ).toEqual({ drain: false })
      // An out-of-order replay of the OLD pod arrives: never seen, but
      // provably older — it must NOT become current.
      expect(
        await tracker.handleHeartbeat(
          payload({ podUid: 'pod-old', lastActivityTs: NOW - 31 * MIN })
        )
      ).toEqual({ drain: false })
      expect(
        warnSpy.mock.calls.filter(args =>
          String(args[0]).includes('OLDER than the current pod "pod-new"')
        )
      ).toHaveLength(1)
      // The live pod still steers the lifecycle (not retired, not wedged).
      expect(
        await tracker.handleHeartbeat(
          payload({ podUid: 'pod-new', lastActivityTs: NOW - 31 * MIN })
        )
      ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
      // The straggler itself was retired: its next beat hits the retired
      // discard path (logged once).
      await tracker.handleHeartbeat(payload({ podUid: 'pod-old', lastActivityTs: NOW - 31 * MIN }))
      expect(
        warnSpy.mock.calls.filter(args => String(args[0]).includes('stale pod "pod-old"'))
      ).toHaveLength(1)
      tracker.stop()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('a genuinely newer pod is adopted as current (wake/roll behavior preserved)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const port = makePort()
      port.findPodCreationTimestamp.mockImplementation(async (_host: HostCRD, uid: string) =>
        uid === 'pod-b' ? new Date(NOW - 1 * MIN) : new Date(NOW - 10 * MIN)
      )
      const tracker = makeTracker({ port })
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-a', lastActivityTs: NOW - 1 * MIN }))
      ).toEqual({ drain: false })
      // pod-b is provably newer → adopted; pod-a retired.
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-b', lastActivityTs: NOW - 1 * MIN }))
      ).toEqual({ drain: false })
      await tracker.handleHeartbeat(payload({ podUid: 'pod-a', lastActivityTs: NOW - 1 * MIN }))
      expect(
        warnSpy.mock.calls.filter(args => String(args[0]).includes('stale pod "pod-a"'))
      ).toHaveLength(1)
      tracker.stop()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('an ordering lookup failure keeps the current pod, retires nobody, and retries next beat', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const port = makePort()
      const tracker = makeTracker({ port })
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-a', lastActivityTs: NOW - 1 * MIN }))
      ).toEqual({ drain: false })
      // Lookups fail while the never-seen pod-b beats: conservative verdict.
      port.findPodCreationTimestamp.mockRejectedValue(new Error('api blip'))
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-b', lastActivityTs: NOW - 1 * MIN }))
      ).toEqual({ drain: false })
      expect(
        warnSpy.mock.calls.filter(args =>
          String(args[0]).includes('Could not order never-seen pod')
        )
      ).toHaveLength(1)
      // pod-a is STILL current (not retired): its beat is processed normally.
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-a', lastActivityTs: NOW - 31 * MIN }))
      ).toEqual({ drain: true, entryWakeHandledGeneration: 0 })
      // Lookup recovers with pod-b provably newer → the retry adopts it.
      port.findPodCreationTimestamp.mockImplementation(async (_host: HostCRD, uid: string) =>
        uid === 'pod-b' ? new Date(NOW - 1 * MIN) : new Date(NOW - 10 * MIN)
      )
      expect(
        await tracker.handleHeartbeat(payload({ podUid: 'pod-b', lastActivityTs: NOW - 1 * MIN }))
      ).toEqual({ drain: false })
      await tracker.handleHeartbeat(payload({ podUid: 'pod-a', lastActivityTs: NOW - 1 * MIN }))
      expect(
        warnSpy.mock.calls.filter(args => String(args[0]).includes('stale pod "pod-a"'))
      ).toHaveLength(1)
      tracker.stop()
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})

describe('parseHeartbeatPayload — activeCronSchedules (cron×stateless, additive)', () => {
  it('accepts an explicit boolean and preserves it', () => {
    const result = parseHeartbeatPayload(
      payload({
        conditions: {
          activeTask: false,
          awaitingApproval: false,
          pendingResults: false,
          activeCronSchedules: true,
        },
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.conditions.activeCronSchedules).toBe(true)
    }
  })

  it('defaults to false when absent so older emitters keep validating', () => {
    const legacy = {
      ...payload(),
      conditions: { activeTask: false, awaitingApproval: false, pendingResults: false },
    }
    const result = parseHeartbeatPayload(legacy)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.conditions.activeCronSchedules).toBe(false)
    }
  })

  it('rejects a present-but-non-boolean value loudly', () => {
    const bad = {
      ...payload(),
      conditions: {
        activeTask: false,
        awaitingApproval: false,
        pendingResults: false,
        activeCronSchedules: 'yes',
      },
    }
    expect(parseHeartbeatPayload(bad)).toEqual({
      ok: false,
      error: 'conditions.activeCronSchedules must be a boolean when present',
    })
  })
})

describe('StatelessLifecycleTracker — activeCronSchedules blocks suspension (cron×stateless)', () => {
  it('publishes SuspendBlocked: activeCronSchedules while a schedule pins activeWork', async () => {
    const port = makePort()
    const tracker = makeTracker({ port })
    const verdict = await tracker.handleHeartbeat(
      payload({
        activeWork: true,
        conditions: {
          activeTask: false,
          awaitingApproval: false,
          pendingResults: false,
          activeCronSchedules: true,
        },
        // Long idle — ONLY the schedule blocks the drain decision.
        lastActivityTs: NOW - 10 * HOUR,
      })
    )
    expect(verdict).toEqual({ drain: false })
    expect(port.suspendHostFromHeartbeat).not.toHaveBeenCalled()
    expect(port.publishSuspendBlockedReason).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'stateless-host' }),
      'SuspendBlocked: activeCronSchedules'
    )
  })
})
