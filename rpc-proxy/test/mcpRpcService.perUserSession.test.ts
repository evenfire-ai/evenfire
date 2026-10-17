import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpSessionCache, forwardRpcToServer } from '../src/services/mcpRpcService.js'
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
  afterEach(() => vi.useRealTimers())

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

  it('uses the refreshed destination and authority identity for the session retry', async () => {
    const now = Date.now()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mkResponse(
          400,
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'session id is required' },
          })
        )
      )
      .mockResolvedValueOnce(
        mkResponse(200, JSON.stringify({ jsonrpc: '2.0', id: 'init', result: {} }), {
          'content-type': 'application/json',
          'mcp-session-id': 'session-B',
        })
      )
      .mockResolvedValueOnce(mkResponse(202, ''))
      .mockResolvedValueOnce(
        mkResponse(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
      )

    const serverA: ResolvedServerConnection = {
      name: 'weather',
      url: 'http://server-a.mcp-server.test/mcp',
      headers: {},
    }
    const serverB: ResolvedServerConnection = {
      name: 'weather',
      url: 'http://server-b.mcp-server.test/mcp',
      headers: {},
    }
    const rpcRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'forecast' },
    }
    const beforeRetry = vi.fn().mockResolvedValue({
      server: serverB,
      authorityCacheKey: 'full-authority-B',
      authorityExpiresAt: new Date(now + 60_000).toISOString(),
    })

    await expect(
      forwardRpcToServer(serverA, rpcRequest, 'user-alice', {
        authorityCacheKey: 'full-authority-A',
        authorityExpiresAt: new Date(now + 30_000).toISOString(),
        beforeRetry,
      })
    ).resolves.toMatchObject({ result: { ok: true } })

    expect(beforeRetry).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      serverA.url,
      serverB.url,
      serverB.url,
      serverB.url,
    ])
    const retriedCallerOperations = fetchMock.mock.calls
      .slice(1)
      .filter(call => JSON.parse(String((call[1] as RequestInit).body)).method === 'tools/call')
    expect(retriedCallerOperations).toHaveLength(1)
    expect(retriedCallerOperations[0]?.[0]).toBe(serverB.url)
    const retryHeaders = (retriedCallerOperations[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(retryHeaders['mcp-session-id']).toBe('session-B')

    fetchMock.mockResolvedValueOnce(
      mkResponse(200, JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: true } }))
    )
    await forwardRpcToServer(serverB, { ...rpcRequest, id: 2 }, 'user-alice', {
      authorityCacheKey: 'full-authority-B',
      authorityExpiresAt: new Date(now + 60_000).toISOString(),
      beforeRetry,
    })
    const reuseHeaders = (fetchMock.mock.calls[4]?.[1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(reuseHeaders['mcp-session-id']).toBe('session-B')
  })

  it('does not reuse an MCP session after its authority expires', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-08-18T12:00:00.000Z')
    vi.setSystemTime(now)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    for (const response of sessionInitSequence('session-before-expiry')) {
      fetchMock.mockResolvedValueOnce(response)
    }

    const server: ResolvedServerConnection = {
      name: 'weather',
      url: 'http://authority-expiry.mcp-server.test/mcp',
      headers: {},
    }
    const rpcRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }
    const authorityExpiresAt = new Date(now.getTime() + 1_000).toISOString()
    const beforeRetry = vi
      .fn()
      .mockResolvedValueOnce({
        server,
        authorityCacheKey: 'full-authority-expiring',
        authorityExpiresAt,
      })
      .mockResolvedValueOnce({
        server,
        authorityCacheKey: 'full-authority-expiring',
        authorityExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      })
    await forwardRpcToServer(server, rpcRequest, 'user-alice', {
      authorityCacheKey: 'full-authority-expiring',
      authorityExpiresAt,
      beforeRetry,
    })

    vi.setSystemTime(new Date(now.getTime() + 1_001))
    for (const response of sessionInitSequence('session-after-expiry')) {
      fetchMock.mockResolvedValueOnce(response)
    }
    await forwardRpcToServer(server, rpcRequest, 'user-alice', {
      authorityCacheKey: 'full-authority-expiring',
      authorityExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      beforeRetry,
    })

    expect(fetchMock).toHaveBeenCalledTimes(8)
    const firstCallAfterExpiryHeaders = (fetchMock.mock.calls[4]?.[1] as RequestInit)
      .headers as Record<string, string>
    expect(firstCallAfterExpiryHeaders['mcp-session-id']).toBeUndefined()
  })

  it('does not initialize or retry when the live checkpoint fails closed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mkResponse(
        400,
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'session id is required' },
        })
      )
    )
    const server: ResolvedServerConnection = {
      name: 'weather',
      url: 'http://checkpoint-denied.mcp-server.test/mcp',
      headers: {},
    }
    const checkpointError = new Error('access_path_stale')

    await expect(
      forwardRpcToServer(
        server,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forecast' } },
        'user-alice',
        {
          authorityCacheKey: 'full-authority-denied',
          authorityExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          beforeRetry: vi.fn().mockRejectedValue(checkpointError),
        }
      )
    ).rejects.toBe(checkpointError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('McpSessionCache bounds', () => {
  it('reclaims expired entries and never exceeds its configured size', () => {
    let now = 1_000
    const cache = new McpSessionCache(7, () => now)

    for (let round = 0; round < 50; round += 1) {
      for (let index = 0; index < 19; index += 1) {
        const key = `authority-${round}-${index}`
        cache.set(key, `session-${round}-${index}`, now + ((index % 3) + 1) * 10)
        expect(cache.size).toBeLessThanOrEqual(7)
        if (index % 2 === 0) expect(cache.get(key)).toBe(`session-${round}-${index}`)
      }
      now += 31
      cache.reclaimExpired()
      expect(cache.size).toBe(0)
    }
  })

  it('preserves full-key path isolation while evicting the least-recently-used entry', () => {
    const cache = new McpSessionCache(2, () => 1_000)
    const directKey = 'user::session::resource::direct-path::operation::revision::server'
    const teamKey = 'user::session::resource::team-path::operation::revision::server'
    const otherKey = 'other-user::session::resource::direct-path::operation::revision::server'

    cache.set(directKey, 'direct-session', 2_000)
    cache.set(teamKey, 'team-session', 2_000)
    expect(cache.get(directKey)).toBe('direct-session')
    cache.set(otherKey, 'other-session', 2_000)

    expect(cache.get(directKey)).toBe('direct-session')
    expect(cache.get(teamKey)).toBeUndefined()
    expect(cache.get(otherKey)).toBe('other-session')
    expect(cache.size).toBe(2)
  })
})
