import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ProactiveRefreshConfig,
  computeNextRefreshDelayMs,
  isRuntimeAuthProactiveRefreshRunning,
  startRuntimeAuthProactiveRefresh,
  stopRuntimeAuthProactiveRefresh,
} from '../runtimeAuthRefreshScheduler'
import { type McpHostRuntimeAuth } from '../userApprovalRequester'

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

  it('stops cleanly', () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    startRuntimeAuthProactiveRefresh(authWithToken(jwtWithExp(3600)), { refresh, config: CFG })
    expect(isRuntimeAuthProactiveRefreshRunning()).toBe(true)
    stopRuntimeAuthProactiveRefresh()
    expect(isRuntimeAuthProactiveRefreshRunning()).toBe(false)
  })
})
