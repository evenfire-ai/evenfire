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

const READ_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:session:read'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const WRITE_CLAIMS = {
  ...READ_CLAIMS,
  scopes: ['host:model:write'],
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

describe('GET /rpc/hosts/:hostRef/models — passthrough to mcp-host', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue(READ_CLAIMS)
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards to mcp-host and returns the upstream body verbatim', async () => {
    const upstream = {
      provider: 'claude',
      hostDefault: 'claude-opus-4-8',
      models: [{ name: 'claude-opus-4-8', displayName: 'Opus 4.8', allowed: true }],
    }
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(upstream),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/models')
      .set('authorization', 'Bearer user-token')
      .expect(200)

    expect(res.body).toEqual(upstream)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://chatllm:8080/v1/runtime/models')
    expect((init as RequestInit).method).toBe('GET')
    expect((init as RequestInit).headers).toMatchObject(HOST_CONNECTION.headers)
  })

  it('passes the chatId query through to mcp-host', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ provider: 'claude', hostDefault: 'x', models: [] }),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .get('/rpc/hosts/chatllm/models?chatId=c1')
      .set('authorization', 'Bearer user-token')
      .expect(200)

    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://chatllm:8080/v1/runtime/models?chatId=c1')
  })

  it('returns 403 if the user cannot access the host', async () => {
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)
    await request(makeApp())
      .get('/rpc/hosts/other-host/models')
      .set('authorization', 'Bearer user-token')
      .expect(403)
  })

  it('returns 403 if scope is missing', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({ ...READ_CLAIMS, scopes: [] })
    await request(makeApp())
      .get('/rpc/hosts/chatllm/models')
      .set('authorization', 'Bearer user-token')
      .expect(403)
  })
})

describe('POST /rpc/hosts/:hostRef/model — set per-session model', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue(WRITE_CLAIMS)
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards the body to mcp-host and returns the upstream response', async () => {
    const upstream = { effective: 'next-task' }
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(upstream),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .post('/rpc/hosts/chatllm/model')
      .set('authorization', 'Bearer user-token')
      .send({ chatId: 'c1', model: 'claude-haiku-4-5' })
      .expect(200)

    expect(res.body).toEqual(upstream)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://chatllm:8080/v1/runtime/model')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).headers).toMatchObject({
      'content-type': 'application/json',
      ...HOST_CONNECTION.headers,
    })
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      chatId: 'c1',
      model: 'claude-haiku-4-5',
    })
  })

  it('passes an upstream model_not_allowed rejection through verbatim', async () => {
    // rpc-proxy relays the upstream status + body unchanged; mcp-host owns the
    // status code (the desktop client treats 403 as model_not_allowed).
    const fetchMock = vi.fn().mockResolvedValue({
      status: 403,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ error: 'model_not_allowed' }),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .post('/rpc/hosts/chatllm/model')
      .set('authorization', 'Bearer user-token')
      .send({ chatId: 'c1', model: 'forbidden-model' })
      .expect(403)

    expect(res.body).toEqual({ error: 'model_not_allowed' })
  })

  it('returns 403 when the caller lacks host:model:write', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(READ_CLAIMS)
    await request(makeApp())
      .post('/rpc/hosts/chatllm/model')
      .set('authorization', 'Bearer user-token')
      .send({ chatId: 'c1', model: 'claude-haiku-4-5' })
      .expect(403)
  })

  it('returns 403 if the user cannot access the host', async () => {
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)
    await request(makeApp())
      .post('/rpc/hosts/other-host/model')
      .set('authorization', 'Bearer user-token')
      .send({ chatId: 'c1', model: 'claude-haiku-4-5' })
      .expect(403)
  })
})
