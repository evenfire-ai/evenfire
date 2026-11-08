import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextMapperClient } from '../../contextMapperClient'
import {
  resetRuntimeAuthHealthForTests,
  runtimeAuthHealthSnapshot,
  runtimeAuthRecoveryFailuresCounter,
} from '../../workflow/runtimeAuthHealth'
import {
  type ProactiveRefreshConfig,
  startRuntimeAuthProactiveRefresh,
  stopRuntimeAuthProactiveRefresh,
} from '../../workflow/runtimeAuthRefreshScheduler'
import { type McpHostRuntimeAuth, refreshWithRecovery } from '../../workflow/userApprovalRequester'

// Process-level continuity for a Host pod: the real HCC client, the real
// refresh path and the real scheduler, on a fake clock, against scripted HCC
// and control-api answers. HCC rejects a bearer whose `exp` has passed; the
// refresh route answers 504 while control-api is down.
//
// Readiness is modelled, not served: a probe every 10 s that fails while
// runtimeAuthHealthSnapshot() is degraded (the state /v1/runtime/health
// answers 503 on), NotReady after 6 failures and Ready after 1 success, as in
// the Host Deployment HCC writes. A scheduled renewal that fails only because
// control-api is unavailable is not counted while the access token outlives
// the next retry, so an outage the fleet survives does not make the pod
// NotReady. An outage longer than the token still degrades it and revokes.

const HCC = 'http://hcc.test'
const GATEWAY = 'http://gateway.test'
const HALF_LIFE: ProactiveRefreshConfig = {
  enabled: true,
  marginSec: 600,
  minIntervalSec: 60,
  fallbackSec: 1800,
  accessHalfLife: true,
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
function jwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`
}
const nowSec = () => Math.floor(Date.now() / 1000)
const claims = { hostRefs: ['host-a'], recipeNamespace: 'mcp-host', recipeName: 'standalone' }
const accessToken = (iat: number) => jwt({ ...claims, iat, exp: iat + 600 })
const refreshToken = (iat: number) => jwt({ ...claims, iat, exp: iat + 3600 })
const expOf = (token: string): number =>
  JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp as number

type Outage = { from: number; to: number }

function scriptedBackends(outage: Outage) {
  const counts = { hcc200: 0, hcc200InOutage: 0, hcc401: 0, refreshInOutage: 0, refreshOk: 0 }
  const down = () => nowSec() >= outage.from && nowSec() < outage.to
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const bearer = String(new Headers(init?.headers).get('Authorization') ?? '').replace(
      /^Bearer /,
      ''
    )
    if (url === `${HCC}/api/v2/hosts/self/mcpservers`) {
      if (expOf(bearer) <= nowSec()) {
        counts.hcc401 += 1
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      }
      if (down()) counts.hcc200InOutage += 1
      counts.hcc200 += 1
      return new Response(JSON.stringify({ servers: [], timestamp: new Date().toISOString() }), {
        status: 200,
      })
    }
    if (url === `${GATEWAY}/api/v1/workflow-auth/refresh`) {
      if (down()) {
        counts.refreshInOutage += 1
        return new Response('gateway timeout', { status: 504 })
      }
      counts.refreshOk += 1
      const t = nowSec()
      return new Response(
        JSON.stringify({
          accessToken: accessToken(t),
          refreshToken: refreshToken(t),
          expiresInSeconds: 600,
        }),
        { status: 200 }
      )
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  return { fetchMock, counts }
}

/**
 * Kubelet model of the Host readiness probe (period 10 s, failureThreshold 6,
 * successThreshold 1; host-context-controller/src/hostReconciler.ts). The
 * route answers 503 exactly when the snapshot is degraded (src/server.ts,
 * pinned by server.interface.contract.test.ts).
 */
function readinessProbe(phaseSec: number) {
  const result = { probes: 0, degradedProbes: 0, notReadySec: 0 }
  let failing = 0
  let notReadySince: number | null = null
  const closeNotReady = () => {
    if (notReadySince == null) return
    result.notReadySec += nowSec() - notReadySince
    notReadySince = null
  }
  const probe = () => {
    result.probes += 1
    if (runtimeAuthHealthSnapshot().state === 'degraded') {
      result.degradedProbes += 1
      failing += 1
      if (failing >= 6 && notReadySince == null) notReadySince = nowSec()
    } else {
      failing = 0
      closeNotReady()
    }
  }
  let interval: ReturnType<typeof setInterval> | undefined
  const start = setTimeout(() => {
    probe()
    interval = setInterval(probe, 10_000)
  }, phaseSec * 1000)
  return {
    result,
    stop: () => {
      clearTimeout(start)
      clearInterval(interval)
      closeNotReady()
    },
  }
}

async function runHost(
  outage: Outage,
  untilSec: number,
  config: ProactiveRefreshConfig,
  probePhaseSec = 0
) {
  const { fetchMock, counts } = scriptedBackends(outage)
  vi.stubGlobal('fetch', fetchMock)
  const auth = {
    accessToken: accessToken(0),
    refreshToken: refreshToken(0),
    baseUrl: GATEWAY,
    hostRef: 'host-a',
    recipeNamespace: 'mcp-host',
    recipeName: 'standalone',
  } as McpHostRuntimeAuth
  const onCallerAuthorizationFailure = vi.fn()
  const client = new ContextMapperClient(HCC, {
    authentication: {
      getAccessToken: () => auth.accessToken,
      refreshOnUnauthorized: () => refreshWithRecovery(auth),
      onCallerAuthorizationFailure,
    },
  })
  startRuntimeAuthProactiveRefresh(auth, { config, now: () => Date.now() })
  const readiness = readinessProbe(probePhaseSec)

  // The inventory poll runs every 30 s, as in production. It stops after the
  // first revocation, as the Host does.
  // A refresh inside a poll backs off on timers (1/2/4 s), so the clock keeps
  // moving while the poll is pending; the next poll still starts on the next
  // 30 s boundary.
  let polls = 0
  while (nowSec() < untilSec && onCallerAuthorizationFailure.mock.calls.length === 0) {
    await vi.advanceTimersByTimeAsync(30_000 - (Date.now() % 30_000))
    let settled = false
    void client
      .pollServers()
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        settled = true
      })
    for (let waited = 0; !settled; waited += 1) {
      if (waited > 60) throw new Error(`poll at ${nowSec()} s did not settle`)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    polls += 1
  }
  // The renewal loop and the probe keep running after a revocation.
  await vi.advanceTimersByTimeAsync(Math.max(0, untilSec * 1000 - Date.now()))
  readiness.stop()
  return { counts, onCallerAuthorizationFailure, polls, readiness: readiness.result }
}

describe('Host fleet continuity through a control-api outage', () => {
  let stateDir: string

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    resetRuntimeAuthHealthForTests()
    runtimeAuthRecoveryFailuresCounter.reset()
    stateDir = mkdtempSync(join(tmpdir(), 'continuity-state-'))
    vi.stubEnv('MCP_HOST_RUNTIME_AUTH_STATE_DIR', stateDir)
  })

  afterEach(() => {
    stopRuntimeAuthProactiveRefresh()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('keeps the fleet through a 163 s outage that covers the old expiry and a tick', async () => {
    // 163 s is the longest control-api outage measured. The first token
    // expires at 600 s, inside the outage (500-663 s). With the half-life
    // rule it was renewed at 300 s (new expiry 900 s). The tick at 600 s
    // fails (three attempts, about 3 s), and its retry at about 663 s, just
    // after the outage ends, succeeds. Only one tick fails.
    const { counts, onCallerAuthorizationFailure, polls } = await runHost(
      { from: 500, to: 663 },
      900,
      HALF_LIFE
    )
    expect(onCallerAuthorizationFailure).not.toHaveBeenCalled()
    expect(polls).toBeGreaterThanOrEqual(25)
    // Witnesses: HCC kept answering during the outage, a renewal was tried
    // inside it, and renewals succeeded before and after it.
    expect(counts.hcc200InOutage).toBeGreaterThanOrEqual(5)
    // One failed tick of three attempts; renewals at 300 s and about 663 s.
    expect(counts.refreshInOutage).toBe(3)
    expect(counts.refreshOk).toBe(2)
  })

  it.each(
    [131, 163, 200, 250, 299].flatMap(lengthSec => [0, 3, 7].map(phase => [lengthSec, phase]))
  )(
    'keeps the pod Ready through a %i s outage that starts at a renewal tick (probe phase %i s)',
    async (lengthSec, phase) => {
      // Renewed at 300 s (expiry 900 s); the next tick is at 600 s, one second
      // into the outage. Failed ticks follow every ~63 s: 600, 663, 726, ...
      const { counts, onCallerAuthorizationFailure, polls, readiness } = await runHost(
        { from: 599, to: 599 + lengthSec },
        1000,
        HALF_LIFE,
        phase
      )
      expect(onCallerAuthorizationFailure).not.toHaveBeenCalled()
      expect(readiness.degradedProbes).toBe(0)
      expect(readiness.notReadySec).toBe(0)
      // Witnesses: the probe ran for the whole run; at least three ticks
      // (enough for the degraded threshold) failed inside the outage, and each
      // was recorded as deferred; renewals resumed after it.
      expect(readiness.probes).toBeGreaterThanOrEqual(99)
      expect(polls).toBeGreaterThanOrEqual(30)
      expect(counts.refreshInOutage).toBeGreaterThanOrEqual(9)
      const deferred = (await runtimeAuthRecoveryFailuresCounter.get()).values.find(
        v => v.labels.reason === 'refresh_unavailable_token_valid'
      )?.value
      expect(deferred).toBeGreaterThanOrEqual(3)
      expect(counts.refreshOk).toBeGreaterThanOrEqual(2)
    }
  )

  it.each([0, 3, 7])(
    'still degrades and revokes once an outage outlasts the token (probe phase %i s)',
    async phase => {
      const { counts, onCallerAuthorizationFailure, readiness } = await runHost(
        { from: 450, to: 1100 },
        1100,
        HALF_LIFE,
        phase
      )
      expect(onCallerAuthorizationFailure).toHaveBeenCalledTimes(1)
      expect(onCallerAuthorizationFailure).toHaveBeenCalledWith(401)
      expect(counts.hcc401).toBeGreaterThanOrEqual(1)
      // The token expired at 900 s: the failures from about 850 s on count, the
      // pod degrades and goes NotReady.
      expect(readiness.degradedProbes).toBeGreaterThanOrEqual(6)
      expect(readiness.notReadySec).toBeGreaterThan(0)
    }
  )
})
