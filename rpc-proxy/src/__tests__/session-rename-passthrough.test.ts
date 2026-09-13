import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createApp } from '../app.js'
import { createRpcRouter } from '../routes/rpc.js'

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)

// Spec 15 Fase B / BP1 — PATCH rename passthrough. The rename write path is a
// distinct scope (host:session:write) from the session reads and is NOT
// wake-eligible, so the token carries only host:session:write.
const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:session:write'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

// Edge identity headers are the trust boundary: mcp-host's runtimeEdgeGuard
// trusts x-clerum-edge-user-id (set by the proxy) and rejects any client
// Authorization. resolveHostConnectionForUser is what injects these; the route
// forwards ONLY host.headers, never the inbound Authorization.
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

describe('PATCH /rpc/hosts/:hostRef/sessions/:agent/:chatId/name — rename passthrough', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue(VALID_CLAIMS)
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards PATCH to mcp-host with :agent and :chatId in the path and body verbatim', async () => {
    const upstream = { ok: true }
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(upstream),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: 'Quarterly planning' })
      .expect(200)

    expect(res.body).toEqual(upstream)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://chatllm:8080/v1/runtime/sessions/chatllm/c1/name')
    expect((init as RequestInit).method).toBe('PATCH')
    // Only the edge headers are forwarded; the client Authorization is not.
    expect((init as RequestInit).headers).toMatchObject(HOST_CONNECTION.headers)
    expect((init as RequestInit).headers).not.toHaveProperty('authorization')
    expect((init as RequestInit).headers).not.toHaveProperty('Authorization')
    // Body reaches the upstream verbatim (re-serialized from the parsed JSON).
    expect((init as RequestInit).body).toBe(JSON.stringify({ title: 'Quarterly planning' }))
    // Bounded upstream timeout (copied from the session reads, unlike /model).
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  it('returns 401 when no auth token is presented', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .send({ title: 'x' })
      .expect(401)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('returns 403 when the token lacks host:session:write (read scope is not enough)', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS, scopes: ['host:session:read'] })
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: 'x' })
      .expect(403)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('returns 403 when the user cannot access the host', async () => {
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch('/rpc/hosts/other-host/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: 'x' })
      .expect(403)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    '/rpc/hosts/chatllm/sessions/agent%3Aother/c1/name',
    '/rpc/hosts/chatllm/sessions/agent%0Aother/c1/name',
    '/rpc/hosts/chatllm/sessions/agent/chat%0Aother/name',
    '/rpc/hosts/chat%2Fllm/sessions/chatllm/c1/name',
  ])('rejects unsafe route segments before forwarding upstream: %s', async path => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch(path)
      .set('authorization', 'Bearer user-token')
      .send({ title: 'x' })
      .expect(400)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it.each([
    { status: 400, body: { error: 'invalid title' } },
    { status: 403, body: { error: 'forbidden' } },
    { status: 404, body: { error: 'session not found' } },
  ])('propagates the upstream $status verbatim', async ({ status, body }) => {
    const fetchMock = vi.fn().mockResolvedValue({
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(body),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: 'x' })
      .expect(status)

    expect(res.body).toEqual(body)
  })

  it('maps a host-down fetch failure to a sanitized 502', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: 'x' })
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
  })

  it('maps an upstream timeout to a sanitized 504', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const fetchMock = vi.fn().mockRejectedValue(timeout)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(createApp())
      .patch('/api/v1/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: 'x' })
      .expect(504)

    expect(res.body).toEqual({ error: 'Gateway Timeout' })
  })

  it('does not log the raw title value', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ ok: true }),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const secret = 'super-secret-title-value'
    await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: secret })
      .expect(200)

    for (const call of infoSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(secret)
    }
  })
})
