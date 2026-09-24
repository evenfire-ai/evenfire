/**
 * Mini-spec 19 §D-2 / C4.1 — remote target handling in McpClient:
 *   (e) with MCP_PROXY_URL active, a remote server BYPASSES the in-cluster proxy
 *       rail and targets its published `transport.url` (its egress goes through
 *       the HCC's own proxy, D-2); a local server still uses the proxy rail.
 *
 * The SDK transports are mocked to capture the target URL that was actually
 * built.
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

function remoteServer(url: string): McpServerInfo {
  return {
    name: 'remote-x',
    transport: { type: 'streamableHttp', url },
    authKind: 'oauth-user',
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

// ─── (e) MCP_PROXY_URL bypass for a remote server ──────────────────────────────

describe('remote server bypasses the MCP_PROXY_URL rail (e)', () => {
  const PROXY = 'http://mcp-proxy.svc:8080'

  it('targets the published transport.url, not ${proxy}/servers/<name>/mcp', async () => {
    const client = new McpClient(
      remoteServer('https://8.8.8.8/mcp'),
      staticTokenProvider('t'),
      PROXY
    )
    await client.connect()
    // The remote egress went to its own URL, never the in-cluster proxy rail.
    expect(built.streamable).toEqual(['https://8.8.8.8/mcp'])
    expect(built.streamable[0]).not.toContain('mcp-proxy')
  })

  it('a LOCAL server with the same proxy still routes through the proxy rail (control)', async () => {
    const client = new McpClient(localServer(), staticTokenProvider('t'), PROXY)
    await client.connect()
    expect(built.streamable).toEqual([`${PROXY}/servers/local-x/mcp`])
  })
})
