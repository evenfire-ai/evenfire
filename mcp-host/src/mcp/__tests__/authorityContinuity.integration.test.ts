import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextMapperClient } from '../../contextMapperClient'
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
// Stated limit: readiness is not asserted. The accepted residual (an outage of
// about 190 s or more after a tick can make the pod NotReady) is above the
// 163 s outage of case A.

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

async function runHost(outage: Outage, untilSec: number, config: ProactiveRefreshConfig) {
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
  return { counts, onCallerAuthorizationFailure, polls }
}

describe('Host fleet continuity through a control-api outage', () => {
  let stateDir: string

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
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
    // rule it was renewed at 300 s (new expiry 900 s); the tick at 600 s and
    // its retry at 660 s fail, and the retry at 720 s succeeds.
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
    expect(counts.refreshInOutage).toBeGreaterThanOrEqual(1)
    expect(counts.refreshOk).toBeGreaterThanOrEqual(2)
  })

  it('still revokes once an outage outlasts the token', async () => {
    const { counts, onCallerAuthorizationFailure } = await runHost(
      { from: 450, to: 1100 },
      1100,
      HALF_LIFE
    )
    expect(onCallerAuthorizationFailure).toHaveBeenCalledTimes(1)
    expect(onCallerAuthorizationFailure).toHaveBeenCalledWith(401)
    expect(counts.hcc401).toBeGreaterThanOrEqual(1)
  })
})
