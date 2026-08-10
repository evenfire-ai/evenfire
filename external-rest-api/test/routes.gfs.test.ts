import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createGfsRouter } from '../src/routes/gfs.js'

const { ControlApiError, clientMock } = vi.hoisted(() => {
  class ControlApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public body: unknown
    ) {
      super(message)
    }
  }
  return {
    ControlApiError,
    clientMock: { controlApiRequest: vi.fn(), controlApiStreamRequest: vi.fn() },
  }
})
vi.mock('../src/controlApiClient.js', () => ({
  controlApiRequest: clientMock.controlApiRequest,
  controlApiStreamRequest: clientMock.controlApiStreamRequest,
  ControlApiError,
}))

const authTokenMock = vi.hoisted(() => ({ verifyToken: vi.fn() }))
vi.mock('../src/authToken.js', () => authTokenMock)

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use(createGfsRouter())
  return app
}

beforeEach(() => {
  clientMock.controlApiRequest.mockReset()
  clientMock.controlApiStreamRequest.mockReset()
  authTokenMock.verifyToken.mockReset()
  authTokenMock.verifyToken.mockReturnValue({
    userId: 'u1',
    email: 'u@example.com',
    teamId: null,
    role: 'member',
    exp: 9_999_999_999,
  })
})

describe('routes/gfs /me/gfs/* (user session passthrough → /external/gfs/*)', () => {
  it('mints a user gfs token, forwarding the session token to control-api', async () => {
    clientMock.controlApiRequest.mockResolvedValue({ token: 'gfs-tok', expiresInSeconds: 300 })
    const res = await request(buildApp())
      .post('/me/gfs/token')
      .set('authorization', 'Bearer sess-xyz')
      .send({ scopes: ['gfs.read'] })
    expect(res.status).toBe(200)
    expect(res.body.token).toBe('gfs-tok')
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith('POST', '/external/gfs/token', {
      userSessionToken: 'sess-xyz',
      body: { scopes: ['gfs.read'] },
    })
  })

  it('forwards a user delegation grant to /external/gfs/grants', async () => {
    clientMock.controlApiRequest.mockResolvedValue({ ok: true })
    const body = {
      resourceId: 'r',
      subject: { type: 'user', id: '22222222-2222-4222-8222-222222222222' },
      permissions: ['read'],
      inherit: false,
    }
    const res = await request(buildApp())
      .put('/me/gfs/grants')
      .set('authorization', 'Bearer sess-xyz')
      .send(body)
    expect(res.status).toBe(200)
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith('PUT', '/external/gfs/grants', {
      userSessionToken: 'sess-xyz',
      body,
    })
  })

  it('lists accessible resources through /external/gfs/resources', async () => {
    clientMock.controlApiRequest.mockResolvedValue({
      ok: true,
      data: { items: [], nextCursor: 'next-page' },
    })
    const res = await request(buildApp())
      .get('/me/gfs/resources?drive=main&limit=25&cursor=cursor-1')
      .set('authorization', 'Bearer sess-xyz')
    expect(res.status).toBe(200)
    expect(res.body.data.nextCursor).toBe('next-page')
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith('GET', '/external/gfs/resources', {
      userSessionToken: 'sess-xyz',
      query: { drive: 'main', limit: '25', cursor: 'cursor-1' },
    })
  })

  it('maps a control-api no-escalation 403 to the bounded public contract', async () => {
    clientMock.controlApiRequest.mockRejectedValue(
      new ControlApiError('escalation', 403, { error: 'escalation_rejected' })
    )
    const res = await request(buildApp())
      .put('/me/gfs/grants')
      .set('authorization', 'Bearer sess-xyz')
      .send({
        resourceId: 'r',
        subject: { type: 'user', id: '22222222-2222-4222-8222-222222222222' },
        permissions: ['write'],
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toEqual({
      code: 'forbidden',
      message: 'The requested operation is not allowed.',
      correlationId: expect.any(String),
      retryable: false,
    })
  })

  it('maps control-api gfsc 5xx statuses without reflecting internal codes', async () => {
    // control-api emits 504 gfsc_timeout / 502 gfsc_unreachable on the me-path;
    // without them in PROPAGATED, forwardControlApiError fell through to the global
    // handler which collapses every 5xx to 500 — the documented codes became
    // unobservable at the desktop (a wedged gfsc looked like an internal bug).
    for (const [status, error, publicCode] of [
      [504, 'gfsc_timeout', 'upstream_timeout'],
      [502, 'gfsc_unreachable', 'upstream_unavailable'],
    ] as const) {
      clientMock.controlApiRequest.mockReset()
      clientMock.controlApiRequest.mockRejectedValue(
        new ControlApiError('gfsc failure', status, { error })
      )
      const res = await request(buildApp())
        .put('/me/gfs/resources/abc/content?drive=main')
        .set('authorization', 'Bearer sess-xyz')
        .send({ contentBase64: 'AAAA' })
      expect(res.status).toBe(status)
      expect(res.body.error).toMatchObject({
        code: publicCode,
        correlationId: expect.any(String),
        retryable: true,
      })
      expect(JSON.stringify(res.body)).not.toContain(error)
    }
  })

  it('streams a content download (binary) from the proxy', async () => {
    clientMock.controlApiStreamRequest.mockResolvedValue(
      new Response('hello', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': '5' },
      })
    )
    const res = await request(buildApp())
      .get('/me/gfs/proxy/abc?drive=main')
      .set('authorization', 'Bearer sess-xyz')
    expect(res.status).toBe(200)
    const bytes = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text ?? '')
    expect(bytes.toString('utf8')).toBe('hello')
    expect(clientMock.controlApiStreamRequest).toHaveBeenCalledWith(
      'GET',
      '/external/gfs/proxy/abc',
      { userSessionToken: 'sess-xyz', query: { drive: 'main' } }
    )
  })

  it('forwards user resource mutations to control-api on the session plane', async () => {
    clientMock.controlApiRequest.mockResolvedValue({ ok: true, data: { resourceId: 'abc' } })
    await request(buildApp())
      .patch('/me/gfs/resources/abc?drive=main')
      .set('authorization', 'Bearer sess-xyz')
      .send({ newName: 'renamed.md', ifMatch: 1 })
      .expect(200)
    await request(buildApp())
      .post('/me/gfs/resources/abc/children?drive=main')
      .set('authorization', 'Bearer sess-xyz')
      .send({ name: 'docs', kind: 'directory' })
      .expect(201)
    await request(buildApp())
      .put('/me/gfs/resources/abc/content?drive=main')
      .set('authorization', 'Bearer sess-xyz')
      .send({ content: 'hello', ifMatch: 2 })
      .expect(200)
    await request(buildApp())
      .delete('/me/gfs/resources/abc?drive=main')
      .set('authorization', 'Bearer sess-xyz')
      .send({ ifMatch: 3 })
      .expect(200)

    expect(clientMock.controlApiRequest).toHaveBeenNthCalledWith(
      1,
      'PATCH',
      '/external/gfs/resources/abc',
      {
        userSessionToken: 'sess-xyz',
        query: { drive: 'main' },
        body: { newName: 'renamed.md', ifMatch: 1 },
      }
    )
    expect(clientMock.controlApiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/external/gfs/resources/abc/children',
      {
        userSessionToken: 'sess-xyz',
        query: { drive: 'main' },
        body: { name: 'docs', kind: 'directory' },
      }
    )
    expect(clientMock.controlApiRequest).toHaveBeenNthCalledWith(
      3,
      'PUT',
      '/external/gfs/resources/abc/content',
      {
        userSessionToken: 'sess-xyz',
        query: { drive: 'main' },
        body: { content: 'hello', ifMatch: 2 },
      }
    )
    expect(clientMock.controlApiRequest).toHaveBeenNthCalledWith(
      4,
      'DELETE',
      '/external/gfs/resources/abc',
      {
        userSessionToken: 'sess-xyz',
        query: { drive: 'main' },
        body: { ifMatch: 3 },
      }
    )
  })

  it('401 without a session token', async () => {
    authTokenMock.verifyToken.mockReturnValue(null)
    const res = await request(buildApp()).post('/me/gfs/token').send({})
    expect(res.status).toBe(401)
  })
})

describe('GET /me/gfs/grants (delegation list passthrough)', () => {
  it('forwards drive + resourceId and returns the id-bearing items verbatim', async () => {
    const items = [
      {
        id: 'aaaa1111-0000-4000-8000-000000000001',
        drive: 'main',
        resourceId: '11111111-1111-1111-1111-111111111111',
        subject: { type: 'host', id: '1st:mcp-host/agent-a' },
        permissions: ['read', 'write'],
        inherit: true,
      },
    ]
    clientMock.controlApiRequest.mockResolvedValue({ items })
    const res = await request(buildApp())
      .get('/me/gfs/grants?drive=main&resourceId=11111111-1111-1111-1111-111111111111')
      .set('authorization', 'Bearer sess-xyz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items })
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith('GET', '/external/gfs/grants', {
      userSessionToken: 'sess-xyz',
      query: { drive: 'main', resourceId: '11111111-1111-1111-1111-111111111111' },
    })
  })

  it('maps manage_acl_required to the bounded public forbidden contract', async () => {
    clientMock.controlApiRequest.mockRejectedValue(
      new ControlApiError('forbidden', 403, { error: 'manage_acl_required' })
    )
    const res = await request(buildApp())
      .get('/me/gfs/grants?drive=main&resourceId=11111111-1111-1111-1111-111111111111')
      .set('authorization', 'Bearer sess-xyz')
    expect(res.status).toBe(403)
    expect(res.body.error).toEqual({
      code: 'forbidden',
      message: 'The requested operation is not allowed.',
      correlationId: expect.any(String),
      retryable: false,
    })
  })

  it('propagates the delegation-plane 429 with retryAfterSeconds intact', async () => {
    clientMock.controlApiRequest.mockRejectedValue(
      new ControlApiError('rate limited', 429, {
        error: 'Too Many Requests',
        retryAfterSeconds: 17,
      })
    )
    const res = await request(buildApp())
      .get('/me/gfs/grants?drive=main&resourceId=11111111-1111-1111-1111-111111111111')
      .set('authorization', 'Bearer sess-xyz')
    expect(res.status).toBe(429)
    expect(res.body.error).toEqual({
      code: 'rate_limited',
      message: 'Too many requests; retry later.',
      correlationId: expect.any(String),
      retryable: true,
      details: { retryAfterSeconds: 17 },
    })
  })
})
