/**
 * Hot-revocation grant-sweep (mini-spec 13 §4). Covers, with the REAL manager +
 * REAL grant-existence client (only the network fetch is stubbed):
 *  - the decision table §4.2, one case per row:
 *      exists:true            → conserve
 *      exists:false + idle    → evict
 *      exists:false + in-flight → skip this tick, evict once it drains
 *      oauth-context SHARED   → swept like a per-user partition
 *      transient 5xx          → fail-OPEN, conserve everything
 *      static/none            → not a candidate (never queried)
 *  - `listLiveOAuthPartitions` exposure (skips the token-less oauth-user
 *    representative, includes the oauth-context SHARED partition);
 *  - the client: `checkGrantExistence` (200 / refresh-on-401 / non-200 throws /
 *    unconfigured throws) and `selectRevokedPartitionKeys` correlation by
 *    coordinate (not position).
 *
 * The `exists` fixtures are derived from the SAME grant store the token mint
 * reads (T1: never an independently hand-set boolean), and the response shape
 * mirrors control-api's echo-the-coordinates contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerInfo } from '../../types'
import {
  type GrantExistsResult,
  checkGrantExistence,
  selectRevokedPartitionKeys,
} from '../grantExistenceClient'
import type { GrantExistenceChecker, McpCatalogBootstrapConfig } from '../grantProbe'
import { type LiveOAuthPartition, McpManager, serializeClientKey, userPrincipal } from '../manager'
import { type RemoteUpstreamState, brokerWiring, sweepOnce } from './helpers/brokerWiring'

/** Bootstrap config for the inv-18 sweep case (values are irrelevant to the sweep). */
function sweepBootstrapConfig(): McpCatalogBootstrapConfig {
  return {
    enabled: true,
    waitBudgetMs: 4000,
    probeTimeoutMs: 2000,
    connectTimeoutMs: 8000,
    negativeTtlMs: 15000,
    failureTtlMs: 60000,
    probesPerMin: 20,
    backoffMs: 30000,
  }
}

// ─── transport-aware SDK mock (Bearer presence drives the 401) ────────────────
// The lenient upstream (accepts initialize token-less, 401s at tools/call) and
// the broker+exists wiring both come from the shared helper (T1: one source of
// truth). The state is a plain literal in a synchronous vi.hoisted; each vi.mock
// factory dynamically imports the builder — a factory runs before the file's
// static imports resolve, so it cannot reference them directly.
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

// ─── fixtures ─────────────────────────────────────────────────────────────────

function oauthUserServer(name = 'gh'): McpServerInfo {
  return {
    name,
    transport: { type: 'streamableHttp', url: `http://${name}/mcp` },
    authKind: 'oauth-user',
    enabled: true,
    status: { deployed: true, ready: true },
  }
}
function oauthContextServer(name = 'ctx-gh'): McpServerInfo {
  return {
    name,
    contextRef: 'ctx-1',
    transport: { type: 'streamableHttp', url: `http://${name}/mcp` },
    authKind: 'oauth-context',
    enabled: true,
    status: { deployed: true, ready: true },
  }
}
function staticServer(name = 'airtable'): McpServerInfo {
  return {
    name,
    transport: { type: 'streamableHttp', url: `http://${name}/mcp` },
    authKind: 'static',
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

beforeEach(() => {
  sdk.transports = []
  sdk.callToolImpl = null
})

// ─── decision table §4.2 ─────────────────────────────────────────────────────

describe('grant-sweep decision table (mini-spec 13 §4.2)', () => {
  it('exists:true → conserves the partition', async () => {
    const grantStore = new Set(['gh:alice'])
    const { deps, factory } = brokerWiring(grantStore)
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer('gh'))
    await manager.callTool('gh__do', {}, { userId: 'alice' })

    expect(await sweepOnce(manager, deps)).toBe(0)
    // Still usable — the baked Bearer is intact.
    const again = await manager.callTool('gh__do', {}, { userId: 'alice' })
    expect(again.isError).toBe(false)
  })

  it('exists:false + not in-flight → evicts now', async () => {
    const grantStore = new Set(['gh:alice', 'gh:bob'])
    const { deps, factory } = brokerWiring(grantStore)
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer('gh'))
    await manager.callTool('gh__do', {}, { userId: 'alice' })
    await manager.callTool('gh__do', {}, { userId: 'bob' })

    grantStore.delete('gh:alice') // only alice revoked
    expect(await sweepOnce(manager, deps)).toBe(1)

    // alice re-admits token-less → connect_required; bob still works.
    const a = await manager.callTool('gh__do', {}, { userId: 'alice' })
    expect(a.connectRequired).toEqual({ mcpServerName: 'gh' })
    const b = await manager.callTool('gh__do', {}, { userId: 'bob' })
    expect(b.isError).toBe(false)
  })

  it('exists:false + in-flight → skipped this tick, evicted once it drains', async () => {
    const grantStore = new Set(['gh:alice'])
    const { deps, factory } = brokerWiring(grantStore)
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer('gh'))

    // Hold alice's call open. `entered` fires only once the call is actually
    // inside client.callTool — i.e. AFTER the manager registered its in-flight
    // token — so the sweep below races nothing.
    let enter!: () => void
    const entered = new Promise<void>(r => (enter = r))
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    sdk.callToolImpl = async () => {
      enter()
      await gate
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    const inFlight = manager.callTool('gh__do', {}, { userId: 'alice' })
    await entered

    grantStore.delete('gh:alice')
    // In-flight → the sweep must NOT evict it.
    expect(await sweepOnce(manager, deps)).toBe(0)
    expect(manager.getConnectedServers()).toEqual(['gh'])

    // Release the call; the partition is now drained.
    release()
    await inFlight
    sdk.callToolImpl = null

    // Next sweep evicts it, and the following call surfaces connect_required.
    expect(await sweepOnce(manager, deps)).toBe(1)
    const after = await manager.callTool('gh__do', {}, { userId: 'alice' })
    expect(after.connectRequired).toEqual({ mcpServerName: 'gh' })
  })

  it('oauth-context SHARED + in-flight → skipped this tick, evicted once it drains', async () => {
    const grantStore = new Set(['ctx-gh:'])
    const { deps, factory } = brokerWiring(grantStore)
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthContextServer('ctx-gh'))

    // Hold a call open on the SHARED partition. `entered` fires only once the
    // call is inside client.callTool — after the manager registered its in-flight
    // token for the SHARED key.
    let enter!: () => void
    const entered = new Promise<void>(r => (enter = r))
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    sdk.callToolImpl = async () => {
      enter()
      await gate
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    const inFlight = manager.callTool('ctx-gh__do', {}, { userId: 'alice' })
    await entered

    grantStore.delete('ctx-gh:')
    // In-flight over the SHARED → the grant-sweep must NOT close it mid-call.
    expect(await sweepOnce(manager, deps)).toBe(0)
    expect(manager.getConnectedServers()).toEqual(['ctx-gh'])

    // Drain the call, then the next sweep evicts the SHARED partition.
    release()
    await inFlight
    sdk.callToolImpl = null
    expect(await sweepOnce(manager, deps)).toBe(1)
    expect(manager.getConnectedServers()).toEqual([])
  })

  it('oauth-context SHARED partition is swept like a per-user one', async () => {
    const grantStore = new Set(['ctx-gh:']) // context grant, no userId coordinate
    const { deps, factory, existsCalls } = brokerWiring(grantStore)
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthContextServer('ctx-gh'))
    // The SHARED partition connects with the context token.
    const first = await manager.callTool('ctx-gh__do', {}, { userId: 'alice' })
    expect(first.isError).toBe(false)

    grantStore.delete('ctx-gh:')
    expect(await sweepOnce(manager, deps)).toBe(1)
    // The query carried NO userId (context identity stays server-side).
    expect(existsCalls.at(-1)).toEqual([{ mcpServerName: 'ctx-gh' }])
    // The server is no longer connected (SHARED evicted).
    expect(manager.getConnectedServers()).toEqual([])
  })

  it('transient 5xx → fail-OPEN: nothing is evicted', async () => {
    const grantStore = new Set(['gh:alice'])
    const { deps, factory, failExistsWith } = brokerWiring(grantStore)
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer('gh'))
    await manager.callTool('gh__do', {}, { userId: 'alice' })

    grantStore.delete('gh:alice') // grant IS gone, but the check errors
    failExistsWith?.(503)

    // main.ts catches this throw and conserves; here we prove the client throws
    // BEFORE any eviction and the partition is left intact.
    await expect(sweepOnce(manager, deps)).rejects.toThrow(/503/)
    expect(manager.getConnectedServers()).toEqual(['gh'])
    // Still serving on the baked Bearer (conserved).
    const still = await manager.callTool('gh__do', {}, { userId: 'alice' })
    expect(still.isError).toBe(false)
  })

  it('static/none servers are never candidates (no query, no eviction)', async () => {
    const grantStore = new Set<string>()
    const { deps, factory, existsCalls } = brokerWiring(grantStore)
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(staticServer('airtable'))
    // A static server has a SHARED connection via the eager path (token-less here).
    expect(manager.listLiveOAuthPartitions()).toEqual([])
    expect(await sweepOnce(manager, deps)).toBe(0)
    expect(existsCalls).toEqual([]) // never queried
  })
})

// ─── listLiveOAuthPartitions exposure ────────────────────────────────────────

describe('listLiveOAuthPartitions', () => {
  it('exposes per-user partitions but not the token-less oauth-user representative', async () => {
    const grantStore = new Set(['gh:alice', 'gh:bob'])
    const { factory } = brokerWiring(grantStore)
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer('gh'))
    await manager.callTool('gh__do', {}, { userId: 'alice' })
    await manager.callTool('gh__do', {}, { userId: 'bob' })

    const live = manager.listLiveOAuthPartitions()
    // Only the two per-user partitions; the SHARED representative is excluded.
    expect(live).toHaveLength(2)
    expect(live.every(p => p.flavor === 'oauth-user' && p.serverName === 'gh')).toBe(true)
    expect(live.map(p => p.userId).sort()).toEqual(['alice', 'bob'])
    expect(live.map(p => p.key).sort()).toEqual(
      [
        serializeClientKey('gh', userPrincipal('alice')),
        serializeClientKey('gh', userPrincipal('bob')),
      ].sort()
    )
  })

  it('exposes the oauth-context SHARED partition (no userId)', async () => {
    const grantStore = new Set(['ctx-gh:'])
    const { factory } = brokerWiring(grantStore)
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthContextServer('ctx-gh'))
    await manager.callTool('ctx-gh__do', {}, { userId: 'alice' })

    const live = manager.listLiveOAuthPartitions()
    expect(live).toEqual([
      {
        flavor: 'oauth-context',
        serverName: 'ctx-gh',
        key: serializeClientKey('ctx-gh', { kind: 'shared' }),
      },
    ])
  })

  // ── invariant 18: a bootstrapped partition is a full-fledged sweep subject ──
  it('a bootstrapped partition appears in the sweep and is evicted on exists:false', async () => {
    const grantStore = new Set(['gh:alice'])
    const { deps, factory } = brokerWiring(grantStore)
    const grantExistence: GrantExistenceChecker = (queries, { timeoutMs }) =>
      checkGrantExistence({ ...deps, timeoutMs }, queries)
    const manager = new McpManager(undefined, undefined, factory, {
      grantExistence,
      catalogBootstrap: sweepBootstrapConfig(),
    })
    // The bootstrap only considers REMOTE oauth servers (M1/M2).
    await manager.addServer({ ...oauthUserServer('gh'), remote: true })

    // No prior callTool: the partition is opened by the bootstrap alone.
    const summary = await manager.bootstrapUserCatalog('alice')
    expect(summary.admitted).toBe(1)

    // It is exposed to the sweep exactly like a lazily-admitted partition.
    const live = manager.listLiveOAuthPartitions()
    expect(live).toEqual([
      {
        flavor: 'oauth-user',
        serverName: 'gh',
        userId: 'alice',
        key: serializeClientKey('gh', userPrincipal('alice')),
      },
    ])

    // Revoke the grant → the sweep evicts the bootstrapped partition.
    grantStore.delete('gh:alice')
    expect(await sweepOnce(manager, deps)).toBe(1)
    expect(manager.listLiveOAuthPartitions()).toEqual([])
  })
})

// ─── client unit tests ───────────────────────────────────────────────────────

function res(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

describe('checkGrantExistence', () => {
  it('returns the results array on 200', async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, { results: [{ mcpServerName: 'gh', userId: 'alice', exists: false }] })
    )
    const out = await checkGrantExistence(
      {
        gatewayUrl: () => 'http://gw',
        controlToken: () => 'ctl',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      [{ mcpServerName: 'gh', userId: 'alice' }]
    )
    expect(out).toEqual([{ mcpServerName: 'gh', userId: 'alice', exists: false }])
  })

  it('refreshes the control token once on 401 and retries', async () => {
    let token = 'stale'
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const bearer = (init.headers as Record<string, string>).Authorization
      return bearer === 'Bearer stale' ? res(401, {}) : res(200, { results: [] })
    })
    const refreshControlToken = vi.fn(async () => {
      token = 'fresh'
    })
    const out = await checkGrantExistence(
      {
        gatewayUrl: () => 'http://gw',
        controlToken: () => token,
        refreshControlToken,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      [{ mcpServerName: 'gh', userId: 'alice' }]
    )
    expect(refreshControlToken).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(out).toEqual([])
  })

  it('throws on a non-200 (fail-open at the caller)', async () => {
    const fetchImpl = vi.fn(async () => res(403, {}))
    await expect(
      checkGrantExistence(
        {
          gatewayUrl: () => 'http://gw',
          controlToken: () => 'ctl',
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        [{ mcpServerName: 'gh' }]
      )
    ).rejects.toThrow(/403/)
  })

  it('throws when the gateway URL is unconfigured', async () => {
    await expect(
      checkGrantExistence({ gatewayUrl: () => undefined, controlToken: () => 'ctl' }, [
        { mcpServerName: 'gh' },
      ])
    ).rejects.toThrow(/gateway/i)
  })

  it('returns [] without any fetch when there are no queries', async () => {
    const fetchImpl = vi.fn()
    const out = await checkGrantExistence(
      {
        gatewayUrl: () => 'http://gw',
        controlToken: () => 'ctl',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      []
    )
    expect(out).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('selectRevokedPartitionKeys — correlation by coordinate, not position', () => {
  it('picks only the revoked coordinate even when results are reordered', () => {
    const partitions: LiveOAuthPartition[] = [
      { flavor: 'oauth-user', serverName: 'gh', userId: 'alice', key: 'KEY-A' },
      { flavor: 'oauth-user', serverName: 'gh', userId: 'bob', key: 'KEY-B' },
      { flavor: 'oauth-context', serverName: 'ctx', key: 'KEY-CTX' },
    ]
    // Results out of order; only bob and the context grant are gone.
    const results: GrantExistsResult[] = [
      { mcpServerName: 'ctx', exists: false },
      { mcpServerName: 'gh', userId: 'alice', exists: true },
      { mcpServerName: 'gh', userId: 'bob', exists: false },
    ]
    expect(selectRevokedPartitionKeys(partitions, results).sort()).toEqual(['KEY-B', 'KEY-CTX'])
  })

  it('a missing/non-false exists conserves (fail-open)', () => {
    const partitions: LiveOAuthPartition[] = [
      { flavor: 'oauth-user', serverName: 'gh', userId: 'alice', key: 'KEY-A' },
    ]
    // A malformed entry without a boolean `exists` must NOT evict.
    const results = [{ mcpServerName: 'gh', userId: 'alice' }] as unknown as GrantExistsResult[]
    expect(selectRevokedPartitionKeys(partitions, results)).toEqual([])
  })
})
