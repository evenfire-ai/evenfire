/**
 * R1-H1 (T3) — DNS-rebinding TOCTOU on the remote MCP target.
 *
 * The guard validates the target resolves to a public IP, but the connection
 * must also be PINNED to that exact IP, or the SDK's fetch re-resolves the
 * hostname at connect time and a TTL≈0 record can rebind it to a
 * private/metadata address (delivering the per-user Bearer + an SSRF read
 * primitive to an internal host).
 *
 * This asserts the observable wiring (T4): the IP returned by
 * `resolvePinnedPublicIp` is USED to build a pinned `fetch` that is handed to the
 * SDK transport (`opts.fetch`). Against the anchor `7bfc2e9a9` — which validates
 * the IP but DISCARDS it and injects no fetch — `opts.fetch` is undefined, so the
 * assertions fail. `core/net/ssrf` is mocked so `pinnedFetch` is observable and
 * no DNS is touched; the pin primitive itself is proven against a real server in
 * core/net/__tests__/ssrf.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pinnedFetch, resolvePinnedPublicIp } from '../../core/net/ssrf'
import type { McpServerInfo } from '../../types'
import { McpClient, staticTokenProvider } from '../client'

const captured: { streamableOpts?: { fetch?: unknown }; sseOpts?: { fetch?: unknown } } = {}

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
    constructor(_url: URL, opts?: { fetch?: unknown }) {
      captured.streamableOpts = opts
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSSE {
    close = vi.fn().mockResolvedValue(undefined)
    constructor(_url: URL, opts?: { fetch?: unknown }) {
      captured.sseOpts = opts
    }
  },
}))

// Mock the SSRF mold so `pinnedFetch` is observable and no DNS/socket is touched.
// resolvePinnedPublicIp returns a FIXED public IP (the "validation" result);
// pinnedFetch tags the fetch it builds with the IP it was pinned to.
vi.mock('../../core/net/ssrf', () => ({
  SsrfBlockedError: class SsrfBlockedError extends Error {},
  resolvePinnedPublicIp: vi.fn(async () => '203.0.113.10'),
  pinnedFetch: vi.fn((ip: string) =>
    Object.assign(
      vi.fn(async () => new Response('{}')),
      { __pinnedIp: ip }
    )
  ),
}))

function remoteServer(url = 'https://rebind.example.com/mcp'): McpServerInfo {
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
  captured.streamableOpts = undefined
  captured.sseOpts = undefined
  vi.mocked(resolvePinnedPublicIp).mockClear()
  vi.mocked(pinnedFetch).mockClear()
})

describe('remote target connection is pinned to the validated IP (R1-H1, T3)', () => {
  it('injects a fetch pinned to the resolvePinnedPublicIp IP into the SDK transport', async () => {
    const client = new McpClient(remoteServer(), staticTokenProvider('t'))
    await client.connect()

    // The validated IP is actually USED to build the connection's fetch (against
    // the anchor it is resolved then discarded, so pinnedFetch is never called).
    expect(pinnedFetch).toHaveBeenCalledWith('203.0.113.10')
    // ...and that pinned fetch is handed to the SDK transport, so the SDK cannot
    // re-resolve the hostname at connect time. Anchor: opts.fetch is undefined.
    const injected = captured.streamableOpts?.fetch as { __pinnedIp?: string } | undefined
    expect(injected).toBeDefined()
    expect(injected!.__pinnedIp).toBe('203.0.113.10')
  })

  it('does NOT pin a local (in-cluster) server — no fetch override, no resolve', async () => {
    const client = new McpClient(localServer(), staticTokenProvider('t'))
    await client.connect()
    expect(resolvePinnedPublicIp).not.toHaveBeenCalled()
    expect(pinnedFetch).not.toHaveBeenCalled()
    expect(captured.streamableOpts?.fetch).toBeUndefined()
  })

  it('does NOT pin the MCP_PROXY_URL rail for a local server (internal egress)', async () => {
    const client = new McpClient(
      localServer(),
      staticTokenProvider('t'),
      'http://mcp-proxy.svc:8080'
    )
    await client.connect()
    expect(pinnedFetch).not.toHaveBeenCalled()
    expect(captured.streamableOpts?.fetch).toBeUndefined()
  })
})
