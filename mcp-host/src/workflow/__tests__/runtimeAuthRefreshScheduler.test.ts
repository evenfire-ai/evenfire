import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const GATEWAY = 'http://gateway.test'
const claims = { hostRefs: ['host-a'], recipeNamespace: 'mcp-host', recipeName: 'standalone' }
const signed = (payload: Record<string, unknown>) =>
  `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ ...claims, ...payload })}.sig`
const nowSec = () => Math.floor(Date.now() / 1000)

/** No outage: the gateway rotates tokens on every call. */
const ALWAYS_UP = { from: 0, to: 0 }
/** control-api unavailable from 0 s on. */
const DOWN_FROM_START = { from: 0, to: Number.POSITIVE_INFINITY }

/** Gateway that answers 502 inside [from, to) and rotates tokens outside it. */
function gateway(outage: { from: number; to: number }, accessTtlSec: number, refreshTtlSec = 3600) {
  const calls = {
    inOutage: 0,
    ok: 0,
    /** Authorization header of every refresh-route call, in order. */
    bearers: [] as (string | null)[],
    /** Refresh token returned by every successful call, in order. */
    issuedRefreshTokens: [] as string[],
  }
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (String(input) !== `${GATEWAY}/api/v1/workflow-auth/refresh`) {
      throw new Error(`unexpected fetch ${String(input)}`)
    }
    calls.bearers.push(new Headers(init?.headers).get('Authorization'))
    if (nowSec() >= outage.from && nowSec() < outage.to) {
      calls.inOutage += 1
      return new Response('bad gateway', { status: 502 })
    }
    calls.ok += 1
    const t = nowSec()
    const refreshToken = signed({ iat: t, exp: t + refreshTtlSec })
    calls.issuedRefreshTokens.push(refreshToken)
    // Same token fields as the control-api refresh route answers with.
    return new Response(
      JSON.stringify({
        accessToken: signed({ iat: t, exp: t + accessTtlSec }),
        refreshToken,
        mcpHostControlToken: signed({ iat: t, exp: t + accessTtlSec }),
      }),
      { status: 200 }
    )
  })
  return { fetchMock, calls }
}

/** Host runtime auth whose tokens were issued at 0 s. */
function hostAuth(accessTtlSec: number, refreshTtlSec: number): McpHostRuntimeAuth {
  return {
    accessToken: signed({ iat: 0, exp: accessTtlSec }),
    refreshToken: signed({ iat: 0, exp: refreshTtlSec }),
    baseUrl: GATEWAY,
    hostRef: 'host-a',
    recipeNamespace: 'mcp-host',
    recipeName: 'standalone',
  }
}

/** Advance the fake clock to an absolute second. */
async function advanceTo(sec: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(sec * 1000 - Date.now())
}

describe('startRuntimeAuthProactiveRefresh loop', () => {
  let stateDir: string

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    // Empty state dir, so a persisted token pair cannot stand in for a refresh.
    stateDir = mkdtempSync(join(tmpdir(), 'mcp-host-refresh-scheduler-'))
    vi.stubEnv('MCP_HOST_RUNTIME_AUTH_STATE_DIR', stateDir)
    resetRuntimeAuthHealthForTests()
    runtimeAuthRecoveryFailuresCounter.reset()
  })

  afterEach(() => {
    stopRuntimeAuthProactiveRefresh()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('does not arm when disabled', async () => {
    const { fetchMock, calls } = gateway(ALWAYS_UP, 3600)
    vi.stubGlobal('fetch', fetchMock)
    const auth = hostAuth(3600, 3600)

    startRuntimeAuthProactiveRefresh(auth, { config: { ...CFG, enabled: false } })
    expect(isRuntimeAuthProactiveRefreshRunning()).toBe(false)
    await advanceTo(3600)
    expect(calls.bearers).toHaveLength(0)

    // Witness for the 0: the same auth, gateway and clock with the loop
    // enabled call the refresh route at 3000 s.
    vi.setSystemTime(0)
    startRuntimeAuthProactiveRefresh(auth, { config: CFG })
    expect(isRuntimeAuthProactiveRefreshRunning()).toBe(true)
    await advanceTo(3000)
    expect(calls.bearers).toHaveLength(1)
  })

  it('refreshes proactively before expiry and reschedules from the rotated token', async () => {
    const { fetchMock, calls } = gateway(ALWAYS_UP, 3600)
    vi.stubGlobal('fetch', fetchMock)
    const auth = hostAuth(3600, 3600)
    const firstRefreshToken = auth.refreshToken

    startRuntimeAuthProactiveRefresh(auth, { config: CFG })
    expect(isRuntimeAuthProactiveRefreshRunning()).toBe(true)

    // The first token expires at 3600 s: the refresh fires 600 s before.
    await advanceTo(2999)
    expect(calls.bearers).toHaveLength(0)
    await advanceTo(3000)
    expect(calls.bearers).toEqual([`Bearer ${firstRefreshToken}`])
    // The real refresh path rotated the pair: the new refresh token expires at 6600 s.
    expect(auth.refreshToken).toBe(calls.issuedRefreshTokens[0])
    expect(expOf(auth.refreshToken)).toBe(6600)

    // The next fire comes from the rotated token: 6600 - 600 = 6000 s.
    await advanceTo(5999)
    expect(calls.bearers).toHaveLength(1)
    await advanceTo(6000)
    expect(calls.bearers).toHaveLength(2)
    expect(calls.bearers[1]).toBe(`Bearer ${calls.issuedRefreshTokens[0]}`)
  })

  it('retries at minIntervalSec after a failed refresh so failures accumulate', async () => {
    // No half-life (recipe config), so every failed tick counts.
    const { fetchMock, calls } = gateway(DOWN_FROM_START, 3600)
    vi.stubGlobal('fetch', fetchMock)
    const auth = hostAuth(3600, 3600)

    startRuntimeAuthProactiveRefresh(auth, { config: CFG })

    // First tick at 3000 s: three attempts (backoff 1 s + 2 s), ends at 3003 s.
    await advanceTo(2999)
    expect(calls.bearers).toHaveLength(0)
    await advanceTo(3003)
    expect(calls.bearers).toHaveLength(3)
    expect(runtimeAuthHealthSnapshot().consecutiveFailures).toBe(1)

    // Failure → retry 60 s after the failed tick ended (3063 s), not the
    // refresh-token schedule.
    await advanceTo(3062)
    expect(calls.bearers).toHaveLength(3)
    await advanceTo(3066)
    expect(calls.bearers).toHaveLength(6)
    expect(runtimeAuthHealthSnapshot().consecutiveFailures).toBe(2)
    await advanceTo(3129)
    expect(calls.bearers).toHaveLength(9)
    expect(runtimeAuthHealthSnapshot().consecutiveFailures).toBe(3)
    expect(calls.ok).toBe(0)
  })

  it('is idempotent — a second start while running does not double-arm', async () => {
    const { fetchMock, calls } = gateway(ALWAYS_UP, 3600)
    vi.stubGlobal('fetch', fetchMock)
    const auth = hostAuth(3600, 3600)

    startRuntimeAuthProactiveRefresh(auth, { config: CFG })
    startRuntimeAuthProactiveRefresh(auth, { config: CFG })

    await advanceTo(3000)
    expect(calls.bearers).toHaveLength(1)
    // Witness: the single tick rotated the pair once.
    expect(calls.issuedRefreshTokens).toHaveLength(1)
    expect(auth.refreshToken).toBe(calls.issuedRefreshTokens[0])
  })

  it('renews a Host token at its midpoint, then at the new token’s midpoint', async () => {
    const { fetchMock, calls } = gateway(ALWAYS_UP, 600)
    vi.stubGlobal('fetch', fetchMock)
    const auth = hostAuth(600, 3600)

    startRuntimeAuthProactiveRefresh(auth, { config: { ...CFG, accessHalfLife: true } })

    await advanceTo(299)
    expect(calls.bearers).toHaveLength(0)
    // Witness for the line above: the renewal does come, at 300 s.
    await advanceTo(300)
    expect(calls.bearers).toHaveLength(1)
    // The rotated access token was issued at 300 s, so the next renewal is at 600 s.
    await advanceTo(599)
    expect(calls.bearers).toHaveLength(1)
    expect(expOf(auth.accessToken)).toBe(900)
    await advanceTo(600)
    expect(calls.bearers).toHaveLength(2)
  })

  it('stops cleanly', async () => {
    const { fetchMock, calls } = gateway(ALWAYS_UP, 3600)
    vi.stubGlobal('fetch', fetchMock)
    const auth = hostAuth(3600, 3600)

    startRuntimeAuthProactiveRefresh(auth, { config: CFG })
    expect(isRuntimeAuthProactiveRefreshRunning()).toBe(true)
    // Witness: the loop fired and re-armed (next fire at 6000 s).
    await advanceTo(3000)
    expect(calls.bearers).toHaveLength(1)

    stopRuntimeAuthProactiveRefresh()
    expect(isRuntimeAuthProactiveRefreshRunning()).toBe(false)
    await advanceTo(6600)
    expect(calls.bearers).toHaveLength(1)
  })
})

describe('startRuntimeAuthProactiveRefresh: control-api outage, real refresh path', () => {
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
