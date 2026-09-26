/**
 * R1-B1 (T3) — a REMOTE MCP server is reached through the HCC nginx egress
 * proxy, whose `transport.url` is an in-cluster Service (http by design). The
 * external destination (`spec.remote.baseUrl`) is SSRF-validated by
 * control-api/HCC and is NEVER projected to mcp-host, so mcp-host must NOT
 * SSRF-guard/pin `transport.url` — that internal hop is trusted exactly like the
 * MCP_PROXY_URL rail and the in-cluster DNS fallback.
 *
 * Against the unfixed head, `validateRemoteTarget` rejects the http internal hop
 * with `SsrfBlockedError('...must be https (got http:)')` before any transport is
 * built, so the whole remote rail is dead: `built.streamable` stays empty and
 * `connect()` rejects. These tests assert the OBSERVABLE result (T4): connect
 * resolves, the client is connected, and the transport was built to the internal
 * hop URL.
 *
 * `core/net/ssrf` is the REAL mold (NOT mocked) so on the unfixed head the guard
 * genuinely throws. The SDK transports are mocked to capture the URL built.
 *
 * The internal-hop fixture is the production shape emitted by the producer chain
 * (control-api remoteMcp.ts → HCC k8sClient.ts → mcpAuthorization.ts → the
 * mcp-host decoder contextMapperClient.ts): `remote:true` with `transport.url`
 * pointing at the HCC egress-proxy Service `http://<name>.<ns>.svc.cluster.local:3000/mcp`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerInfo } from '../../types'
import { McpClient, staticTokenProvider } from '../client'

const built: { streamable: string[]; sse: string[] } = { streamable: [], sse: [] }

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = vi.fn(async () => undefined)
    close = vi.fn().mockResolvedValue(undefined)
    listTools = vi.fn(async () => ({ tools: [] }))
    request = vi.fn(async () => ({ tools: [] }))
    callTool = vi.fn(async () => ({ content: [] }))
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamable {
    close = vi.fn().mockResolvedValue(undefined)
    constructor(url: URL) {
      built.streamable.push(url.toString())
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSSE {
    close = vi.fn().mockResolvedValue(undefined)
    constructor(url: URL) {
      built.sse.push(url.toString())
    }
  },
}))

// The HCC egress-proxy Service the remote CR is projected onto. This is the exact
// shape the decoder emits (contextMapperClient.ts): an in-cluster Service URL,
// http by design — the external baseUrl is validated upstream and never lands here.
const NS = 'clerum-host-xyz'
const INTERNAL_HOP = `http://remote-gh.${NS}.svc.cluster.local:3000/mcp`

function remoteServer(authKind: 'oauth-user' | 'static'): McpServerInfo {
  return {
    name: 'remote-gh',
    transport: { type: 'streamableHttp', port: 3000, url: INTERNAL_HOP },
    authKind,
    remote: true,
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

function localServer(): McpServerInfo {
  return {
    name: 'local-x',
    transport: {
      type: 'streamableHttp',
      url: 'http://local-x.mcp-server.svc.cluster.local:3000/mcp',
    },
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

beforeEach(() => {
  built.streamable = []
  built.sse = []
})

// ─── The internal hop is trusted, not SSRF-guarded (R1-B1) ─────────────────────

describe('remote server connects through the http HCC egress-proxy hop (R1-B1)', () => {
  it('connects a remote oauth server to its internal hop URL, building the transport', async () => {
    const client = new McpClient(remoteServer('oauth-user'), staticTokenProvider('t'))
    await expect(client.connect()).resolves.toBeUndefined()
    expect(client.isConnected).toBe(true)
    expect(built.streamable).toEqual([INTERNAL_HOP])
  })

  it('connects a remote static server to its internal hop URL (not oauth-only)', async () => {
    const client = new McpClient(remoteServer('static'), staticTokenProvider('t'))
    await expect(client.connect()).resolves.toBeUndefined()
    expect(client.isConnected).toBe(true)
    expect(built.streamable).toEqual([INTERNAL_HOP])
  })
})

// ─── The MCP_PROXY_URL bypass is preserved (remote != proxy rail) ──────────────

describe('remote server bypasses the MCP_PROXY_URL rail (R1-B1)', () => {
  const PROXY = 'http://mcp-proxy.svc:8080'

  it('a remote server with a proxy set still targets its internal hop, not the proxy rail', async () => {
    const client = new McpClient(remoteServer('oauth-user'), staticTokenProvider('t'), PROXY)
    await expect(client.connect()).resolves.toBeUndefined()
    // The remote egress is its own HCC hop, never collapsed into the proxy rail.
    expect(built.streamable).toEqual([INTERNAL_HOP])
    expect(built.streamable[0]).not.toContain('mcp-proxy')
  })

  it('a LOCAL server with the same proxy still routes through the proxy rail (control)', async () => {
    const client = new McpClient(localServer(), staticTokenProvider('t'), PROXY)
    await client.connect()
    expect(built.streamable).toEqual([`${PROXY}/servers/local-x/mcp`])
  })
})
