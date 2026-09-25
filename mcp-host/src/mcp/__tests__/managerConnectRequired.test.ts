/**
 * U5 seam — reactive OAuth-consent classification in `manager.callTool`.
 *
 * Invariants pinned here (spec §U5 must-fix):
 *  - 401 on an oauth server → typed `connectRequired` marker carrying
 *    `mcpServerName` ONLY, NOT a flattened opaque error. The marker no longer
 *    declares an OAuth `provider`: HCC v2 never forwards it to mcp-host
 *    (`decodeMcpServer`, the sole producer of `McpServerInfo`, emits `authKind`
 *    and never an `oauth` block), and no consumer read it — the connect UI keys
 *    the consent flow off `mcpServerName` and resolves the provider server-side
 *    (control-api). The dead field was pruned from the whole U5 chain. See the
 *    `oauthUserServer` fixture.
 *  - 403 on an oauth server → TERMINAL: plain error, NO connectRequired marker.
 *  - 401 on a static (non-oauth) server → NO connectRequired marker (only oauth
 *    has a consent flow).
 *  - No infinite loop: McpAuthError is thrown only AFTER the client's single
 *    forced-refresh retry, so a persistent 401 is terminal-after-retry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerInfo } from '../../types'
import type { McpPrincipal, McpTokenProviderFactory } from '../manager'
import { McpManager } from '../manager'

// ─── SDK mocks: callTool pulls from a queue so the test scripts 401/403/ok ─────

const state: { callToolQueue: Array<() => Promise<unknown>> } = { callToolQueue: [] }

interface MockTransport {
  url: string
  requestHeaders: Record<string, string>
}

/** Structured 401 at `initialize`, mirroring managerRemoteOauthCatalog's mock:
 *  the MCP SDK puts the HTTP status in `.code` for StreamableHTTP errors, so
 *  `extractStructuredHttpStatus` reads 401 and `isAuthError` classifies it. */
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
      // `initialize`. Local (http) targets serve initialize unauthenticated, so
      // the pre-existing http fixtures below still connect.
      if (t.url?.startsWith('https:') && !t.requestHeaders?.['Authorization']) {
        throw new RemoteAuthRequired()
      }
      this.transport = t
    })
    close = vi.fn().mockResolvedValue(undefined)
    listTools = vi.fn().mockResolvedValue({
      tools: [{ name: 'do', description: 'demo', inputSchema: { type: 'object' } }],
    })
    callTool = vi.fn(async () => {
      const next = state.callToolQueue.shift()
      if (!next) throw new Error('unexpected extra callTool')
      return next()
    })
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    url: string
    requestHeaders: Record<string, string>
    close = vi.fn().mockResolvedValue(undefined)
    constructor(url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) {
      this.url = url.toString()
      this.requestHeaders = opts?.requestInit?.headers ?? {}
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

// Remote (https) admissions pin a public IP via the SSRF guard; neutralize it so
// these tests never touch DNS (its real behavior lives in clientRemoteTarget.test.ts).
vi.mock('../../core/net/ssrf', () => ({
  SsrfBlockedError: class SsrfBlockedError extends Error {},
  resolvePinnedPublicIp: vi.fn(async () => '203.0.113.10'),
  pinnedFetch: vi.fn(() => vi.fn(async () => new Response('{}'))),
}))

function httpError(status: number): () => Promise<never> {
  return () => {
    const err = new Error(`http ${status}`) as Error & { code: number }
    err.code = status
    return Promise.reject(err)
  }
}

// Fixtures mirror EXACTLY what `decodeMcpServer` (contextMapperClient.ts) emits
// from the HCC v2 inventory (T1): `authKind` is the only OAuth-derived field on
// the wire; `auth`/`oauth`/`contextRef` are never produced (the decoder even
// rejects `auth`/`contextRef` as forbidden authority metadata). The reactive
// consent gate keys strictly on `authKind` (manager.ts), so `authKind` — not a
// hand-built `oauth` block — is what makes the marker fire.
function oauthUserServer(name = 'monday'): McpServerInfo {
  return {
    name,
    transport: { type: 'streamableHttp', url: `http://${name}/mcp` },
    enabled: true,
    authRequired: true,
    credentialRevision: 'rev-1',
    authKind: 'oauth-user',
    status: { deployed: true, ready: true },
  }
}

function staticServer(name = 'airtable'): McpServerInfo {
  return {
    name,
    transport: { type: 'streamableHttp', url: `http://${name}/mcp` },
    enabled: true,
    authRequired: true,
    credentialRevision: 'rev-1',
    authKind: 'static',
    status: { deployed: true, ready: true },
  }
}

/** Always hands out a token, so the connection has a Bearer and the 401 is real. */
function tokenFactory(): McpTokenProviderFactory {
  return (_server: McpServerInfo, principal: McpPrincipal) => ({
    resolve: async () => (principal.kind === 'user' ? `tok-${principal.userId}` : undefined),
    refresh: async () => (principal.kind === 'user' ? `tok-${principal.userId}` : undefined),
  })
}

/** A remote oauth-user server whose per-user `initialize` 401s when the user has
 *  no grant (the token provider resolves undefined → no Authorization header). */
function remoteOauthUserServer(name = 'remote-bob'): McpServerInfo {
  return {
    name,
    transport: { type: 'streamableHttp', url: `https://${name}.example.com/mcp` },
    authKind: 'oauth-user',
    remote: true,
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

/** Simulates "no grant": the broker 404s → the provider resolves no token, so the
 *  per-user connection reaches the upstream token-less and 401s at `initialize`. */
function noGrantFactory(): McpTokenProviderFactory {
  return () => ({ resolve: async () => undefined, refresh: async () => undefined })
}

beforeEach(() => {
  state.callToolQueue = []
})

describe('manager.callTool — U5 reactive consent classification', () => {
  it('401 on an oauth server → typed connect_required marker (mcpServerName only)', async () => {
    const manager = new McpManager(undefined, undefined, tokenFactory())
    await manager.addServer(oauthUserServer('monday'))

    // Two 401s: initial + the client's single forced-refresh retry → McpAuthError(401).
    state.callToolQueue = [httpError(401), httpError(401)]
    const result = await manager.callTool('monday__do', {}, { userId: 'alice' })

    expect(result.isError).toBe(true)
    // The marker carries ONLY the mcpServerName: HCC v2 forwards only authKind,
    // never the OAuth provider, so the marker no longer declares a provider field.
    expect(result.connectRequired).toEqual({ mcpServerName: 'monday' })
  })

  it('403 on an oauth server → terminal, NO connect_required marker', async () => {
    const manager = new McpManager(undefined, undefined, tokenFactory())
    await manager.addServer(oauthUserServer('monday'))

    // 403 is terminal immediately in the client — no refresh/retry.
    state.callToolQueue = [httpError(403)]
    const result = await manager.callTool('monday__do', {}, { userId: 'alice' })

    expect(result.isError).toBe(true)
    expect(result.connectRequired).toBeUndefined()
  })

  it('401 on a static (non-oauth) server → NO connect_required marker', async () => {
    const manager = new McpManager(undefined, undefined, tokenFactory())
    await manager.addServer(staticServer('airtable'))

    state.callToolQueue = [httpError(401), httpError(401)]
    const result = await manager.callTool('airtable__do', {})

    expect(result.isError).toBe(true)
    expect(result.connectRequired).toBeUndefined()
  })

  // Inv. 16 (§9): with another user's partition alive, a second user without a
  // grant sees the tool, the LLM calls it, and the per-user admission 401s at
  // `initialize` (a RAW 401, not the McpAuthError of a live tools/call). The
  // callTool catch must still surface `connectRequired` so the desktop offers the
  // consent flow. This is the second user's NORMAL path once eager bootstrap makes
  // the tool visible for everyone via the representative catalog.
  it('401 at the per-user admission initialize → connect_required marker', async () => {
    const manager = new McpManager(undefined, undefined, noGrantFactory())
    // Remote oauth-user: addServer registers it (markConnected, 0 tools) without
    // connecting — the per-user admission happens lazily in callTool below.
    await manager.addServer(remoteOauthUserServer('remote-bob'))

    const result = await manager.callTool('remote-bob__do', {}, { userId: 'bob' })

    expect(result.isError).toBe(true)
    expect(result.connectRequired).toEqual({ mcpServerName: 'remote-bob' })
  })
})
