import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMcpOauthRouter } from './mcpOauth.js'

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
vi.mock('../authToken.js', () => authTokenMock)

const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['mcp:server:invoke'],
  hostRefs: ['h'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const fetchSpy = vi.fn()

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', createMcpOauthRouter())
  return app
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const PATH = '/api/v1/mcp-oauth/gdrive/grant'

beforeEach(() => {
  authTokenMock.verifyRpcToken.mockReset()
  authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS })
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DELETE /api/v1/mcp-oauth/:mcpServerName/grant (spec 11 U4 disconnect)', () => {
  it('401 without a valid RPC JWT', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(null)
    await request(makeApp()).delete(PATH).expect(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('403 when the token lacks the mcp:server:invoke scope', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS, scopes: ['sandbox:ui:view'] })
    await request(makeApp()).delete(PATH).set('Authorization', 'Bearer t').expect(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('400 for a malformed (non-k8s) server name, before any forward', async () => {
    const res = await request(makeApp())
      .delete('/api/v1/mcp-oauth/Foo_Bar/grant')
      .set('Authorization', 'Bearer t')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('forwards userId=auth.sub (NOT the body) + contextId and returns 204 on upstream 204', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }))
    const res = await request(makeApp())
      .delete(PATH)
      .set('Authorization', 'Bearer t')
      // A body userId MUST be ignored — identity comes from auth.sub.
      .send({ userId: 'attacker', contextId: 'ctx-A' })

    expect(res.status).toBe(204)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/internal/mcp-oauth/grant')
    expect(init.method).toBe('DELETE')
    const headers = init.headers as Record<string, string>
    expect(headers['x-service-token']).toBeTruthy()
    expect(headers.authorization).toMatch(/^Bearer /)
    const forwarded = JSON.parse(String(init.body))
    expect(forwarded.mcpServerName).toBe('gdrive')
    expect(forwarded.userId).toBe('user-uuid-123') // auth.sub, NOT 'attacker'
    expect(forwarded.contextId).toBe('ctx-A')
  })

  it('omits contextId from the forward when the body has none', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }))
    await request(makeApp()).delete(PATH).set('Authorization', 'Bearer t').send({})
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const forwarded = JSON.parse(String(init.body))
    expect('contextId' in forwarded).toBe(false)
  })

  it('propagates a 403 context_membership_denied from control-api verbatim', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(403, { error: 'context_membership_denied' }))
    const res = await request(makeApp()).delete(PATH).set('Authorization', 'Bearer t').send({})
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('context_membership_denied')
  })

  it('propagates a 404 server_not_found from control-api verbatim', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { error: 'server_not_found' }))
    const res = await request(makeApp()).delete(PATH).set('Authorization', 'Bearer t').send({})
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('server_not_found')
  })

  it('propagates a 400 context_mismatch from control-api verbatim', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(400, { error: 'context_mismatch' }))
    const res = await request(makeApp())
      .delete(PATH)
      .set('Authorization', 'Bearer t')
      .send({ contextId: 'ctx-B' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('context_mismatch')
  })

  it('coerces a control-api 401 (service-token misconfig) to 502, not the user auth failure', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized' }))
    const res = await request(makeApp()).delete(PATH).set('Authorization', 'Bearer t').send({})
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('control_api_auth_failed')
  })

  it('returns 502 when control-api is unreachable', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await request(makeApp()).delete(PATH).set('Authorization', 'Bearer t').send({})
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('control_api_unreachable')
  })
})
