/**
 * R4-B1 — the lazy per-user OAuth admission path must replicate the eager
 * addServer fail-closed gates (enabled → authoritative → ready, manager.ts
 * :276-305). serverInfos retains disabled / not-ready / non-authoritative
 * servers (each eager skip branch does serverInfos.set before returning), so a
 * callTool with a valid userId used to reach ensureClient → connectAndInstall
 * and execute the tool against a server the operator had disabled or that was
 * not ready — opening a real connection with the caller's OAuth token.
 *
 * Each case pins the observable result (T4): isError with a cause-precise
 * message that is NOT the "Authentication required" auth path, AND that no
 * connection was opened — no per-user provider built, no new transport, and the
 * server never becomes a connected/live partition.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerInfo } from '../../types'
import type { McpTokenProvider } from '../client'
import { McpManager, type McpPrincipal, type McpTokenProviderFactory } from '../manager'

// ─── SDK mocks (constructable; capture per-transport headers) ────────────────

interface MockTransport {
  requestHeaders: Record<string, string>
  close: ReturnType<typeof vi.fn>
}

const sdk: {
  transports: MockTransport[]
} = { transports: [] }

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

/** Real productor of the oauth-user McpServerInfo shape, mirroring
 *  managerPartition.test.ts. Overrides let a case make it non-admissible. */
function oauthUserServer(overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    name: 'gh',
    contextRef: 'ctx-1',
    transport: { type: 'streamableHttp', url: 'http://gh/mcp' },
    authKind: 'oauth-user',
    enabled: true,
    status: { deployed: true, ready: true },
    ...overrides,
  }
}

/** Records (server, principal) each provider was built for. A per-user
 *  provider being built proves a connection was attempted for that user. */
function recordingFactory(): {
  factory: McpTokenProviderFactory
  built: Array<{ server: string; principal: string }>
} {
  const built: Array<{ server: string; principal: string }> = []
  const factory: McpTokenProviderFactory = (
    server: McpServerInfo,
    principal: McpPrincipal
  ): McpTokenProvider => {
    if (principal.kind === 'shared') {
      built.push({ server: server.name, principal: 'shared' })
      return { resolve: async () => undefined, refresh: async () => undefined }
    }
    built.push({ server: server.name, principal: principal.userId })
    const token = `token-for-${principal.userId}`
    return { resolve: async () => token, refresh: async () => token }
  }
  return { factory, built }
}

beforeEach(() => {
  sdk.transports = []
})

// ─── The three gates on the lazy per-user path ───────────────────────────────

describe('R4-B1 · lazy per-user admission replicates the eager fail-closed gates', () => {
  interface Case {
    name: string
    overrides: Partial<McpServerInfo>
    errorMatch: RegExp
  }

  const cases: Case[] = [
    {
      name: 'disabled server (operator intent)',
      overrides: { enabled: false },
      errorMatch: /disabled/i,
    },
    {
      name: 'non-authoritative readiness',
      overrides: { status: { deployed: true, ready: true, authoritative: false } },
      errorMatch: /not ready/i,
    },
    {
      name: 'not-ready server (transient infra)',
      overrides: { status: { deployed: true, ready: false } },
      errorMatch: /not ready/i,
    },
  ]

  for (const c of cases) {
    it(`${c.name}: callTool with a valid userId fails closed without connecting`, async () => {
      const { factory, built } = recordingFactory()
      const manager = new McpManager(undefined, undefined, factory)

      // Eager admission: the server is skipped (no connection) but retained in
      // serverInfos — exactly the state that used to be exploitable.
      await manager.addServer(oauthUserServer(c.overrides))
      expect(sdk.transports.length).toBe(0)

      const res = await manager.callTool('gh__do', {}, { userId: 'alice' })

      // (T4) Observable result: error, cause-precise, and NOT the auth path.
      expect(res.isError).toBe(true)
      const error = String((res.result as { error: string }).error)
      expect(error).toMatch(c.errorMatch)
      expect(error).not.toMatch(/authentication required/i)

      // No connection opened: no per-user provider built, no new transport, and
      // the server never became a live/connected partition.
      expect(built.filter(b => b.principal !== 'shared')).toEqual([])
      expect(sdk.transports.length).toBe(0)
      expect(manager.getConnectedServers()).toEqual([])
    })
  }
})
