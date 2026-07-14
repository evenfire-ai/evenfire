import { beforeEach, describe, expect, it, vi } from 'vitest'
import { forwardRpcToServer } from '../src/services/mcpRpcService.js'
import type { JsonRpcRequest, ResolvedServerConnection } from '../src/types.js'

function mkResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: headers || { 'content-type': 'application/json' },
  })
}

/**
 * Build the mock sequence for a session-requiring MCP server:
 * 1. First call fails with "session id is required"
 * 2. Initialize succeeds, returning a session id
 * 3. Post-initialize notification (202)
 * 4. Retried call succeeds
 */
function sessionInitSequence(sessionId: string): Response[] {
  return [
    // 1. First call fails: session required
    mkResponse(
      400,
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'session id is required' } })
    ),
    // 2. Initialize succeeds
    mkResponse(
      200,
      [
        'event: message',
        `data: {"jsonrpc":"2.0","id":"init-1","result":{"protocolVersion":"2024-11-05"}}`,
        '',
      ].join('\n'),
      { 'content-type': 'text/event-stream', 'mcp-session-id': sessionId }
    ),
    // 3. notifications/initialized
    mkResponse(202, ''),
    // 4. Retried call succeeds
    mkResponse(
      200,
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'echo' }] } })
    ),
  ]
}

/** A simple success response for calls that already have a cached session. */
function cachedSessionSuccess(): Response {
  return mkResponse(
    200,
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'echo' }] } })
  )
}

describe('mcpRpcService per-user session isolation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('two different users calling the same server get two separate sessions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    // User A hits server → triggers session init with session-A
    for (const r of sessionInitSequence('session-A')) fetchMock.mockResolvedValueOnce(r)
    // User B hits same server → triggers its own session init with session-B
    for (const r of sessionInitSequence('session-B')) fetchMock.mockResolvedValueOnce(r)

    const server: ResolvedServerConnection = {
      name: 'shared-mcp',
      url: 'http://shared-mcp-isolation.mcp-server:3000/mcp',
      headers: {},
    }
    const rpcRequest: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

    // User A
    const responseA = await forwardRpcToServer(server, rpcRequest, 'user-alice')
    expect(responseA).toHaveProperty('result')

    // User B — same server URL, different user
    const responseB = await forwardRpcToServer(server, rpcRequest, 'user-bob')
    expect(responseB).toHaveProperty('result')

    // Both users triggered full session initialization (4 fetch calls each = 8 total)
    expect(fetchMock).toHaveBeenCalledTimes(8)

    // Verify User A's retry used session-A
    const userARetryHeaders = (fetchMock.mock.calls[3]?.[1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(userARetryHeaders['mcp-session-id']).toBe('session-A')

    // Verify User B's retry used session-B (call index 7)
    const userBRetryHeaders = (fetchMock.mock.calls[7]?.[1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(userBRetryHeaders['mcp-session-id']).toBe('session-B')
  })

  it('same user calling the same server reuses the cached session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    // First call triggers full session init
    for (const r of sessionInitSequence('session-A')) fetchMock.mockResolvedValueOnce(r)
    // Second call by same user should reuse session — single fetch, no init
    fetchMock.mockResolvedValueOnce(cachedSessionSuccess())

    const server: ResolvedServerConnection = {
      name: 'shared-mcp',
      url: 'http://shared-mcp-reuse.mcp-server:3000/mcp',
      headers: {},
    }

    // First call — triggers session init (4 fetches)
    const rpcRequest1: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    await forwardRpcToServer(server, rpcRequest1, 'user-alice')

    // Second call — reuses session (1 fetch)
    const rpcRequest2: JsonRpcRequest = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} }
    await forwardRpcToServer(server, rpcRequest2, 'user-alice')

    expect(fetchMock).toHaveBeenCalledTimes(5) // 4 (init) + 1 (cached)

    // Verify the second call used the cached session-A
    const secondCallHeaders = (fetchMock.mock.calls[4]?.[1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(secondCallHeaders['mcp-session-id']).toBe('session-A')
  })

  it('without userId falls back to url-only cache key (backward compat)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    // First call triggers full session init
    for (const r of sessionInitSequence('session-anon')) fetchMock.mockResolvedValueOnce(r)
    // Second call reuses
    fetchMock.mockResolvedValueOnce(cachedSessionSuccess())

    const server: ResolvedServerConnection = {
      name: 'shared-mcp',
      url: 'http://shared-mcp-anon.mcp-server:3000/mcp',
      headers: {},
    }

    // No userId passed
    await forwardRpcToServer(server, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    await forwardRpcToServer(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} })

    expect(fetchMock).toHaveBeenCalledTimes(5) // 4 + 1
  })
})
