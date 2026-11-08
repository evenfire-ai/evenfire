import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeAuthHealthForTests,
  runtimeAuthHealthSnapshot,
  runtimeAuthRecoveryFailuresCounter,
} from '../runtimeAuthHealth'
import {
  type ProactiveRefreshConfig,
  computeNextRefreshDelayMs,
  isRuntimeAuthProactiveRefreshRunning,
  proactiveRefreshConfig,
  startRuntimeAuthProactiveRefresh,
  stopRuntimeAuthProactiveRefresh,
} from '../runtimeAuthRefreshScheduler'
import { type McpHostRuntimeAuth } from '../userApprovalRequester'

const runtimeKind = vi.hoisted(() => ({ value: 'standalone' as string }))
vi.mock('../../config', async importOriginal => {
  const actual = await importOriginal<typeof import('../../config')>()
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) =>
        prop === 'runtimeKind' ? runtimeKind.value : Reflect.get(target, prop, receiver),
    }),
  }
})

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** Minimal unsigned JWT — jose's decodeJwt reads the payload without verifying. */
function jwtWithExp(expSec: number | null): string {
  const payload = expSec == null ? { sub: 'x' } : { sub: 'x', exp: expSec }
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`
}

const CFG: ProactiveRefreshConfig = {
  enabled: true,
  marginSec: 600,
  minIntervalSec: 60,
  fallbackSec: 1800,
}

function authWithToken(token: string): McpHostRuntimeAuth {
  return { refreshToken: token } as unknown as McpHostRuntimeAuth
}

describe('computeNextRefreshDelayMs', () => {
  const now = 1_000_000_000_000 // fixed wall clock (ms)

  it('refreshes marginSec before the refresh token expires', () => {
    const expSec = now / 1000 + 3600 // expires in 1h
    const delay = computeNextRefreshDelayMs(jwtWithExp(expSec), now, CFG)
    // 3600s - 600s margin = 3000s
    expect(delay).toBe(3000 * 1000)
  })

  it('clamps to minIntervalSec when the token is already past due', () => {
    const expSec = now / 1000 - 10 // already expired
    const delay = computeNextRefreshDelayMs(jwtWithExp(expSec), now, CFG)
    expect(delay).toBe(CFG.minIntervalSec * 1000)
  })

  it('clamps to minIntervalSec inside the margin window', () => {
    const expSec = now / 1000 + 120 // expires in 2m, inside the 10m margin
    const delay = computeNextRefreshDelayMs(jwtWithExp(expSec), now, CFG)
    expect(delay).toBe(CFG.minIntervalSec * 1000)
  })

  it('uses the fallback interval when exp cannot be decoded', () => {
    const delay = computeNextRefreshDelayMs(jwtWithExp(null), now, CFG)
    expect(delay).toBe(CFG.fallbackSec * 1000)
  })
})

/** Unsigned access JWT with `iat` and `exp`, in seconds. */
function accessJwt(iatSec: number | null, expSec: number | null): string {
  const payload: Record<string, unknown> = { sub: 'x' }
  if (iatSec != null) payload.iat = iatSec
  if (expSec != null) payload.exp = expSec
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`
}

describe('computeNextRefreshDelayMs: access token half-life (Host pods)', () => {
  const now = 1_000_000_000_000
  const nowSec = now / 1000
  const HALF: ProactiveRefreshConfig = { ...CFG, accessHalfLife: true }

  it('renews at the access token midpoint', () => {
    const delay = computeNextRefreshDelayMs(
      jwtWithExp(nowSec + 3600),
      now,
      HALF,
      accessJwt(nowSec, nowSec + 600)
    )
    expect(delay).toBe(300 * 1000)
  })

  it('keeps the refresh-token rule when it comes first', () => {
    const delay = computeNextRefreshDelayMs(
      jwtWithExp(nowSec + 700),
      now,
      HALF,
      accessJwt(nowSec, nowSec + 600)
    )
    expect(delay).toBe(100 * 1000)
  })

  it('clamps to minIntervalSec once the midpoint has passed', () => {
    const delay = computeNextRefreshDelayMs(
      jwtWithExp(nowSec + 3600),
      now,
      HALF,
      accessJwt(nowSec - 400, nowSec + 200)
    )
    expect(delay).toBe(CFG.minIntervalSec * 1000)
  })

  it('falls back to the refresh-token rule when the access token cannot be decoded', () => {
    expect(computeNextRefreshDelayMs(jwtWithExp(nowSec + 3600), now, HALF, 'not-a-jwt')).toBe(
      3000 * 1000
    )
    expect(
      computeNextRefreshDelayMs(jwtWithExp(nowSec + 3600), now, HALF, accessJwt(null, nowSec + 600))
    ).toBe(3000 * 1000)
  })

  it('ignores the access token when the half-life is off (recipe pods)', () => {
    const delay = computeNextRefreshDelayMs(
      jwtWithExp(nowSec + 3600),
      now,
      CFG,
      accessJwt(nowSec, nowSec + 600)
    )
    expect(delay).toBe(3000 * 1000)
  })
})

describe('proactiveRefreshConfig: half-life by runtime kind', () => {
  afterEach(() => {
    runtimeKind.value = 'standalone'
  })

  it.each([
    ['standalone', true],
    ['workflow', false],
    ['sdk-only', false],
  ])('%s gives accessHalfLife %s', (kind, expected) => {
    runtimeKind.value = kind
    expect(proactiveRefreshConfig().accessHalfLife).toBe(expected)
  })
})

describe('startRuntimeAuthProactiveRefresh loop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    stopRuntimeAuthProactiveRefresh()
    vi.useRealTimers()
  })

  it('does not arm when disabled', () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    startRuntimeAuthProactiveRefresh(authWithToken(jwtWithExp(3600)), {
      refresh,
      config: { ...CFG, enabled: false },
    })
    expect(isRuntimeAuthProactiveRefreshRunning()).toBe(false)
  })

  it('refreshes proactively before expiry and reschedules from the rotated token', async () => {
    // First token expires in 1h → first fire at 3000s. After a successful
    // refresh the auth carries a new token whose exp drives the next fire.
    const auth = authWithToken(jwtWithExp(3600))
    const refresh = vi.fn().mockImplementation(async (a: McpHostRuntimeAuth) => {
      a.refreshToken = jwtWithExp(7200) // rotated: now expires in 2h from t0
    })

    startRuntimeAuthProactiveRefresh(auth, { refresh, config: CFG, now: () => Date.now() })
    expect(isRuntimeAuthProactiveRefreshRunning()).toBe(true)

    await vi.advanceTimersByTimeAsync(3000 * 1000)
    expect(refresh).toHaveBeenCalledTimes(1)

    // New token exp=7200s, fired at t=3000s → next at 7200-600-3000 = 3600s later.
    await vi.advanceTimersByTimeAsync(3600 * 1000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('retries at minIntervalSec after a failed refresh so failures accumulate', async () => {
    const auth = authWithToken(jwtWithExp(3600))
    const refresh = vi.fn().mockRejectedValue(new Error('reIssueTokens: unauthorized (401)'))

    startRuntimeAuthProactiveRefresh(auth, { refresh, config: CFG, now: () => Date.now() })

    await vi.advanceTimersByTimeAsync(3000 * 1000) // first fire
    expect(refresh).toHaveBeenCalledTimes(1)

    // Failure → retry after minIntervalSec (60s), not the full margin window.
    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('is idempotent — a second start while running does not double-arm', async () => {
    const auth = authWithToken(jwtWithExp(3600))
    const refresh = vi.fn().mockResolvedValue(undefined)
    startRuntimeAuthProactiveRefresh(auth, { refresh, config: CFG, now: () => Date.now() })
    startRuntimeAuthProactiveRefresh(auth, { refresh, config: CFG, now: () => Date.now() })

    await vi.advanceTimersByTimeAsync(3000 * 1000)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('renews a Host token at its midpoint, then at the new token’s midpoint', async () => {
    const auth = {
      refreshToken: jwtWithExp(3600),
      accessToken: accessJwt(0, 600),
    } as unknown as McpHostRuntimeAuth
    const refresh = vi.fn().mockImplementation(async (a: McpHostRuntimeAuth) => {
      const t = Math.floor(Date.now() / 1000)
      a.accessToken = accessJwt(t, t + 600)
      a.refreshToken = jwtWithExp(t + 3600)
    })
    startRuntimeAuthProactiveRefresh(auth, {
      refresh,
      config: { ...CFG, accessHalfLife: true },
      now: () => Date.now(),
    })

    await vi.advanceTimersByTimeAsync(299 * 1000)
    expect(refresh).toHaveBeenCalledTimes(0)
    // Witness for the line above: the renewal does come, at 300 s.
    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(1)
    // The rotated token was issued at 300 s, so the next renewal is at 600 s.
    await vi.advanceTimersByTimeAsync(299 * 1000)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('stops cleanly', () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    startRuntimeAuthProactiveRefresh(authWithToken(jwtWithExp(3600)), { refresh, config: CFG })
    expect(isRuntimeAuthProactiveRefreshRunning()).toBe(true)
    stopRuntimeAuthProactiveRefresh()
    expect(isRuntimeAuthProactiveRefreshRunning()).toBe(false)
  })
})

describe('startRuntimeAuthProactiveRefresh: control-api outage, real refresh path', () => {
  const GATEWAY = 'http://gateway.test'
  const claims = { hostRefs: ['host-a'], recipeNamespace: 'mcp-host', recipeName: 'standalone' }
  const signed = (payload: Record<string, unknown>) =>
    `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ ...claims, ...payload })}.sig`
  const nowSec = () => Math.floor(Date.now() / 1000)

  /** Gateway that answers 502 inside [from, to) and rotates tokens outside it. */
  function gateway(outage: { from: number; to: number }, accessTtlSec: number) {
    const calls = { inOutage: 0, ok: 0 }
    const fetchMock = vi.fn(async (input: string | URL) => {
      if (String(input) !== `${GATEWAY}/api/v1/workflow-auth/refresh`) {
        throw new Error(`unexpected fetch ${String(input)}`)
      }
      if (nowSec() >= outage.from && nowSec() < outage.to) {
        calls.inOutage += 1
        return new Response('bad gateway', { status: 502 })
      }
      calls.ok += 1
      const t = nowSec()
      return new Response(
        JSON.stringify({
          accessToken: signed({ iat: t, exp: t + accessTtlSec }),
          refreshToken: signed({ iat: t, exp: t + 3600 }),
        }),
        { status: 200 }
      )
    })
    return { fetchMock, calls }
  }

  /** Advance one second at a time and keep the worst health seen. */
  async function runUntil(untilSec: number) {
    let maxConsecutive = 0
    let degradedAt: number | null = null
    while (nowSec() < untilSec) {
      await vi.advanceTimersByTimeAsync(1_000)
      const snap = runtimeAuthHealthSnapshot()
      maxConsecutive = Math.max(maxConsecutive, snap.consecutiveFailures)
      if (snap.state === 'degraded' && degradedAt == null) degradedAt = nowSec()
    }
    return { maxConsecutive, degradedAt }
  }

  const deferred = async () =>
    (await runtimeAuthRecoveryFailuresCounter.get()).values.find(
      v => v.labels.reason === 'refresh_unavailable_token_valid'
    )?.value ?? 0

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    resetRuntimeAuthHealthForTests()
    runtimeAuthRecoveryFailuresCounter.reset()
  })

  afterEach(() => {
    stopRuntimeAuthProactiveRefresh()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('a Host pod rides out a 250 s outage that starts at a renewal tick', async () => {
    const { fetchMock, calls } = gateway({ from: 299, to: 549 }, 600)
    vi.stubGlobal('fetch', fetchMock)
    const auth = {
      accessToken: signed({ iat: 0, exp: 600 }),
      refreshToken: signed({ iat: 0, exp: 3600 }),
      baseUrl: GATEWAY,
      ...{ hostRef: 'host-a', recipeNamespace: 'mcp-host', recipeName: 'standalone' },
    } as McpHostRuntimeAuth
    startRuntimeAuthProactiveRefresh(auth, {
      config: { ...CFG, accessHalfLife: true },
      now: () => Date.now(),
    })

    const { maxConsecutive, degradedAt } = await runUntil(560)

    // Witnesses: four failed ticks (300, 363, 426, 489; three attempts each)
    // ran inside the outage, each was recorded as deferred, and the retry at
    // about 552 s renewed the token.
    expect(calls.inOutage).toBe(12)
    expect(await deferred()).toBe(4)
    expect(calls.ok).toBe(1)
    expect(maxConsecutive).toBe(0)
    expect(degradedAt).toBeNull()
    expect(expOf(auth.accessToken)).toBeGreaterThan(1100)
  })

  it('a Host pod counts the tick whose token would not outlive the next retry', async () => {
    // First token expires at 600 s; the outage outlasts it.
    const { fetchMock, calls } = gateway({ from: 299, to: 700 }, 600)
    vi.stubGlobal('fetch', fetchMock)
    const auth = {
      accessToken: signed({ iat: 0, exp: 600 }),
      refreshToken: signed({ iat: 0, exp: 3600 }),
      baseUrl: GATEWAY,
      ...{ hostRef: 'host-a', recipeNamespace: 'mcp-host', recipeName: 'standalone' },
    } as McpHostRuntimeAuth
    startRuntimeAuthProactiveRefresh(auth, {
      config: { ...CFG, accessHalfLife: true },
      now: () => Date.now(),
    })

    // Ticks at 300, 363, 426 and 489 s end with 297-108 s of token left and are
    // deferred. The tick at 552 s ends at 555 s with 45 s left (< the 60 s to
    // the next retry), so it counts.
    const early = await runUntil(551)
    expect(early.maxConsecutive).toBe(0)
    expect(await deferred()).toBe(4)
    await runUntil(556)
    expect(runtimeAuthHealthSnapshot()).toMatchObject({ state: 'ok', consecutiveFailures: 1 })
    expect(calls.inOutage).toBe(15)
    // After expiry every failure counts: the ticks at 615 s and 678 s reach the
    // threshold when the second one ends, at 681 s.
    const late = await runUntil(690)
    expect(late.degradedAt).toBe(681)
    expect(await deferred()).toBe(4)
  })

  it('a recipe pod (no half-life) still degrades on the same failures', async () => {
    // Recipe pods renew on the refresh-token rule: first tick at 3600 - 600 = 3000 s.
    const { fetchMock, calls } = gateway({ from: 2999, to: 3250 }, 3600)
    vi.stubGlobal('fetch', fetchMock)
    const auth = {
      accessToken: signed({ iat: 0, exp: 3600 }),
      refreshToken: signed({ iat: 0, exp: 3600 }),
      baseUrl: GATEWAY,
      ...{ hostRef: 'host-a', recipeNamespace: 'mcp-host', recipeName: 'standalone' },
    } as McpHostRuntimeAuth
    startRuntimeAuthProactiveRefresh(auth, { config: CFG, now: () => Date.now() })

    const { degradedAt } = await runUntil(3150)

    // Three failed ticks (3000, 3063, 3126) with 474 s or more of token left
    // still reach the threshold: the deferral is for Host pods only.
    expect(calls.inOutage).toBe(9)
    expect(await deferred()).toBe(0)
    expect(degradedAt).toBe(3129)
  })
})

function expOf(token: string): number {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp as number
}
