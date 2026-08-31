/**
 * U4 seam — 401-in-tool-call recovery (mini-spec 03 §5).
 *
 *  - 401 → force tokenProvider.refresh(), reconnect through the SAME fencing,
 *    retry exactly once.
 *  - a second 401 → terminal McpAuthError, NO loop (one forced refresh only).
 *  - 403 → terminal immediately, NO refresh, NO reconnect.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerInfo } from '../../types'
import { McpAuthError, McpClient, type McpTokenProvider } from '../client'

const state: { callToolQueue: Array<() => Promise<unknown>>; connectCount: number } = {
  callToolQueue: [],
  connectCount: 0,
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = vi.fn(async () => {
      state.connectCount += 1
    })
    close = vi.fn().mockResolvedValue(undefined)
    listTools = vi.fn().mockResolvedValue({ tools: [{ name: 'do', inputSchema: {} }] })
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
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

function server(): McpServerInfo {
  return {
    name: 'gh',
    contextRef: 'ctx',
    transport: { type: 'streamableHttp', url: 'http://gh/mcp' },
    auth: { type: 'oauth' },
    oauth: { grantScope: 'user' },
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

function httpError(status: number): () => Promise<never> {
  return () => {
    const err = new Error(`http ${status}`) as Error & { code: number }
    err.code = status
    return Promise.reject(err)
  }
}

function trackingProvider(): { provider: McpTokenProvider; refreshCount: () => number } {
  let refreshes = 0
  return {
    provider: {
      resolve: async () => 'tok',
      refresh: async () => {
        refreshes += 1
        return 'tok-refreshed'
      },
    },
    refreshCount: () => refreshes,
  }
}

beforeEach(() => {
  state.callToolQueue = []
  state.connectCount = 0
})

describe('McpClient — 401 tool-call recovery', () => {
  it('refreshes the token, reconnects, and retries once on 401', async () => {
    const { provider, refreshCount } = trackingProvider()
    const client = new McpClient(server(), provider)
    await client.connect()
    const connectsAfterInitial = state.connectCount

    state.callToolQueue = [
      httpError(401),
      () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
    ]
    const result = await client.callTool('do', {})

    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(refreshCount()).toBe(1)
    // Reconnected exactly once through the fencing (a new SDK connect happened).
    expect(state.connectCount).toBe(connectsAfterInitial + 1)
  })

  it('a second 401 is terminal (McpAuthError), with no refresh loop', async () => {
    const { provider, refreshCount } = trackingProvider()
    const client = new McpClient(server(), provider)
    await client.connect()

    state.callToolQueue = [httpError(401), httpError(401)]
    await expect(client.callTool('do', {})).rejects.toBeInstanceOf(McpAuthError)
    // Only one forced refresh — the second 401 does not trigger another.
    expect(refreshCount()).toBe(1)
  })

  it('403 is terminal immediately — no refresh, no reconnect', async () => {
    const { provider, refreshCount } = trackingProvider()
    const client = new McpClient(server(), provider)
    await client.connect()
    const connectsAfterInitial = state.connectCount

    state.callToolQueue = [httpError(403)]
    await expect(client.callTool('do', {})).rejects.toBeInstanceOf(McpAuthError)
    expect(refreshCount()).toBe(0)
    expect(state.connectCount).toBe(connectsAfterInitial)
  })
})
