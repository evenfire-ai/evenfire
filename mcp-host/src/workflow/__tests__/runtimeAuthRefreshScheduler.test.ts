import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
