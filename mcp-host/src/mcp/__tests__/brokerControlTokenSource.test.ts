/**
 * Regression: the mcp-oauth broker must authenticate to control-api with the
 * LIVE control JWT, not the boot-time env/Secret seed.
 *
 * The mcp-host control JWT has a ~10 min TTL and is rotated in-pod by the
 * workflow-auth self-refresh, which persists the rotated value through
 * persistRuntimeAuthTokens(). The mounted Secret / env value is only the boot
 * seed and is NOT re-minted at that cadence, so a broker wired to it starts
 * sending an expired bearer ~10 min after pod start and control-api answers 401
 * (issue 26-08-25-mcp-oauth-broker-control-token-stale-source).
 *
 * The fixture is derived from the real producer: the state file is written by
 * persistRuntimeAuthTokens() into a temp state dir, never hand-authored. The
 * assertion is on the observable output — the Authorization header the real
 * createBrokerTokenProvider() puts on the wire — not on an intermediate call.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { config } from '../../config'
import { brokerTokenProviderDeps } from '../../main'
import { persistRuntimeAuthTokens } from '../../workflow/mcpHostJwtState'
import { createBrokerTokenProvider } from '../brokerTokenProvider'

// Must run before the module graph (config.ts snapshots env at import time).
const boot = vi.hoisted(() => {
  const base64url = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const nowSecs = Math.floor(Date.now() / 1000)
  const binding = {
    hostRefs: ['host-alpha'],
    recipeNamespace: 'mcp-host',
    recipeName: 'standalone',
  }
  const jwtFor = (
    bindingClaims: Record<string, unknown>,
    iat: number,
    exp: number,
    label: string
  ): string =>
    `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      ...bindingClaims,
      iat,
      exp,
      label,
      typ: 'service',
      scopes: ['oauth:user-token'],
    })}.sig`
  const jwt = (iat: number, exp: number, label: string): string => jwtFor(binding, iat, exp, label)
  // Same well-formed shape, bound to a DIFFERENT host: what an attacker-planted
  // or cross-tenant state file would carry.
  const foreignToken = jwtFor(
    { hostRefs: ['host-other'], recipeNamespace: 'mcp-host', recipeName: 'standalone' },
    nowSecs - 60,
    nowSecs + 540,
    'foreign'
  )

  // The seed the pod booted with: already past its ~10 min TTL.
  const bootToken = jwt(nowSecs - 1200, nowSecs - 600, 'boot-seed')
  // What the in-pod self-refresh minted afterwards.
  const rotatedToken = jwt(nowSecs - 60, nowSecs + 540, 'rotated')
  // A control JWT that already rotated once and then expired again — the state
  // an idle pod reaches between proactive refreshes (~50 min apart).
  const staleRotatedToken = jwt(nowSecs - 900, nowSecs - 300, 'rotated-then-expired')

  process.env.MCP_HOST_GATEWAY_URL = 'http://gateway.test:8092'
  process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN = bootToken
  delete process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE
  return { jwt, nowSecs, bootToken, rotatedToken, staleRotatedToken, foreignToken }
})

const tempDirs: string[] = []
const originalStateDir = process.env.MCP_HOST_RUNTIME_AUTH_STATE_DIR
const originalLegacyStateDir = process.env.CLERUM_WORKFLOW_AUTH_STATE_DIR

function useStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-control-token-'))
  tempDirs.push(dir)
  process.env.MCP_HOST_RUNTIME_AUTH_STATE_DIR = dir
  return dir
}

/** Captures the bearer the broker actually put on the wire. */
function capturingFetch() {
  return vi.fn(
    async (_url: string, init: RequestInit) =>
      ({
        status: 200,
        json: async () => ({ token: 'downstream-oauth-token', expiresAt: null }),
        __init: init,
      }) as unknown as Response
  )
}

function bearerOf(fetchImpl: ReturnType<typeof capturingFetch>, call = 0): string | undefined {
  const init = fetchImpl.mock.calls[call][1] as RequestInit
  return (init.headers as Record<string, string>).Authorization
}

/** A fetch stub that answers 401 until `unlock()` flips it to 200. */
function unauthorizedThenOk() {
  let authorized = false
  const impl = vi.fn(
    async (_url: string, _init: RequestInit) =>
      (authorized
        ? { status: 200, json: async () => ({ token: 'downstream-oauth-token', expiresAt: null }) }
        : { status: 401, json: async () => ({ error: 'unauthorized' }) }) as unknown as Response
  )
  return { impl, unlock: () => (authorized = true) }
}

beforeEach(() => {
  delete process.env.CLERUM_WORKFLOW_AUTH_STATE_DIR
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  if (originalStateDir === undefined) delete process.env.MCP_HOST_RUNTIME_AUTH_STATE_DIR
  else process.env.MCP_HOST_RUNTIME_AUTH_STATE_DIR = originalStateDir
  if (originalLegacyStateDir === undefined) delete process.env.CLERUM_WORKFLOW_AUTH_STATE_DIR
  else process.env.CLERUM_WORKFLOW_AUTH_STATE_DIR = originalLegacyStateDir
})

describe('mcp-oauth broker control token source', () => {
  it('sends the rotated control JWT from the runtime state file, not the boot env seed', async () => {
    useStateDir()
    // Real producer: the same call the self-refresh path makes after a rotation.
    await persistRuntimeAuthTokens({
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
      mcpHostControlToken: boot.rotatedToken,
    })

    const fetchImpl = capturingFetch()
    const provider = createBrokerTokenProvider(
      { name: 'mcp-clickup' },
      { userId: 'alice' },
      { ...brokerTokenProviderDeps(), fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    await expect(provider.resolve()).resolves.toBe('downstream-oauth-token')
    expect(bearerOf(fetchImpl)).toBe(`Bearer ${boot.rotatedToken}`)
    expect(bearerOf(fetchImpl)).not.toBe(`Bearer ${boot.bootToken}`)
  })

  it('falls back to the config seed while the state file does not exist yet (early boot)', async () => {
    const dir = useStateDir()
    fs.rmSync(dir, { recursive: true, force: true })

    const fetchImpl = capturingFetch()
    const provider = createBrokerTokenProvider(
      { name: 'mcp-clickup' },
      { userId: 'alice' },
      { ...brokerTokenProviderDeps(), fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    await expect(provider.resolve()).resolves.toBe('downstream-oauth-token')
    expect(bearerOf(fetchImpl)).toBe(`Bearer ${boot.bootToken}`)
  })
})

describe('mcp-oauth broker control token recovery on 401', () => {
  it('refreshes the control JWT and retries once when control-api answers 401', async () => {
    useStateDir()
    // Pod state after an earlier rotation that has since expired: BOTH the
    // persisted control token and the boot seed are past their TTL, so
    // loadPersistedWorkflowControlToken can only return the expired seed.
    await persistRuntimeAuthTokens({
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
      mcpHostControlToken: boot.staleRotatedToken,
    })

    const freshToken = boot.jwt(boot.nowSecs - 5, boot.nowSecs + 595, 'refreshed')
    const { impl, unlock } = unauthorizedThenOk()

    const provider = createBrokerTokenProvider(
      { name: 'mcp-clickup' },
      { userId: 'alice' },
      {
        ...brokerTokenProviderDeps(),
        fetchImpl: impl as unknown as typeof fetch,
        // Stand in for refreshWithRecovery(runtimeAuth): control-api mints a new
        // control JWT and userApprovalRequester persists it through
        // persistRotatedTokens -> persistRuntimeAuthTokens (the real producer).
        refreshControlToken: async () => {
          await persistRuntimeAuthTokens({
            accessToken: 'refreshed-access',
            refreshToken: 'refreshed-refresh',
            mcpHostControlToken: freshToken,
          })
          unlock()
        },
      }
    )

    const settled = await provider.resolve().catch((err: unknown) => err)

    expect(impl).toHaveBeenCalledTimes(2)
    expect(bearerOf(impl, 0)).toBe(`Bearer ${boot.bootToken}`)
    expect(bearerOf(impl, 1)).toBe(`Bearer ${freshToken}`)
    expect(settled).toBe('downstream-oauth-token')
  })

  it('does not retry when the refresh produced no new control token (no loop)', async () => {
    useStateDir()
    const { impl } = unauthorizedThenOk()
    const refreshControlToken = vi.fn(async () => {
      /* control-api answered without an mcpHostControlToken — nothing rotated */
    })

    const provider = createBrokerTokenProvider(
      { name: 'mcp-clickup' },
      { userId: 'alice' },
      {
        ...brokerTokenProviderDeps(),
        fetchImpl: impl as unknown as typeof fetch,
        refreshControlToken,
      }
    )

    await expect(provider.resolve()).rejects.toThrow(
      'mcp-oauth broker returned 401 for mcp-clickup'
    )
    expect(refreshControlToken).toHaveBeenCalledTimes(1)
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('surfaces the broker 401 (not the refresh error) when the refresh itself fails', async () => {
    useStateDir()
    const { impl } = unauthorizedThenOk()

    const provider = createBrokerTokenProvider(
      { name: 'mcp-clickup' },
      { userId: 'alice' },
      {
        ...brokerTokenProviderDeps(),
        fetchImpl: impl as unknown as typeof fetch,
        refreshControlToken: async () => {
          throw new Error('refresh recovery failed')
        },
      }
    )

    await expect(provider.resolve()).rejects.toThrow(
      'mcp-oauth broker returned 401 for mcp-clickup'
    )
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('wires refreshControlToken into the production broker deps', () => {
    // The behaviour above is proven against the real provider; this pins the
    // wiring itself, which is all main.ts can expose without a live runtimeAuth
    // (it is module-private and only assigned by the startup paths).
    expect(typeof brokerTokenProviderDeps().refreshControlToken).toBe('function')
  })
})

describe('mcp-oauth broker control token — no seed means fail closed', () => {
  // The seed (mounted Secret / env) is the pod's mounted identity: it is what
  // loadPersistedWorkflowControlToken cross-checks the state file against. These
  // tests drive the real config object main.ts reads, not a copy.
  let savedSeed: string | undefined
  let savedSeedFile: string | undefined

  beforeEach(() => {
    savedSeed = config.mcpHostWorkflowControlToken
    savedSeedFile = config.mcpHostWorkflowControlTokenFile
    config.mcpHostWorkflowControlToken = ''
    config.mcpHostWorkflowControlTokenFile = ''
  })

  afterEach(() => {
    config.mcpHostWorkflowControlToken = savedSeed
    config.mcpHostWorkflowControlTokenFile = savedSeedFile
  })

  it('never sends a persisted token that could not be cross-checked against the mounted identity', async () => {
    useStateDir()
    // Real producer writes a state file whose control token is well-formed but
    // bound to another host. With no seed there is nothing to compare it to.
    await persistRuntimeAuthTokens({
      accessToken: 'foreign-access',
      refreshToken: 'foreign-refresh',
      mcpHostControlToken: boot.foreignToken,
    })

    const fetchImpl = capturingFetch()
    const provider = createBrokerTokenProvider(
      { name: 'mcp-clickup' },
      { userId: 'alice' },
      { ...brokerTokenProviderDeps(), fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    await expect(provider.resolve()).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves undefined without calling the broker when there is no seed and no state file', async () => {
    const dir = useStateDir()
    fs.rmSync(dir, { recursive: true, force: true })

    const fetchImpl = capturingFetch()
    const provider = createBrokerTokenProvider(
      { name: 'mcp-clickup' },
      { userId: 'alice' },
      { ...brokerTokenProviderDeps(), fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    await expect(provider.resolve()).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
