/**
 * T3 regression (mini-spec 13 §6) — hot revocation of an OAuth grant must cut a
 * LIVE per-user partition.
 *
 * Invariant pinned (T5, written before the implementation): after the grant is
 * deleted, running the grant-sweep evicts the per-user partition and the NEXT
 * tool call does NOT reach the server — it surfaces `connect_required`.
 *
 * Runnable against the PARENT head (4fc33594), where the sweep does not exist:
 *  - imports ONLY symbols present at the parent (no grantExistenceClient, no
 *    listLiveOAuthPartitions), so the setup compiles and runs there;
 *  - the eviction goes through `manager.evictRevokedPartitions?.(...)` — optional
 *    so a parent lacking the method NO-OPS instead of throwing in setup.
 * At the parent the partition therefore survives, the next call reuses its baked
 * Bearer and succeeds, and the `connect_required` assertion FAILS (the whole
 * point of T3). With the fix, the partition is evicted, the re-admission finds
 * no grant (404 → token-less → 401), and `connect_required` is surfaced.
 *
 * The observable asserted is the tool-call RESULT (T4), not "evictPartition was
 * called". The `exists:false` decision is derived from the SAME grant store the
 * token mint reads (T1: not an independently hand-set boolean).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerInfo } from '../../types'
import { createBrokerTokenProvider } from '../brokerTokenProvider'
import type { McpTokenProvider } from '../client'
import {
  McpManager,
  type McpPrincipal,
  type McpTokenProviderFactory,
  serializeClientKey,
  userPrincipal,
} from '../manager'

// ─── SDK mocks: callTool 401s when the current transport carries no Bearer ─────
// A missing Authorization models "no grant → no token → the server rejects". The
// 401 is thus a CONSEQUENCE of the revoked grant, not a scripted queue entry.

interface MockTransport {
  requestHeaders: Record<string, string>
  close: ReturnType<typeof vi.fn>
}

const sdk: { transports: MockTransport[] } = { transports: [] }

function http401(): Error & { code: number } {
  const err = new Error('http 401') as Error & { code: number }
  err.code = 401
  return err
}

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
      if (!auth) throw http401()
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

function oauthUserServer(name = 'gh'): McpServerInfo {
  return {
    name,
    transport: { type: 'streamableHttp', url: `http://${name}/mcp` },
    authKind: 'oauth-user',
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

beforeEach(() => {
  sdk.transports = []
})

describe('T3 — grant-sweep cuts a live per-user partition (surfaces connect_required)', () => {
  it('after the grant is deleted, the swept partition re-admits token-less and 401s', async () => {
    // Grant store keyed by (server, userId) — the SAME source the token mint and
    // the (simulated here) existence check derive from.
    const grantStore = new Set<string>(['gh:alice'])

    // REAL broker token provider, only the network fetch is stubbed. Returns a
    // token while the grant exists, 404 no_grant once it is deleted.
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { mcpServerName: string; userId?: string }
      const has = grantStore.has(`${body.mcpServerName}:${body.userId ?? ''}`)
      return (has
        ? { status: 200, json: async () => ({ token: `tok-${body.userId}`, expiresAt: null }) }
        : { status: 404, json: async () => ({ error: 'no_grant' }) }) as unknown as Response
    })

    const factory: McpTokenProviderFactory = (
      server: McpServerInfo,
      principal: McpPrincipal
    ): McpTokenProvider =>
      principal.kind === 'user'
        ? createBrokerTokenProvider(
            server,
            { userId: principal.userId },
            {
              gatewayUrl: () => 'http://gw:8092',
              controlToken: () => 'ctl',
              fetchImpl: fetchImpl as unknown as typeof fetch,
            }
          )
        : { resolve: async () => undefined, refresh: async () => undefined }

    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer('gh'))

    // Alice's partition admitted while the grant exists → the call succeeds.
    const first = await manager.callTool('gh__do', {}, { userId: 'alice' })
    expect(first.isError).toBe(false)

    // Revoke the grant (deleteOAuthGrant semantics), then run the sweep. The key
    // is computed with the same serializer the manager uses; `exists:false` is
    // read off the shared grant store (alice's entry is now gone).
    grantStore.delete('gh:alice')
    const aliceKey = serializeClientKey('gh', userPrincipal('alice'))

    // Optional so the PARENT (no such method) no-ops here instead of throwing in
    // setup; with the fix it evicts the revoked partition.
    const evict = (manager as { evictRevokedPartitions?: (keys: string[]) => number })
      .evictRevokedPartitions
    const swept = evict ? evict.call(manager, [aliceKey]) : 0

    // Observable end-state: the next call re-admits, finds no grant, and 401s →
    // connect_required. On the parent, `swept === 0`, the partition survives, the
    // baked Bearer is reused and the call succeeds → this assertion FAILS.
    const second = await manager.callTool('gh__do', {}, { userId: 'alice' })
    expect(second.isError).toBe(true)
    expect(second.connectRequired).toEqual({ mcpServerName: 'gh' })

    // Sanity for the fixed run (a no-op assertion on the parent path).
    if (evict) expect(swept).toBe(1)
  })
})
