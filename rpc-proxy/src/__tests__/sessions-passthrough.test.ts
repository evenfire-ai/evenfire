import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRpcRouter } from '../routes/rpc.js'

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)

// Issue #791 §11.4: session reads are wake-eligible finite operations, so the
// Desktop-issued token carries host:wake:write alongside host:session:read.
// The route scope guard (host:session:read) is unchanged.
const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:session:read', 'host:wake:write'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const HOST_CONNECTION = {
  name: 'chatllm',
  url: 'http://chatllm:8080',
  headers: {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-uuid-123',
  },
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  return app
}

describe('GET /rpc/hosts/:hostRef/sessions — passthrough to mcp-host', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue(VALID_CLAIMS)
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards to mcp-host and returns the upstream body verbatim', async () => {
    const upstream = {
      items: [
        { agent: 'chatllm', chatId: 'c1', turnCount: 2, lastActivityAt: '2026-04-22T10:00:00Z' },
      ],
    }
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(upstream),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions')
      .set('authorization', 'Bearer user-token')
      .expect(200)

    expect(res.body).toEqual(upstream)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://chatllm:8080/v1/runtime/sessions')
    expect((init as RequestInit).method).toBe('GET')
    expect((init as RequestInit).headers).toMatchObject(HOST_CONNECTION.headers)
  })

  it('forwards only supported session pagination query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ items: [], nextCursor: 'next-page' }),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions?limit=25&cursor=current&userId=other')
      .set('authorization', 'Bearer user-token')
      .expect(200)

    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://chatllm:8080/v1/runtime/sessions?limit=25&cursor=current')
  })

  it('bounds and scopes session pagination before forwarding upstream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions?agent=chatllm&limit=500')
      .set('authorization', 'Bearer user-token')
      .expect(200)

    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://chatllm:8080/v1/runtime/sessions?agent=chatllm&limit=100')
  })

  it('returns 403 if the user cannot access the host', async () => {
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)
    await request(makeApp())
      .get('/rpc/hosts/other-host/sessions')
      .set('authorization', 'Bearer user-token')
      .expect(403)
  })

  it('returns 403 if scope is missing', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS, scopes: [] })
    await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions')
      .set('authorization', 'Bearer user-token')
      .expect(403)
  })
})

describe('GET /rpc/hosts/:hostRef/sessions/:agent/:chatId/messages — passthrough', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue(VALID_CLAIMS)
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards to mcp-host with :agent and :chatId in the path', async () => {
    const upstream = { agent: 'chatllm', chatId: 'c1', turns: [] }
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(upstream),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/c1/messages')
      .set('authorization', 'Bearer user-token')
      .expect(200)

    expect(res.body).toEqual(upstream)
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://chatllm:8080/v1/runtime/sessions/chatllm/c1/messages')
  })

  it('forwards only supported message pagination query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        JSON.stringify({
          agent: 'chatllm',
          chatId: 'c1',
          totalTurns: 10,
          hasMoreBefore: true,
          hasMoreAfter: false,
          turns: [],
        }),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/c1/messages?limit=5&beforeTurn=6&userId=other')
      .set('authorization', 'Bearer user-token')
      .expect(200)

    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(
      'http://chatllm:8080/v1/runtime/sessions/chatllm/c1/messages?limit=5&beforeTurn=6'
    )
  })

  it('clamps transcript limits before forwarding upstream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agent: 'chatllm', chatId: 'c1', turns: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/c1/messages?limit=999')
      .set('authorization', 'Bearer user-token')
      .expect(200)

    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(
      'http://chatllm:8080/v1/runtime/sessions/chatllm/c1/messages?limit=200'
    )
  })

  it('returns 404 when the upstream returns 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 404,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ error: 'session not found' }),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/missing/messages')
      .set('authorization', 'Bearer user-token')
      .expect(404)

    expect(res.body).toEqual({ error: 'session not found' })
  })

  it('returns 403 if scope is missing', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS, scopes: [] })
    await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/c1/messages')
      .set('authorization', 'Bearer user-token')
      .expect(403)
  })
})

describe('GET /rpc/hosts/:hostRef/sessions/:agent/:chatId/context-breakdown — passthrough', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue(VALID_CLAIMS)
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards to mcp-host with :agent and :chatId in the path', async () => {
    const upstream = {
      breakdown: {
        buckets: { messages: 100, systemTools: 60, metaContext: 20, systemPrompt: 10 },
        totalInputTokens: 190,
        maxTokens: 100000,
        fillRatio: 0.0019,
        capturedAtTurn: 3,
      },
    }
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(upstream),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/c1/context-breakdown')
      .set('authorization', 'Bearer user-token')
      .expect(200)

    expect(res.body).toEqual(upstream)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://chatllm:8080/v1/runtime/sessions/chatllm/c1/context-breakdown')
    expect((init as RequestInit).method).toBe('GET')
    expect((init as RequestInit).headers).toMatchObject(HOST_CONNECTION.headers)
  })

  it('returns 404 (anti-enumeration) verbatim when the upstream returns 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 404,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ error: 'session not found' }),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/missing/context-breakdown')
      .set('authorization', 'Bearer user-token')
      .expect(404)

    expect(res.body).toEqual({ error: 'session not found' })
  })

  it('returns 403 if the user cannot access the host', async () => {
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)
    await request(makeApp())
      .get('/rpc/hosts/other-host/sessions/chatllm/c1/context-breakdown')
      .set('authorization', 'Bearer user-token')
      .expect(403)
  })

  it('returns 403 if scope is missing', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS, scopes: [] })
    await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/c1/context-breakdown')
      .set('authorization', 'Bearer user-token')
      .expect(403)
  })
})
