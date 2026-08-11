import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  type ExternalGfsEdgeLimits,
  createGfsRouter,
  deriveExternalGfsEdgeLimits,
} from '../src/routes/gfs.js'

const { ControlApiError, clientMock } = vi.hoisted(() => {
  class ControlApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public body: unknown,
      public headers: Record<string, string> = {}
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

const REQUEST_ID = '11111111-2222-4333-8444-555555555555'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function buildApp(edgeLimits?: ExternalGfsEdgeLimits) {
  const app = express()
  app.use(express.json())
  app.use(createGfsRouter(edgeLimits ? { edgeLimits } : undefined))
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
      .set('x-request-id', REQUEST_ID)
      .send({ scopes: ['gfs.read'] })
    expect(res.status).toBe(200)
    expect(res.body.token).toBe('gfs-tok')
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith('POST', '/external/gfs/token', {
      userSessionToken: 'sess-xyz',
      body: { scopes: ['gfs.read'] },
      extraHeaders: expect.objectContaining({ 'x-request-id': REQUEST_ID }),
    })
    expect(res.headers['x-request-id']).toBe(REQUEST_ID)
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
      .set('x-request-id', REQUEST_ID)
      .send(body)
    expect(res.status).toBe(200)
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith('PUT', '/external/gfs/grants', {
      userSessionToken: 'sess-xyz',
      body,
      extraHeaders: expect.objectContaining({ 'x-request-id': REQUEST_ID }),
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
      .set('x-request-id', REQUEST_ID)
    expect(res.status).toBe(200)
    expect(res.body.data.nextCursor).toBe('next-page')
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith('GET', '/external/gfs/resources', {
      userSessionToken: 'sess-xyz',
      query: { drive: 'main', limit: '25', cursor: 'cursor-1' },
      extraHeaders: expect.objectContaining({ 'x-request-id': REQUEST_ID }),
    })
  })

  it('forwards the proxy-attested client IP for the control-api GFS rate boundary', async () => {
    clientMock.controlApiRequest.mockResolvedValue({
      ok: true,
      data: { items: [], nextCursor: null },
    })
    const app = buildApp()
    app.set('trust proxy', 1)

    await request(app)
      .get('/me/gfs/resources')
      .set('authorization', 'Bearer sess-xyz')
      .set('x-request-id', REQUEST_ID)
      .set('x-forwarded-for', '198.51.100.42')
      .expect(200)

    expect(clientMock.controlApiRequest).toHaveBeenCalledWith('GET', '/external/gfs/resources', {
      userSessionToken: 'sess-xyz',
      query: { drive: undefined, limit: undefined, cursor: undefined },
      extraHeaders: {
        'x-request-id': REQUEST_ID,
        'x-forwarded-for': '198.51.100.42',
      },
    })
  })

  it('overwrites a caller-spoofed XFF prefix with the trusted one-hop client address', async () => {
    clientMock.controlApiRequest.mockResolvedValue({
      ok: true,
      data: { items: [], nextCursor: null },
    })
    const app = buildApp()
    // createApp uses this same contract: only its immediately adjacent public
    // proxy is trusted. A caller cannot choose the leftmost XFF value.
    app.set('trust proxy', 1)

    await request(app)
      .get('/me/gfs/resources')
      .set('authorization', 'Bearer sess-xyz')
      .set('x-request-id', REQUEST_ID)
      .set('x-forwarded-for', '198.51.100.250, 203.0.113.41')
      .expect(200)

    const options = clientMock.controlApiRequest.mock.calls.at(-1)?.[2] as {
      extraHeaders?: Record<string, string>
    }
    expect(options.extraHeaders?.['x-forwarded-for']).toBe('203.0.113.41')
    expect(options.extraHeaders?.['x-forwarded-for']).not.toBe('198.51.100.250')
  })

  it('does not forward a caller-supplied XFF value when the hop is untrusted', async () => {
    clientMock.controlApiRequest.mockResolvedValue({
      ok: true,
      data: { items: [], nextCursor: null },
    })
    const app = buildApp()
    // The production app trusts exactly its configured proxy hop. This test
    // exercises the fail-closed behavior when that trust is absent: the
    // incoming XFF must not become the attestation sent to control-api.
    app.set('trust proxy', false)

    await request(app)
      .get('/me/gfs/resources')
      .set('authorization', 'Bearer sess-xyz')
      .set('x-request-id', REQUEST_ID)
      .set('x-forwarded-for', '203.0.113.99')
      .expect(200)

    const call = clientMock.controlApiRequest.mock.calls.at(-1)
    const forwarded = (call?.[2] as { extraHeaders?: Record<string, string> } | undefined)
      ?.extraHeaders?.['x-forwarded-for']
    expect(forwarded).toBeDefined()
    expect(forwarded).not.toBe('203.0.113.99')
  })

  it('derives edge capacity for the approved 20- and 50-user NAT cases', () => {
    expect(deriveExternalGfsEdgeLimits(20)).toEqual({
      aggregatePerMin: 2_400,
      authenticatedIpPerMin: 1_200,
      tokenIpPerMin: 240,
    })
    expect(deriveExternalGfsEdgeLimits(50)).toEqual({
      aggregatePerMin: 6_000,
      authenticatedIpPerMin: 3_000,
      tokenIpPerMin: 600,
    })
  })

  it('enforces the aggregate edge backstop before auth and emits recovery headers', async () => {
    const app = buildApp({
      aggregatePerMin: 2,
      authenticatedIpPerMin: 10,
      tokenIpPerMin: 10,
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await request(app)
        .get('/me/gfs/not-classified')
        .set('authorization', 'Bearer sess-xyz')
        .expect(404)
    }

    const exhausted = await request(app)
      .get('/me/gfs/not-classified')
      .set('authorization', 'Bearer sess-xyz')

    expect(exhausted.status).toBe(429)
    expect(exhausted.headers['x-request-id']).toMatch(UUID_RE)
    expect(exhausted.headers['retry-after']).toMatch(/^\d+$/)
    expect(exhausted.headers['ratelimit']).toContain('limit=2')
    expect(exhausted.body).toEqual({
      error: 'Too Many Requests',
      rateLimitLayer: 'external-rest-edge',
      rateLimitBucket: 'aggregate-ip',
    })
    expect(authTokenMock.verifyToken).toHaveBeenCalledTimes(2)
    expect(clientMock.controlApiRequest).not.toHaveBeenCalled()
    expect(clientMock.controlApiStreamRequest).not.toHaveBeenCalled()
  })

  it('keeps the token edge bucket separate from authenticated GFS traffic', async () => {
    clientMock.controlApiRequest.mockResolvedValue({ token: 'gfs-tok', expiresInSeconds: 300 })
    const app = buildApp({
      aggregatePerMin: 10,
      authenticatedIpPerMin: 10,
      tokenIpPerMin: 2,
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await request(app)
        .post('/me/gfs/token')
        .set('authorization', 'Bearer sess-xyz')
        .send({})
        .expect(200)
    }
    const exhausted = await request(app)
      .post('/me/gfs/token')
      .set('authorization', 'Bearer sess-xyz')
      .send({})

    expect(exhausted.status).toBe(429)
    expect(exhausted.headers['retry-after']).toMatch(/^\d+$/)
    expect(exhausted.headers['ratelimit']).toContain('limit=2')
    expect(exhausted.body.rateLimitBucket).toBe('token-ip')
    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(2)
  })

  it('propagates a control-api no-escalation 403 verbatim', async () => {
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
    expect(res.body).toEqual({ error: 'escalation_rejected' })
  })

  it('propagates control-api gfsc 5xx codes (504/502) verbatim, not a generic 500', async () => {
    // control-api emits 504 gfsc_timeout / 502 gfsc_unreachable on the me-path;
    // without them in PROPAGATED, forwardControlApiError fell through to the global
    // handler which collapses every 5xx to 500 — the documented codes became
    // unobservable at the desktop (a wedged gfsc looked like an internal bug).
    for (const [status, error] of [
      [504, 'gfsc_timeout'],
      [502, 'gfsc_unreachable'],
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
      expect(res.body).toEqual({ error })
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
      .set('x-request-id', REQUEST_ID)
    expect(res.status).toBe(200)
    const bytes = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text ?? '')
    expect(bytes.toString('utf8')).toBe('hello')
    expect(clientMock.controlApiStreamRequest).toHaveBeenCalledWith(
      'GET',
      '/external/gfs/proxy/abc',
      {
        userSessionToken: 'sess-xyz',
        query: { drive: 'main' },
        extraHeaders: expect.objectContaining({ 'x-request-id': REQUEST_ID }),
      }
    )
  })

  it('forwards user resource mutations to control-api on the session plane', async () => {
    clientMock.controlApiRequest.mockResolvedValue({ ok: true, data: { resourceId: 'abc' } })
    await request(buildApp())
      .patch('/me/gfs/resources/abc?drive=main')
      .set('authorization', 'Bearer sess-xyz')
      .set('x-request-id', REQUEST_ID)
      .send({ newName: 'renamed.md', ifMatch: 1 })
      .expect(200)
    await request(buildApp())
      .post('/me/gfs/resources/abc/children?drive=main')
      .set('authorization', 'Bearer sess-xyz')
      .set('x-request-id', REQUEST_ID)
      .send({ name: 'docs', kind: 'directory' })
      .expect(201)
    await request(buildApp())
      .put('/me/gfs/resources/abc/content?drive=main')
      .set('authorization', 'Bearer sess-xyz')
      .set('x-request-id', REQUEST_ID)
      .send({ content: 'hello', ifMatch: 2 })
      .expect(200)
    await request(buildApp())
      .delete('/me/gfs/resources/abc?drive=main')
      .set('authorization', 'Bearer sess-xyz')
      .set('x-request-id', REQUEST_ID)
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
        extraHeaders: expect.objectContaining({ 'x-request-id': REQUEST_ID }),
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
        extraHeaders: expect.objectContaining({ 'x-request-id': REQUEST_ID }),
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
        extraHeaders: expect.objectContaining({ 'x-request-id': REQUEST_ID }),
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
        extraHeaders: expect.objectContaining({ 'x-request-id': REQUEST_ID }),
      }
    )
  })

  it('401 without a session token', async () => {
    authTokenMock.verifyToken.mockReturnValue(null)
    const res = await request(buildApp()).post('/me/gfs/token').send({})
    expect(res.status).toBe(401)
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
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
      .set('x-request-id', REQUEST_ID)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items })
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith('GET', '/external/gfs/grants', {
      userSessionToken: 'sess-xyz',
      query: { drive: 'main', resourceId: '11111111-1111-1111-1111-111111111111' },
      extraHeaders: expect.objectContaining({ 'x-request-id': REQUEST_ID }),
    })
  })

  it('propagates the manage_acl_required 403 verbatim', async () => {
    clientMock.controlApiRequest.mockRejectedValue(
      new ControlApiError('forbidden', 403, { error: 'manage_acl_required' })
    )
    const res = await request(buildApp())
      .get('/me/gfs/grants?drive=main&resourceId=11111111-1111-1111-1111-111111111111')
      .set('authorization', 'Bearer sess-xyz')
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'manage_acl_required' })
  })

  it('forwards only the allowlisted rate-limit and request headers on a control-api 429', async () => {
    clientMock.controlApiRequest.mockRejectedValue(
      new ControlApiError(
        'rate limited',
        429,
        {
          error: 'Too Many Requests',
          retryAfterSeconds: 17,
        },
        {
          'retry-after': '17',
          'x-ratelimit-limit': '30',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1776000000',
          'x-request-id': REQUEST_ID,
          'set-cookie': 'internal-session=never-forward',
          server: 'control-api-internal',
          'x-internal-debug': 'never-forward',
        }
      )
    )
    const res = await request(buildApp())
      .get('/me/gfs/grants?drive=main&resourceId=11111111-1111-1111-1111-111111111111')
      .set('authorization', 'Bearer sess-xyz')
    expect(res.status).toBe(429)
    expect(res.body).toEqual({ error: 'Too Many Requests', retryAfterSeconds: 17 })
    expect(res.headers['retry-after']).toBe('17')
    expect(res.headers['x-ratelimit-limit']).toBe('30')
    expect(res.headers['x-ratelimit-remaining']).toBe('0')
    expect(res.headers['x-ratelimit-reset']).toBe('1776000000')
    expect(res.headers['x-request-id']).toBe(REQUEST_ID)
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(res.headers.server).toBeUndefined()
    expect(res.headers['x-internal-debug']).toBeUndefined()
  })
})

describe('GET /me/gfs/shares (delegation list passthrough)', () => {
  it('forwards drive, resource, session, and request id without exposing an admin route', async () => {
    const items = [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        drive: 'main',
        resourceId: '11111111-1111-1111-1111-111111111111',
        subject: { type: 'user', id: '22222222-2222-4222-8222-222222222222' },
        permissions: ['read'],
        includeDescendants: true,
      },
    ]
    clientMock.controlApiRequest.mockResolvedValue({ items })

    const res = await request(buildApp())
      .get('/me/gfs/shares?drive=main&resourceId=11111111-1111-1111-1111-111111111111')
      .set('authorization', 'Bearer sess-xyz')
      .set('x-request-id', REQUEST_ID)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items })
    expect(res.headers['x-request-id']).toBe(REQUEST_ID)
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith('GET', '/external/gfs/shares', {
      userSessionToken: 'sess-xyz',
      query: { drive: 'main', resourceId: '11111111-1111-1111-1111-111111111111' },
      extraHeaders: expect.objectContaining({ 'x-request-id': REQUEST_ID }),
    })

    clientMock.controlApiRequest.mockClear()
    await request(buildApp())
      .get('/me/gfs/admin/shares')
      .set('authorization', 'Bearer sess-xyz')
      .expect(404)
    expect(clientMock.controlApiRequest).not.toHaveBeenCalled()
  })

  it('keeps the aggregate edge backstop process-wide across source IPs', async () => {
    const app = buildApp({
      aggregatePerMin: 2,
      authenticatedIpPerMin: 100,
      tokenIpPerMin: 100,
    })
    app.set('trust proxy', 1)

    await request(app)
      .get('/me/gfs/not-classified')
      .set('authorization', 'Bearer sess-xyz')
      .set('x-forwarded-for', '198.51.100.10')
      .expect(404)
    await request(app)
      .get('/me/gfs/not-classified')
      .set('authorization', 'Bearer sess-xyz')
      .set('x-forwarded-for', '198.51.100.11')
      .expect(404)

    const exhausted = await request(app)
      .get('/me/gfs/not-classified')
      .set('authorization', 'Bearer sess-xyz')
      .set('x-forwarded-for', '198.51.100.12')
    expect(exhausted.status).toBe(429)
    expect(exhausted.body.rateLimitBucket).toBe('aggregate-ip')
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'manage_acl_required'],
    [503, 'gfs_authority_unavailable'],
  ] as const)('propagates %s %s verbatim with the same request id', async (status, error) => {
    clientMock.controlApiRequest.mockRejectedValue(new ControlApiError(error, status, { error }))
    const res = await request(buildApp())
      .get('/me/gfs/shares?drive=main&resourceId=11111111-1111-1111-1111-111111111111')
      .set('authorization', 'Bearer sess-xyz')
      .set('x-request-id', REQUEST_ID)

    expect(res.status).toBe(status)
    expect(res.body).toEqual({ error })
    expect(res.headers['x-request-id']).toBe(REQUEST_ID)
  })
})
