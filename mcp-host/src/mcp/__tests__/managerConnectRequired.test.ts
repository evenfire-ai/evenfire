/**
 * U5 seam — reactive OAuth-consent classification in `manager.callTool`.
 *
 * Invariants pinned here (spec §U5 must-fix):
 *  - 401 on an oauth server → typed `connectRequired` marker (mcpServerName +
 *    provider), NOT a flattened opaque error.
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

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = vi.fn().mockResolvedValue(undefined)
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
    close = vi.fn().mockResolvedValue(undefined)
    constructor(_url: URL, _opts?: unknown) {}
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

function httpError(status: number): () => Promise<never> {
  return () => {
    const err = new Error(`http ${status}`) as Error & { code: number }
    err.code = status
    return Promise.reject(err)
  }
}

function oauthUserServer(name = 'monday', provider = 'monday'): McpServerInfo {
  return {
    name,
    contextRef: 'ctx-1',
    transport: { type: 'streamableHttp', url: `http://${name}/mcp` },
    auth: { type: 'oauth' },
    oauth: { grantScope: 'user', provider },
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

function staticServer(name = 'airtable'): McpServerInfo {
  return {
    name,
    contextRef: 'ctx-1',
    transport: { type: 'streamableHttp', url: `http://${name}/mcp` },
    auth: { type: 'none' },
    enabled: true,
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

beforeEach(() => {
  state.callToolQueue = []
})

describe('manager.callTool — U5 reactive consent classification', () => {
  it('401 on an oauth server → typed connect_required marker (mcpServerName + provider)', async () => {
    const manager = new McpManager(undefined, undefined, tokenFactory())
    await manager.addServer(oauthUserServer('monday', 'monday'))

    // Two 401s: initial + the client's single forced-refresh retry → McpAuthError(401).
    state.callToolQueue = [httpError(401), httpError(401)]
    const result = await manager.callTool('monday__do', {}, { userId: 'alice' })

    expect(result.isError).toBe(true)
    expect(result.connectRequired).toEqual({ mcpServerName: 'monday', provider: 'monday' })
  })

  it('403 on an oauth server → terminal, NO connect_required marker', async () => {
    const manager = new McpManager(undefined, undefined, tokenFactory())
    await manager.addServer(oauthUserServer('monday', 'monday'))

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
})
