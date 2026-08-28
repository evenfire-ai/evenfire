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
import type { BrokerTokenProviderDeps } from '../brokerTokenProvider'
import { createBrokerTokenProvider } from '../brokerTokenProvider'
import type { McpTokenProvider } from '../client'
import {
  type GrantExistsResult,
  buildGrantExistenceQueries,
  checkGrantExistence,
  selectRevokedPartitionKeys,
} from '../grantExistenceClient'
import {
  type LiveOAuthPartition,
  McpManager,
  type McpPrincipal,
  type McpTokenProviderFactory,
  serializeClientKey,
  userPrincipal,
} from '../manager'

// ─── transport-aware SDK mock (Bearer presence drives the 401) ────────────────

interface MockTransport {
  requestHeaders: Record<string, string>
  close: ReturnType<typeof vi.fn>
}
const sdk: {
  transports: MockTransport[]
  callToolImpl: ((auth: string) => Promise<unknown>) | null
} = { transports: [], callToolImpl: null }

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    private transport: MockTransport | null = null
    connect = vi.fn(async (t: MockTransport) => {
      this.transport = t
    })
    close = vi.fn().mockResolvedValue(undefined)
    listTools = vi.fn(async () => ({
      tools: [{ name: 'do', description: 'demo tool', inputSchema: { type: 'object' } }],
    }))
    callTool = vi.fn(async () => {
      const auth = this.transport?.requestHeaders?.['Authorization']
      // No Bearer models "no grant → no token"; the server rejects with 401.
      if (!auth) {
        const err = new Error('http 401') as Error & { code: number }
        err.code = 401
        throw err
      }
      if (sdk.callToolImpl) return sdk.callToolImpl(auth)
      return { content: [{ type: 'text', text: 'ok' }], authorization: auth }
    })
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamable {
    requestHeaders: Record<string, string>
    close = vi.fn().mockResolvedValue(undefined)
    constructor(_url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) {
      this.requestHeaders = opts?.requestInit?.headers ?? {}
      sdk.transports.push(this as unknown as MockTransport)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSSE {
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

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

/**
 * A single fake `fetch` for both broker endpoints, reading a shared grant store.
 * `/user-token` mints while the grant exists (404 otherwise); `/grants/exists`
 * echoes the query coordinates and reports existence from the SAME store — the
 * control-api response shape reproduced faithfully.
 */
function brokerWiring(grantStore: Set<string>): {
  deps: BrokerTokenProviderDeps
  factory: McpTokenProviderFactory
  existsCalls: Array<Array<{ mcpServerName: string; userId?: string }>>
  failExistsWith?: (status: number) => void
} {
  const existsCalls: Array<Array<{ mcpServerName: string; userId?: string }>> = []
  let existsStatus = 200
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    if (url.endsWith('/api/v1/mcp-oauth/user-token')) {
      const has = grantStore.has(`${body.mcpServerName}:${body.userId ?? ''}`)
      return (has
        ? {
            status: 200,
            json: async () => ({ token: `tok-${body.userId ?? 'ctx'}`, expiresAt: null }),
          }
        : { status: 404, json: async () => ({ error: 'no_grant' }) }) as unknown as Response
    }
    if (url.endsWith('/api/v1/mcp-oauth/grants/exists')) {
      existsCalls.push(body.queries)
      if (existsStatus !== 200) {
        return {
          status: existsStatus,
          json: async () => ({ error: 'boom' }),
        } as unknown as Response
      }
      const results: GrantExistsResult[] = body.queries.map(
        (q: { mcpServerName: string; userId?: string }) => ({
          mcpServerName: q.mcpServerName,
          ...(q.userId !== undefined ? { userId: q.userId } : {}),
          exists: grantStore.has(`${q.mcpServerName}:${q.userId ?? ''}`),
        })
      )
      return { status: 200, json: async () => ({ results }) } as unknown as Response
    }
    throw new Error(`unexpected url ${url}`)
  })
  const deps: BrokerTokenProviderDeps = {
    gatewayUrl: () => 'http://gw:8092',
    controlToken: () => 'ctl',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  }
  const factory: McpTokenProviderFactory = (
    server: McpServerInfo,
    principal: McpPrincipal
  ): McpTokenProvider => {
    if (server.authKind === 'oauth-context') {
      return createBrokerTokenProvider(server, {}, deps)
    }
    if (server.authKind === 'oauth-user' && principal.kind === 'user') {
      return createBrokerTokenProvider(server, { userId: principal.userId }, deps)
    }
    return { resolve: async () => undefined, refresh: async () => undefined }
  }
  return { deps, factory, existsCalls, failExistsWith: (s: number) => (existsStatus = s) }
}

/** The sweep exactly as main.ts wires it (no duplicated decision logic). */
async function sweepOnce(manager: McpManager, deps: BrokerTokenProviderDeps): Promise<number> {
  const partitions = manager.listLiveOAuthPartitions()
  if (partitions.length === 0) return 0
  const results = await checkGrantExistence(deps, buildGrantExistenceQueries(partitions))
  return manager.evictRevokedPartitions(selectRevokedPartitionKeys(partitions, results))
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
