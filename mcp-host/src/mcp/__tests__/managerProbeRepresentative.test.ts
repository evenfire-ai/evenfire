/**
 * R4-M2 — platform heartbeat probes must never spend a user's OAuth token.
 *
 * `refreshAllServerStatus()` is the background platform heartbeat: it calls
 * `client.probeTools()`, a REAL network round-trip (tools/list). It must probe
 * ONLY the SHARED partition (`probeRepresentativeClient`), never fall back to a
 * per-user partition — otherwise a platform probe rides a user's OAuth
 * connection and spends that user's identity/quota.
 *
 * The pathological state pinned here: an oauth-user server whose SHARED
 * representative is gone but a per-user partition is still alive. Under the old
 * `representativeClient` fallback the heartbeat would probe the per-user
 * connection. This test asserts the OBSERVABLE (T4): the probe carrying the
 * user's Bearer is never issued, and the server does not count as `succeeded`.
 *
 * Fixtures are derived from the real producers (McpManager + the real McpClient
 * over a mocked SDK, the same wiring managerPartition.test.ts uses) — the
 * pathological state is reached with real manager APIs (callTool to admit the
 * per-user partition, evictRevokedPartitions to drop the SHARED key), never a
 * hand-built internal-map fixture.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerInfo } from '../../types'
import type { McpTokenProvider } from '../client'
import {
  McpManager,
  type McpPrincipal,
  type McpTokenProviderFactory,
  SHARED_PRINCIPAL,
  serializeClientKey,
} from '../manager'

// ─── SDK mocks (constructable; capture per-transport headers) ────────────────
//
// probeTools() issues `client.request({ method: 'tools/list' }, …)` — NOT
// Client.listTools(). So the observable of "which connection was probed" is the
// Authorization header on the transport of each `request` call. Connect-time
// tool discovery uses Client.listTools(), kept separate so setup probes don't
// pollute `probeAuth`.

interface MockTransport {
  requestHeaders: Record<string, string>
  close: ReturnType<typeof vi.fn>
}

const sdk: {
  transports: MockTransport[]
  /** Authorization header of every probe (`request` tools/list) call, in order. */
  probeAuth: Array<string | undefined>
} = { transports: [], probeAuth: [] }

const TOOLS_RESULT = {
  tools: [{ name: 'do', description: 'demo tool', inputSchema: { type: 'object' } }],
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    private transport: MockTransport | null = null
    connect = vi.fn(async (t: MockTransport) => {
      this.transport = t
    })
    close = vi.fn().mockResolvedValue(undefined)
    // Connect-time discovery (refreshTools → Client.listTools()).
    listTools = vi.fn(async () => TOOLS_RESULT)
    // Platform probe (probeTools → client.request tools/list). Records the auth
    // header so the test can see WHICH connection the heartbeat probed.
    request = vi.fn(async () => {
      const headers = this.transport?.requestHeaders ?? {}
      sdk.probeAuth.push(headers['Authorization'])
      return TOOLS_RESULT
    })
    callTool = vi.fn(async () => {
      const headers = this.transport?.requestHeaders ?? {}
      return { content: [{ type: 'text', text: 'ok' }], authorization: headers['Authorization'] }
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function oauthUserServer(name = 'gh'): McpServerInfo {
  return {
    name,
    contextRef: 'ctx-1',
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

/** oauth-user factory: per-user principals get a per-user Bearer; the SHARED
 *  representative is token-less (catalog population, no grant). Mirrors main.ts
 *  createMcpTokenProviderFactory grantScope='user'. */
function userFactory(): McpTokenProviderFactory {
  return (server: McpServerInfo, principal: McpPrincipal): McpTokenProvider => {
    if (principal.kind === 'shared') {
      return { resolve: async () => undefined, refresh: async () => undefined }
    }
    const token = `token-for-${principal.userId}`
    return { resolve: async () => token, refresh: async () => token }
  }
}

/** oauth-context factory: even the SHARED representative carries the context
 *  Bearer (grantScope='context'). */
function contextFactory(): McpTokenProviderFactory {
  return () => ({ resolve: async () => 'context-bearer', refresh: async () => 'context-bearer' })
}

beforeEach(() => {
  sdk.transports = []
  sdk.probeAuth = []
})

// ─── R4-M2 · pathological: SHARED down + per-user alive → NOT probed ──────────

describe('refreshAllServerStatus never probes a per-user partition (R4-M2)', () => {
  it('an oauth-user server with only a per-user partition alive is not probed and not counted', async () => {
    const manager = new McpManager(undefined, undefined, userFactory())
    await manager.addServer(oauthUserServer()) // SHARED representative (token-less)
    await manager.callTool('gh__do', {}, { userId: 'alice' }) // per-user partition (alice)

    // Reach the pathological state via a real manager API: drop ONLY the SHARED
    // partition, leaving alice's per-user partition live. representativeClient
    // would now fall back to alice's client; probeRepresentativeClient must not.
    const evicted = manager.evictRevokedPartitions([serializeClientKey('gh', SHARED_PRINCIPAL)])
    expect(evicted).toBe(1)
    // The server is still known (alice's partition keeps 'gh' in the index).
    expect(manager.getConnectedServers()).toEqual(['gh'])

    sdk.probeAuth = [] // only observe probes issued by the heartbeat below.
    const summary = await manager.refreshAllServerStatus()

    // Observable (T4): the heartbeat issued NO probe on alice's connection —
    // her OAuth Bearer never left the host for a platform probe.
    expect(sdk.probeAuth).not.toContain('Bearer token-for-alice')
    // And this server, having no SHARED representative, is not probed at all,
    // so it contributes nothing to the round's tally.
    expect(sdk.probeAuth).toEqual([])
    expect(summary.serverCount).toBe(0)
    expect(summary.succeeded).toBe(0)
  })

  // ─── control: SHARED alive IS still probed (normal path unbroken) ──────────

  it('an oauth-context server with a live SHARED partition is still probed', async () => {
    const manager = new McpManager(undefined, undefined, contextFactory())
    await manager.addServer(oauthContextServer()) // SHARED partition (context Bearer)

    sdk.probeAuth = []
    const summary = await manager.refreshAllServerStatus()

    // The SHARED connection was probed on the context Bearer, and counts.
    expect(sdk.probeAuth).toContain('Bearer context-bearer')
    expect(summary.serverCount).toBe(1)
    expect(summary.succeeded).toBe(1)
  })
})
