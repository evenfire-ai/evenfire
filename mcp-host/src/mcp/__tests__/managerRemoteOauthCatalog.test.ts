/**
 * Mini-spec 19 §D-6 / C4.1 — remote+oauth catalog is AUTHENTICATED, never
 * token-less; the platform heartbeat never probes a remote+oauth representative.
 *
 * A spec-compliant remote MCP server (Slack/Notion) 401s already at
 * `initialize`, so the token-less SHARED representative that seeds a LOCAL
 * catalog cannot seed a remote one. These tests pin the observable outcomes
 * (T4): which connection populated the catalog (its Authorization header),
 * whether any token-less connection was opened, and whether the heartbeat issued
 * a probe.
 *
 * Fixtures are derived from the real producers (McpManager + the real McpClient
 * over a mocked SDK, the same wiring managerProbeRepresentative.test.ts uses).
 * The pathological/authenticated states are reached with real manager APIs
 * (addServer / callTool / refreshAllServerStatus), never a hand-built map.
 *
 * The SDK Client mock models a spec-compliant remote: a token-less request to an
 * https target 401s at `initialize`. `core/net/ssrf` is mocked to a public no-op
 * here (its real behavior is covered by clientRemoteTarget.test.ts) so these
 * tests never touch DNS.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerInfo } from '../../types'
import type { McpTokenProvider } from '../client'
import { McpManager, type McpPrincipal, type McpTokenProviderFactory } from '../manager'

interface MockTransport {
  url: string
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

class RemoteAuthRequired extends Error {
  readonly code = 401
  constructor() {
    super('initialize returned 401')
    this.name = 'RemoteAuthRequired'
  }
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    private transport: MockTransport | null = null
    connect = vi.fn(async (t: MockTransport) => {
      // Spec-compliant remote: a token-less request to an https target 401s at
      // `initialize`. Local (http) targets serve initialize unauthenticated.
      if (t.url.startsWith('https:') && !t.requestHeaders['Authorization']) {
        throw new RemoteAuthRequired()
      }
      this.transport = t
    })
    close = vi.fn().mockResolvedValue(undefined)
    listTools = vi.fn(async () => TOOLS_RESULT)
    request = vi.fn(async () => {
      const headers = this.transport?.requestHeaders ?? {}
      sdk.probeAuth.push(headers['Authorization'])
      return TOOLS_RESULT
    })
    callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamable {
    url: string
    requestHeaders: Record<string, string>
    close = vi.fn().mockResolvedValue(undefined)
    constructor(url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) {
      this.url = url.toString()
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

// Neutralize the SSRF guard for the catalog/heartbeat tests — the real guard is
// exercised in clientRemoteTarget.test.ts. Here it must never touch DNS.
vi.mock('../../core/net/ssrf', () => ({
  SsrfBlockedError: class SsrfBlockedError extends Error {},
  resolvePinnedPublicIp: vi.fn(async () => '203.0.113.10'),
}))

// ─── Fixtures ────────────────────────────────────────────────────────────────

function remoteOauthUserServer(name = 'remote-gh'): McpServerInfo {
  return {
    name,
    transport: { type: 'streamableHttp', url: `https://${name}.example.com/mcp` },
    authKind: 'oauth-user',
    remote: true,
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

function remoteOauthContextServer(name = 'remote-ctx'): McpServerInfo {
  return {
    name,
    transport: { type: 'streamableHttp', url: `https://${name}.example.com/mcp` },
    authKind: 'oauth-context',
    remote: true,
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

function userFactory(): McpTokenProviderFactory {
  return (_server: McpServerInfo, principal: McpPrincipal): McpTokenProvider => {
    if (principal.kind === 'shared') {
      return { resolve: async () => undefined, refresh: async () => undefined }
    }
    const token = `token-for-${principal.userId}`
    return { resolve: async () => token, refresh: async () => token }
  }
}

function contextFactory(): McpTokenProviderFactory {
  return () => ({ resolve: async () => 'context-bearer', refresh: async () => 'context-bearer' })
}

beforeEach(() => {
  sdk.transports = []
  sdk.probeAuth = []
})

// ─── (a) T3 canonical (spec §7): 401-at-initialize resolved by authenticated catalog ──

describe('remote oauth-user catalog is authenticated per-user, never token-less (a)', () => {
  it('opens no token-less SHARED representative and populates the catalog with a user Bearer', async () => {
    const manager = new McpManager(undefined, undefined, userFactory())
    // Against the parent, addServer eagerly opens a token-less SHARED
    // representative that 401s at `initialize` and REJECTS — asserting it
    // resolves turns that defect into a clean assertion failure (T3).
    await expect(manager.addServer(remoteOauthUserServer())).resolves.toBe('applied')

    // No token-less SHARED representative was opened.
    expect(sdk.transports).toEqual([])
    expect(manager.status.get('remote-gh')?.state).toBe('connected')
    // Per-user catalog: empty until a user with a live grant connects.
    expect(manager.getAllTools()).toEqual([])

    // A user's tool call admits an AUTHENTICATED per-user partition whose
    // `initialize`/tools/list carry the Bearer → the catalog is populated.
    const res = await manager.callTool('remote-gh__do', {}, { userId: 'alice' })
    expect(res.isError).toBe(false)
    expect(sdk.transports).toHaveLength(1)
    expect(sdk.transports[0]!.requestHeaders['Authorization']).toBe('Bearer token-for-alice')
    expect(manager.getAllTools().map(t => t.name)).toEqual(['remote-gh__do'])
  })
})

// ─── (b) fail-closed dev: no factory ⇒ no token-less SHARED, no masking catalog ──

describe('remote oauth without a token-provider factory fails closed (b)', () => {
  it('opens no token-less SHARED representative and never populates a token-less catalog', async () => {
    const manager = new McpManager(undefined, undefined, undefined) // no factory (dev/tests)
    await expect(manager.addServer(remoteOauthUserServer())).resolves.toBe('applied')

    // The core invariant: NO token-less connection was ever attempted for a
    // remote oauth server (against the parent, a token-less SHARED representative
    // is opened here). Nothing can populate a token-less catalog.
    expect(sdk.transports).toEqual([])
    expect(manager.status.get('remote-gh')?.state).not.toBe('failed')
    expect(manager.getAllTools()).toEqual([])

    // A user call with no factory fails closed (the per-user provider resolves no
    // token → the remote 401s at initialize), never a silent token-less success.
    const res = await manager.callTool('remote-gh__do', {}, { userId: 'alice' })
    expect(res.isError).toBe(true)
    expect(manager.getAllTools()).toEqual([])
  })
})

// ─── (c) heartbeat never probes a remote+oauth representative ──────────────────

describe('refreshAllServerStatus never probes a remote+oauth server (c)', () => {
  it('does not probe a remote oauth-user server and derives its tool count from the catalog', async () => {
    const manager = new McpManager(undefined, undefined, userFactory())
    await expect(manager.addServer(remoteOauthUserServer())).resolves.toBe('applied')
    await manager.callTool('remote-gh__do', {}, { userId: 'alice' }) // per-user partition alive

    sdk.probeAuth = []
    const summary = await manager.refreshAllServerStatus()

    // No probe issued at all — alice's Bearer never left the host for a platform
    // probe — and the server contributes nothing to the round's tally.
    expect(sdk.probeAuth).toEqual([])
    expect(summary.serverCount).toBe(0)
    // Status is derived from the authenticated per-user catalog cache.
    expect(manager.status.get('remote-gh')?.state).toBe('connected')
    expect(manager.status.get('remote-gh')?.toolCount).toBe(1)
  })

  it('does not probe a remote oauth-context server even though its SHARED representative is alive', async () => {
    const manager = new McpManager(undefined, undefined, contextFactory())
    await manager.addServer(remoteOauthContextServer()) // authenticated SHARED representative

    // Sanity: the authenticated SHARED representative DID populate the catalog.
    expect(manager.getAllTools().map(t => t.name)).toEqual(['remote-ctx__do'])

    sdk.probeAuth = []
    const summary = await manager.refreshAllServerStatus()

    // The context Bearer is a real token; a platform probe must not spend it.
    // (Against the parent this server IS probed on 'Bearer context-bearer'.)
    expect(sdk.probeAuth).toEqual([])
    expect(summary.serverCount).toBe(0)
  })
})
