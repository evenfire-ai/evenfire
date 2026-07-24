import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedServerConnection, RpcAccessClaims, RpcScope } from '../../types.js'
import {
  WakeAndHoldCoordinator,
  type WakeCoordinatorDeps,
  wakeCoordinationKey,
} from '../wakeAndHold.js'

// ── Issue #791 §11.1/§11.2/§13.3/§13.4 — principal-scoped wake coordination ──
//
// The old coordinator grouped by hostRef and picked the "latest by expiry"
// authorization with NO principal/scope check. This suite pins the corrected
// contract: coordination is keyed by principal + Host, only a same-principal
// wake-capable authorization may occupy/replace the wake slot, non-wake tokens
// never trigger a wake nor displace the wake authorization, and different
// principals never share a group.

const MAX_HOLD_MS = 90_000
const POLL_MS = 2_000
const RETRIGGER_MS = 15_000

function conn(name = 'chatllm', url?: string): ResolvedServerConnection {
  return { name, url: url ?? `http://${name}:8080`, headers: {} }
}

function makeClaims(
  overrides: Partial<Omit<RpcAccessClaims, 'exp'>> & { expMs?: number } = {}
): RpcAccessClaims {
  const expMs = overrides.expMs ?? Date.now() + 3_600_000
  return {
    sub: overrides.sub ?? 'user-a',
    typ: overrides.typ ?? 'user',
    accessScope: overrides.accessScope ?? 'user',
    teamId: overrides.teamId ?? null,
    scopes: overrides.scopes ?? (['host:wake:write', 'host:message:invoke'] as RpcScope[]),
    hostRefs: overrides.hostRefs ?? ['chatllm'],
    jti: overrides.jti ?? 'jti-1',
    iat: 1,
    exp: Math.floor(expMs / 1000),
  }
}

function makeCoordinator(overrides?: Partial<WakeCoordinatorDeps>): {
  coordinator: WakeAndHoldCoordinator
  requestWake: ReturnType<typeof vi.fn>
  probeReady: ReturnType<typeof vi.fn>
} {
  const requestWake = vi.fn().mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
  const probeReady = vi.fn().mockResolvedValue(false)
  const coordinator = new WakeAndHoldCoordinator({
    requestWake,
    probeReady,
    maxHoldMs: MAX_HOLD_MS,
    pollMs: POLL_MS,
    retriggerMs: RETRIGGER_MS,
    maxTrackedCoordinations: 1_000,
    ...overrides,
  })
  return { coordinator, requestWake, probeReady }
}

function hold(
  coordinator: WakeAndHoldCoordinator,
  claims: RpcAccessClaims,
  token: string,
  host: ResolvedServerConnection = conn(),
  hostRef = 'chatllm'
) {
  return coordinator.hold({ hostRef, host, claims, rpcAccessToken: token })
}

let warnSpy: ReturnType<typeof vi.spyOn>
let debugSpy: ReturnType<typeof vi.spyOn>
let infoSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0) // no dangling timers, ever
  vi.useRealTimers()
  warnSpy.mockRestore()
  debugSpy.mockRestore()
  infoSpy.mockRestore()
})

describe('wakeCoordinationKey', () => {
  it('excludes jti/exp/role/scopes and is stable across token rotation for one principal', () => {
    const a = makeClaims({ jti: 'j1', expMs: Date.now() + 1_000_000, scopes: ['host:wake:write'] })
    const b = makeClaims({
      jti: 'j2',
      expMs: Date.now() + 9_000_000,
      scopes: ['host:session:read'],
    })
    expect(wakeCoordinationKey(a, 'chatllm')).toBe(wakeCoordinationKey(b, 'chatllm'))
  })

  it('separates user, team, and service principals and never contains bearer material', () => {
    const user = makeClaims({ typ: 'user', accessScope: 'user', teamId: null, sub: 'u1' })
    const team = makeClaims({ typ: 'user', accessScope: 'team', teamId: 't1', sub: 'u1' })
    const service = makeClaims({ typ: 'service', accessScope: 'service', teamId: 't1', sub: 'svc' })
    const keys = [
      wakeCoordinationKey(user, 'chatllm'),
      wakeCoordinationKey(team, 'chatllm'),
      wakeCoordinationKey(service, 'chatllm'),
    ]
    expect(new Set(keys).size).toBe(3)
    for (const key of keys) expect(key).not.toContain('bearer')
  })
})

describe('§13.3 wake coordination matrix', () => {
  it('row 1: wake-capable A + non-wake A (later expiry) → retain A wake auth; add waiter only', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    const a = makeClaims({ scopes: ['host:wake:write', 'host:session:read'] })
    const pA = hold(coordinator, a, 'tok-wake')
    expect(requestWake).toHaveBeenCalledTimes(1)
    expect(requestWake).toHaveBeenCalledWith('chatllm', 'tok-wake')

    const nonWakeLater = makeClaims({
      scopes: ['host:session:read'],
      expMs: Date.now() + 7_200_000,
    })
    const pB = hold(coordinator, nonWakeLater, 'tok-nonwake')

    expect(coordinator.trackedCoordinationCount()).toBe(1) // same principal group
    expect(requestWake).toHaveBeenCalledTimes(1) // the non-wake waiter triggered NO new wake
    expect(requestWake).not.toHaveBeenCalledWith('chatllm', 'tok-nonwake')

    probeReady.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    const [oA, oB] = await Promise.all([pA, pB])
    expect(oA.kind).toBe('proceed')
    expect(oB.kind).toBe('proceed')
  })

  it('row 2: wake-capable A + fresher wake-capable A → replace wake authorization + connection', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    const a = makeClaims({ expMs: Date.now() + 1_000_000 })
    const pA = hold(coordinator, a, 'tok-a', conn('chatllm', 'http://chatllm-old:8080'))

    const fresher = makeClaims({ expMs: Date.now() + 2_000_000 })
    const freshHost = conn('chatllm', 'http://chatllm-fresh:8080')
    const pA2 = hold(coordinator, fresher, 'tok-a2', freshHost)

    // Readiness probe now uses the fresher connection.
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(probeReady).toHaveBeenCalledWith(freshHost)
    // The next wake retrigger uses the fresher wake token.
    await vi.advanceTimersByTimeAsync(RETRIGGER_MS)
    expect(requestWake).toHaveBeenCalledWith('chatllm', 'tok-a2')

    coordinator.drain()
    await Promise.all([pA, pA2])
  })

  it('row 3: user A / team 1 vs user A / team 2 → separate groups', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    const t1 = makeClaims({ accessScope: 'team', teamId: 'team-1' })
    const t2 = makeClaims({ accessScope: 'team', teamId: 'team-2' })
    const p1 = hold(coordinator, t1, 'tok-t1')
    const p2 = hold(coordinator, t2, 'tok-t2')
    expect(coordinator.trackedCoordinationCount()).toBe(2)
    expect(requestWake).toHaveBeenCalledTimes(2)
    coordinator.drain()
    await Promise.all([p1, p2])
  })

  it('row 4: user A vs user B → separate groups', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    const a = makeClaims({ sub: 'user-a' })
    const b = makeClaims({ sub: 'user-b' })
    const pa = hold(coordinator, a, 'tok-a')
    const pb = hold(coordinator, b, 'tok-b')
    expect(coordinator.trackedCoordinationCount()).toBe(2)
    expect(requestWake).toHaveBeenCalledTimes(2)
    coordinator.drain()
    await Promise.all([pa, pb])
  })

  it('row 5: no wake authorization + non-wake authorization → no unauthorized wake attempt', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    const nonWake = makeClaims({ scopes: ['host:session:read'] })
    const outcome = await hold(coordinator, nonWake, 'tok-nonwake')
    expect(outcome.kind).toBe('legacy')
    expect(requestWake).not.toHaveBeenCalled()
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('key is delimiter-safe: boundary-shifting identifiers cannot collide two principals', () => {
    const p1 = makeClaims({ sub: 'a|team', accessScope: 'team', teamId: 'x' })
    const p2 = makeClaims({ sub: 'a', accessScope: 'team', teamId: 'team|x' })
    expect(wakeCoordinationKey(p1, 'chatllm')).not.toBe(wakeCoordinationKey(p2, 'chatllm'))
  })

  it('drain() is a terminal fence: a hold arriving after drain settles immediately and parks nothing', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    coordinator.drain('shutdown')
    const outcome = await hold(coordinator, makeClaims(), 'tok-after-drain')
    expect(outcome).toEqual({
      kind: 'waking',
      retryAfterMs: POLL_MS,
      reason: 'shutting-down',
      lastKnownState: 'unknown',
    })
    expect(requestWake).not.toHaveBeenCalled()
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('row 6: expired wake authorization + non-wake waiter → deterministic terminal, no wake', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    // Wake-capable token with a short budget (~2s) creates the group.
    const shortWake = makeClaims({
      scopes: ['host:wake:write', 'host:session:read'],
      expMs: Date.now() + 4_000,
    })
    const pShort = hold(coordinator, shortWake, 'tok-short')
    // A long-lived non-wake waiter keeps the entry alive after the wake token dies.
    const longNonWake = makeClaims({ scopes: ['host:session:read'], expMs: Date.now() + 3_600_000 })
    const pLong = hold(coordinator, longNonWake, 'tok-long')

    await vi.advanceTimersByTimeAsync(2_000) // short wake token budget expires
    expect((await pShort).kind).toBe('waking')
    expect(coordinator.trackedCoordinationCount()).toBe(1) // entry persists for the long waiter

    await vi.advanceTimersByTimeAsync(2_000) // now past the wake token's exp
    const late = makeClaims({ scopes: ['host:session:read'], expMs: Date.now() + 3_600_000 })
    const oLate = await hold(coordinator, late, 'tok-late')
    expect(oLate.kind).toBe('legacy')
    expect(requestWake).not.toHaveBeenCalledWith('chatllm', 'tok-late')

    coordinator.drain()
    await pLong
  })

  it('row 7: wake succeeds, health pending, several same-principal waiters → one wake, each proceeds', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    const a = makeClaims()
    const pendings = [
      hold(coordinator, a, 'tok-1'),
      hold(coordinator, a, 'tok-2'),
      hold(coordinator, a, 'tok-3'),
    ]
    expect(coordinator.trackedCoordinationCount()).toBe(1)
    expect(requestWake).toHaveBeenCalledTimes(1) // one wake sequence for the principal group

    probeReady.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    for (const outcome of await Promise.all(pendings)) {
      expect(outcome.kind).toBe('proceed')
    }
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('row 8: waiter settles, a later probe failure does not re-settle', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    void requestWake
    probeReady.mockResolvedValueOnce(true) // first probe: ready → settle proceed
    const pending = hold(coordinator, makeClaims(), 'tok-1')
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect((await pending).kind).toBe('proceed')
    expect(coordinator.trackedCoordinationCount()).toBe(0)

    // Advancing past every window makes NO further probe/settle — group is gone.
    const probeCalls = probeReady.mock.calls.length
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS * 2)
    expect(probeReady.mock.calls.length).toBe(probeCalls)
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })
})

describe('§13.4 operation outcomes (unit level)', () => {
  it('active runtime → proceed immediately, no hold loop', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'active', wakeGeneration: null })
    const outcome = await hold(coordinator, makeClaims(), 'tok')
    expect(outcome).toEqual({ kind: 'proceed', lastKnownState: 'active' })
    expect(probeReady).not.toHaveBeenCalled()
  })

  it('stateful unavailable (not-stateless) → legacy, never a stateless wake hold', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'not-stateless' })
    const outcome = await hold(coordinator, makeClaims(), 'tok')
    expect(outcome).toEqual({ kind: 'legacy', reason: 'not-stateless' })
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('suspended + no wake grant → no fallback grant; deterministic legacy result', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    const outcome = await hold(coordinator, makeClaims({ scopes: ['host:session:read'] }), 'tok')
    expect(outcome.kind).toBe('legacy')
    expect(requestWake).not.toHaveBeenCalled()
  })
})

describe('a mid-hold wake auth rejection distinguishes initial from retrigger', () => {
  it('an initial wake 403 settles the group legacy', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'auth', status: 403 })
    const outcome = await hold(coordinator, makeClaims(), 'tok')
    expect(outcome).toEqual({ kind: 'legacy', reason: 'wake-auth-403' })
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('a retrigger wake 403 does NOT collapse still-valid waiters (initial guard)', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake
      .mockResolvedValueOnce({ kind: 'wake-requested', wakeGeneration: 1 })
      .mockResolvedValue({ kind: 'auth', status: 403 }) // retrigger rejected
    probeReady.mockResolvedValue(false)

    const pending = hold(coordinator, makeClaims(), 'tok')
    await vi.advanceTimersByTimeAsync(RETRIGGER_MS) // fire one retrigger (auth 403)
    // The group is still held (bounded by deadlines), not collapsed to legacy.
    expect(coordinator.trackedCoordinationCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS)
    const outcome = await pending
    expect(outcome).toMatchObject({ kind: 'waking' })
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })
})

describe('shutdown drain', () => {
  it('settles every parked waiter deterministically and leaves no dangling timers', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    void requestWake
    void probeReady
    const a = hold(coordinator, makeClaims({ sub: 'user-a' }), 'tok-a', conn('chatllm'), 'chatllm')
    const b = hold(
      coordinator,
      makeClaims({ sub: 'user-b', hostRefs: ['other'] }),
      'tok-b',
      conn('other'),
      'other'
    )
    expect(coordinator.trackedCoordinationCount()).toBe(2)

    coordinator.drain()

    const [oa, ob] = await Promise.all([a, b])
    expect(oa.kind).toBe('waking')
    expect(ob.kind).toBe('waking')
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })
})
