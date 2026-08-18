import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRpcRouter } from '../src/routes/rpc.js'

const state = vi.hoisted(() => ({
  initial: {
    claims: { sub: 'user-1', sid: 'session-1', jti: 'delegation-1' },
    bound: { operationId: 'mcp.invoke', targetHash: 'target-A' },
    checkpoint: {
      destination: {
        kind: 'mcp_server',
        ref: 'mcp-server/weather',
        url: 'http://server-a.mcp-server.test/mcp',
      },
    },
    trustedEdgeContext: { expiresAt: '2026-08-18T12:01:00.000Z' },
  },
  refreshed: {
    claims: { sub: 'user-1', sid: 'session-1', jti: 'delegation-1' },
    bound: { operationId: 'mcp.invoke', targetHash: 'target-A' },
    checkpoint: {
      destination: {
        kind: 'mcp_server',
        ref: 'mcp-server/weather',
        url: 'http://server-b.mcp-server.test/mcp',
      },
    },
    trustedEdgeContext: { expiresAt: '2026-08-18T12:02:00.000Z' },
  },
  authorizeActionV2: vi.fn(),
  resolveServerConnectionForUser: vi.fn(),
}))

vi.mock('../src/middleware/auth.js', () => ({
  extractAuthToken: () => 'raw-v2-token',
  requireRpcAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.auth = { sub: 'user-1' }
    req.authorizedActionV2 = state.initial
    next()
  },
  requireScope: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

vi.mock('../src/actionAuthorityV2.js', () => ({
  actionAuthorityCacheKey: (authorizedClaims: { jti: string }) => `key:${authorizedClaims.jti}`,
  authorizeActionV2: state.authorizeActionV2,
}))

vi.mock('../src/services/mcpProxyService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/mcpProxyService.js')>()
  return {
    ...actual,
    resolveServerConnectionForUser: state.resolveServerConnectionForUser,
  }
})

function response(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers })
}

describe('v2 MCP route session retry', () => {
  afterEach(() => vi.useRealTimers())

  beforeEach(() => {
    vi.restoreAllMocks()
    state.authorizeActionV2.mockReset().mockResolvedValue(state.refreshed)
    state.resolveServerConnectionForUser
      .mockReset()
      .mockImplementation(
        async (
          _userId: string,
          _serverName: string,
          _token: string,
          authorized: typeof state.initial
        ) => ({
          name: 'weather',
          url: authorized.checkpoint.destination.url,
          headers: {},
        })
      )
  })

  it('re-resolves the checkpoint destination before initializing and retrying the caller operation', async () => {
    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'))
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response(400, JSON.stringify({ error: { message: 'session id is required' } }))
      )
      .mockResolvedValueOnce(
        response(200, JSON.stringify({ jsonrpc: '2.0', id: 'init', result: {} }), {
          'mcp-session-id': 'session-B',
        })
      )
      .mockResolvedValueOnce(response(202, ''))
      .mockResolvedValueOnce(
        response(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
      )

    const app = express()
    app.use(express.json())
    app.use(createRpcRouter())
    await request(app)
      .post('/rpc/weather')
      .set('authorization', 'Bearer raw-v2-token')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forecast' } })
      .expect(200, { jsonrpc: '2.0', id: 1, result: { ok: true } })

    expect(state.authorizeActionV2).toHaveBeenCalledWith(state.initial.claims, state.initial.bound)
    expect(state.resolveServerConnectionForUser).toHaveBeenNthCalledWith(
      2,
      'user-1',
      'weather',
      'raw-v2-token',
      state.refreshed
    )
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      state.initial.checkpoint.destination.url,
      state.refreshed.checkpoint.destination.url,
      state.refreshed.checkpoint.destination.url,
      state.refreshed.checkpoint.destination.url,
    ])
    const retry = fetchMock.mock.calls[3]
    expect(JSON.parse(String((retry?.[1] as RequestInit).body)).method).toBe('tools/call')
    expect(retry?.[0]).toBe(state.refreshed.checkpoint.destination.url)
  })
})
