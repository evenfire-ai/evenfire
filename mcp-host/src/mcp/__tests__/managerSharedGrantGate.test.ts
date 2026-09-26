/**
 * SHARED oauth-context grant gate (spec §6.2, invariants 3/4/17). A remote
 * oauth-context server's SHARED representative opens ONLY once its context grant
 * is confirmed — never token-less before it. The dangerous upstream is the
 * lenient one (Google-like: accepts `initialize` token-less, 401s at tools/call),
 * because an ungated eager admission would cache a token-less catalog against it.
 *
 * Fixtures come from the shared helper (T1): `brokerWiring` serves BOTH the probe
 * (`/grants/exists`) and the token mint (`/user-token`) from ONE grant store, so
 * "grant exists" means the identical thing to the gate's decision and to the
 * connection's Authorization; `remoteUpstream({strict:false})` is the real
 * McpClient over a mocked SDK. Assertions are observable (T4): the catalog
 * (`getAllTools`), the transport the SHARED opened (its Authorization header or
 * its absence), the number of `/grants/exists` POSTs, and the 401 counter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../logger'
import type { McpServerInfo } from '../../types'
import { checkGrantExistence } from '../grantExistenceClient'
import type { GrantExistenceChecker, McpCatalogBootstrapConfig } from '../grantProbe'
import { McpManager } from '../manager'
import { type RemoteUpstreamState, brokerWiring } from './helpers/brokerWiring'

// Lenient (Google-like) upstream + shared state. The state is a plain literal in
// a synchronous vi.hoisted (no imports — those aren't resolved that early); each
// vi.mock factory dynamically imports the builder (a factory runs before the
// file's static imports resolve, so it cannot reference them directly).
const sdk = vi.hoisted<RemoteUpstreamState>(() => ({
  transports: [],
  probeAuth: [],
  callToolImpl: null,
  toolCall401Count: 0,
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', async () => {
  const { remoteUpstream } = await import('./helpers/brokerWiring')
  return remoteUpstream({ strict: false }, sdk).clientModule
})
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async () => {
  const { remoteUpstream } = await import('./helpers/brokerWiring')
  return remoteUpstream({ strict: false }, sdk).transportModule
})
vi.mock('@modelcontextprotocol/sdk/client/sse.js', async () => {
  const { remoteUpstream } = await import('./helpers/brokerWiring')
  return remoteUpstream({ strict: false }, sdk).sseModule
})

// The real SSRF guard is exercised in clientRemoteTarget.test.ts; here it must
// never touch DNS (the SDK is mocked, so its returned fetch is never invoked).
vi.mock('../../core/net/ssrf', () => ({
  SsrfBlockedError: class SsrfBlockedError extends Error {},
  resolvePinnedPublicIp: vi.fn(async () => '203.0.113.10'),
}))

function remoteOauthContextServer(name = 'remote-ctx'): McpServerInfo {
  return {
    name,
    contextRef: 'ctx-1',
    transport: { type: 'streamableHttp', url: `https://${name}.example.com/mcp` },
    authKind: 'oauth-context',
    remote: true,
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

function bootstrapConfig(over: Partial<McpCatalogBootstrapConfig> = {}): McpCatalogBootstrapConfig {
  return {
    enabled: true,
    waitBudgetMs: 4000,
    probeTimeoutMs: 2000,
    connectTimeoutMs: 8000,
    negativeTtlMs: 15000,
    failureTtlMs: 60000,
    probesPerMin: 20,
    backoffMs: 30000,
    ...over,
  }
}

/** A manager wired with BOTH grant deps — the note the gate requires to engage. */
function gatedManager(
  grantStore: Set<string>,
  cfgOver: Partial<McpCatalogBootstrapConfig> = {},
  now?: () => number
): {
  manager: McpManager
  existsCalls: ReturnType<typeof brokerWiring>['existsCalls']
  failExistsWith: ReturnType<typeof brokerWiring>['failExistsWith']
} {
  const { deps, factory, existsCalls, failExistsWith } = brokerWiring(grantStore)
  const grantExistence: GrantExistenceChecker = (queries, { timeoutMs }) =>
    checkGrantExistence({ ...deps, timeoutMs }, queries)
  const manager = new McpManager(undefined, undefined, factory, {
    grantExistence,
    catalogBootstrap: bootstrapConfig(cfgOver),
    now,
  })
  return { manager, existsCalls, failExistsWith }
}

beforeEach(() => {
  sdk.transports = []
  sdk.callToolImpl = null
  sdk.toolCall401Count = 0
})

describe('SHARED oauth-context grant gate (spec §6.2)', () => {
  // ── invariant 3 (T3) ──
  it('without a grant, never opens or caches a token-less SHARED', async () => {
    const grantStore = new Set<string>() // no grant
    const { manager, existsCalls } = gatedManager(grantStore)

    await expect(manager.addServer(remoteOauthContextServer())).resolves.toBe('applied')

    // No SHARED connection: empty catalog, no connected server, ZERO upstream
    // transports (nothing token-less was ever constructed).
    expect(manager.getAllTools()).toEqual([])
    expect(manager.getConnectedServers()).toEqual([])
    expect(sdk.transports).toEqual([])
    // The server is registered connected-with-0-tools (same shape as an
    // oauth-user server with no live partition), not failed.
    expect(manager.status.get('remote-ctx')?.state).toBe('connected')
    expect(manager.status.get('remote-ctx')?.toolCount).toBe(0)
    // The gate DID probe control-api for the context grant (single source of truth).
    expect(existsCalls).toEqual([[{ mcpServerName: 'remote-ctx' }]])
  })

  // ── invariant 3, second half ──
  it('with a grant, opens an authenticated SHARED whose first tools/call sees no 401', async () => {
    const grantStore = new Set(['remote-ctx:']) // context grant present (no userId coordinate)
    const { manager } = gatedManager(grantStore)

    await expect(manager.addServer(remoteOauthContextServer())).resolves.toBe('applied')

    // The authenticated SHARED populated the catalog.
    expect(manager.getAllTools().map(t => t.name)).toEqual(['remote-ctx__do'])
    expect(sdk.transports).toHaveLength(1)
    expect(sdk.transports[0]!.requestHeaders['Authorization']).toBe('Bearer tok-ctx')

    // A first tool call over the SHARED carries the baked Bearer → no 401.
    const res = await manager.callTool('remote-ctx__do', {}, { userId: 'alice' })
    expect(res.isError).toBe(false)
    expect(sdk.toolCall401Count).toBe(0)
  })

  // ── invariant 4 ──
  it('a grant landing between polls makes the next addServer connect authenticated', async () => {
    let clock = 1_000
    const grantStore = new Set<string>()
    const { manager } = gatedManager(grantStore, {}, () => clock)

    // First poll: no grant → nothing opened, caches the absence for negativeTtlMs.
    await manager.addServer(remoteOauthContextServer())
    expect(manager.getAllTools()).toEqual([])
    expect(sdk.transports).toEqual([])

    // Grant lands; advance past the negative-cache TTL so discovery re-probes.
    grantStore.add('remote-ctx:')
    clock += 16_000

    await expect(manager.addServer(remoteOauthContextServer())).resolves.toBe('applied')
    expect(manager.getAllTools().map(t => t.name)).toEqual(['remote-ctx__do'])
    expect(sdk.transports).toHaveLength(1)
    expect(sdk.transports[0]!.requestHeaders['Authorization']).toBe('Bearer tok-ctx')
  })

  // ── invariant 17 (SHARED) ──
  it('kill-switch: without a grant, behaves exactly as today (token-less SHARED)', async () => {
    const grantStore = new Set<string>() // no grant
    const { manager, existsCalls } = gatedManager(grantStore, { enabled: false })

    await expect(manager.addServer(remoteOauthContextServer())).resolves.toBe('applied')

    // Legacy eager path: the lenient upstream accepts a token-less `initialize`,
    // so the SHARED is installed token-less and populates the catalog — the exact
    // pre-gate behavior the kill-switch must restore.
    expect(manager.getAllTools().map(t => t.name)).toEqual(['remote-ctx__do'])
    expect(sdk.transports).toHaveLength(1)
    expect(sdk.transports[0]!.requestHeaders['Authorization']).toBeUndefined()
    // The gate never engaged → no grant probe.
    expect(existsCalls).toEqual([])
  })

  // ── M10 fail-open: an indeterminate probe must NOT empty the catalog ──
  it('probe unknown (control-api 5xx) fails open: the SHARED connects as today', async () => {
    // Grant IS present at the mint; only the /grants/exists probe is broken.
    const grantStore = new Set(['remote-ctx:'])
    const { manager, existsCalls, failExistsWith } = gatedManager(grantStore)
    failExistsWith(500) // /grants/exists 5xx → probeOne resolves 'unknown'

    await expect(manager.addServer(remoteOauthContextServer())).resolves.toBe('applied')

    // Fail-open (invariant of availability): a down control-api must not empty
    // the catalog, so the SHARED opens exactly like today's eager path. Because
    // the grant is present at the mint, that connection authenticates.
    expect(manager.getAllTools().map(t => t.name)).toEqual(['remote-ctx__do'])
    expect(sdk.transports).toHaveLength(1)
    expect(sdk.transports[0]!.requestHeaders['Authorization']).toBe('Bearer tok-ctx')
    // The gate DID probe — it just could not get a definitive answer.
    expect(existsCalls).toEqual([[{ mcpServerName: 'remote-ctx' }]])
  })

  // ── Fix (coalesce): the bootstrap must not open a SECOND SHARED connection when
  //    a discovery poll landed one during the bootstrap's grant probe ──
  it('a bootstrap and a discovery poll racing the SHARED admission open ONE connection', async () => {
    let clock = 1_000
    const grantStore = new Set<string>() // starts without a grant
    const { deps, factory, existsCalls } = brokerWiring(grantStore)

    // Gate ONLY the bootstrap's probe so its SHARED coordinate stays in-flight in
    // the GrantProbe while a discovery poll races the same admission. The discovery
    // poll's probeOne then sees the coordinate in-flight → 'unknown' → fail-open,
    // opening the authenticated SHARED (connection #1). Releasing the bootstrap
    // probe drives it into admitSharedOauthContext for the SAME key: without the
    // admission-time re-check it opens a SECOND connection.
    let releaseProbe!: () => void
    const probeGate = new Promise<void>(r => (releaseProbe = r))
    let armed = false
    const checker: GrantExistenceChecker = async (queries, { timeoutMs }) => {
      if (armed) {
        armed = false
        await probeGate
      }
      return checkGrantExistence({ ...deps, timeoutMs }, queries)
    }
    const manager = new McpManager(undefined, undefined, factory, {
      grantExistence: checker,
      catalogBootstrap: bootstrapConfig(),
      now: () => clock,
    })

    // Register the server while it has no grant → awaiting-grant, no SHARED client.
    await manager.addServer(remoteOauthContextServer())
    expect(sdk.transports).toEqual([])
    // Grant lands; advance past the negative-cache TTL so the probe re-asks.
    grantStore.add('remote-ctx:')
    clock += 16_000

    // Bootstrap parks on the gated probe, holding the SHARED coordinate in-flight.
    armed = true
    const bootstrapPromise = manager.bootstrapUserCatalog('alice')

    // Discovery poll: fails open on the in-flight coordinate and opens connection #1.
    await expect(manager.addServer(remoteOauthContextServer())).resolves.toBe('applied')
    expect(sdk.transports).toHaveLength(1)

    // Release the bootstrap probe: it confirms the grant and reaches the SHARED
    // admission for the SAME key, which it must ADOPT rather than reopen.
    releaseProbe()
    await bootstrapPromise

    // ONE SHARED connection total (the observable §6.5 guarantees), authenticated.
    expect(sdk.transports).toHaveLength(1)
    expect(sdk.transports[0]!.requestHeaders['Authorization']).toBe('Bearer tok-ctx')
    expect(manager.getAllTools().map(t => t.name)).toEqual(['remote-ctx__do'])
    // The discovery poll coalesced onto the bootstrap's probe (no second POST).
    expect(existsCalls).toHaveLength(2) // addServer(no-grant) + bootstrap; discovery deduped
  })

  // ── Fix 1: detach must clear the awaiting-grant set (no leak / no log suppression) ──
  it('detach clears awaiting-grant so a later re-add re-logs the entered transition', async () => {
    const grantStore = new Set<string>() // no grant → the server stays awaiting
    const { manager } = gatedManager(grantStore)
    const infoSpy = vi.spyOn(logger, 'info')

    // First registration enters the awaiting-grant state (logs 'entered').
    await manager.addServer(remoteOauthContextServer())
    // Detach must remove the server from the awaiting-grant set.
    await manager.removeServer('remote-ctx')
    // A fresh registration of the same server, still without a grant, must be a
    // genuine transition again — the 'entered' log fires a SECOND time. With the
    // leak it stayed in the set and the second log was suppressed.
    await manager.addServer(remoteOauthContextServer())

    const enteredLogs = infoSpy.mock.calls.filter(
      ([fields]) => fields.event === 'mcp_oauth_shared_awaiting_grant' && fields.state === 'entered'
    )
    expect(enteredLogs).toHaveLength(2)

    infoSpy.mockRestore()
  })
})
