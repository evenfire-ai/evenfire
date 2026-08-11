import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createGfsRouter } from '../src/routes/gfs.js'

const { ControlApiError, clientMock } = vi.hoisted(() => {
  class ControlApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public body: unknown,
      public headers?: Headers
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

function buildApp(edgeRequestLimit = 120) {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use(createGfsRouter({ edgeRequestLimit }))
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
  it('applies one shared local edge bucket across v2 methods before proxying', async () => {
    clientMock.controlApiStreamRequest.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const app = buildApp(1)
    const first = await request(app)
      .get('/me/gfs/capabilities?drive=archive')
      .set('authorization', 'Bearer sess-xyz')
    const second = await request(app)
      .get('/me/gfs/uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/status?drive=archive')
      .set('authorization', 'Bearer sess-xyz')

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(second.headers['retry-after']).toMatch(/^[1-9][0-9]*$/)
    expect(second.headers['x-ratelimit-limit']).toBe('1')
    expect(second.headers['x-ratelimit-remaining']).toBe('0')
    expect(second.body).toEqual({
      error: 'gfs_upload_rate_limited',
      retryAfterSeconds: expect.any(Number),
    })
    expect(clientMock.controlApiStreamRequest).toHaveBeenCalledTimes(1)
  })

  it('does not spend an authenticated bucket on unauthenticated requests', async () => {
    const app = buildApp(1)
    const unauthenticated = await request(app).get('/me/gfs/capabilities?drive=archive')
    expect(unauthenticated.status).toBe(401)

    clientMock.controlApiStreamRequest.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    const authenticated = await request(app)
      .get('/me/gfs/capabilities?drive=archive')
      .set('authorization', 'Bearer sess-xyz')
    expect(authenticated.status).toBe(200)
  })

  it('isolates users and groups IPv6 addresses by the library subnet policy', async () => {
    authTokenMock.verifyToken.mockImplementation((token: string) => ({
      userId: token === 'sess-two' ? 'u2' : 'u1',
      email: `${token}@example.com`,
      teamId: null,
      role: 'member',
      exp: 9_999_999_999,
    }))
    clientMock.controlApiStreamRequest.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const app = buildApp(1)
    const first = await request(app)
      .get('/me/gfs/capabilities?drive=archive')
      .set('authorization', 'Bearer sess-one')
      .set('x-forwarded-for', '2001:db8:abcd:0012::1')
    const differentUser = await request(app)
      .get('/me/gfs/capabilities?drive=archive')
      .set('authorization', 'Bearer sess-two')
      .set('x-forwarded-for', '2001:db8:abcd:0012::1')
    const sameUserPrefix = await request(app)
      .get('/me/gfs/capabilities?drive=archive')
      .set('authorization', 'Bearer sess-one')
      .set('x-forwarded-for', '2001:db8:abcd:0012::2')

    expect(first.status).toBe(200)
    expect(differentUser.status).toBe(200)
    expect(sameUserPrefix.status).toBe(429)
    expect(clientMock.controlApiStreamRequest).toHaveBeenCalledTimes(2)
  })

  it('rejects a missing or create-body-mismatched upload drive at the public edge', async () => {
    const missing = await request(buildApp())
      .get('/me/gfs/capabilities')
      .set('authorization', 'Bearer sess-xyz')
    const mismatched = await request(buildApp())
      .post('/me/gfs/uploads?drive=archive')
      .set('authorization', 'Bearer sess-xyz')
      .send({ drive: 'main', operation: 'create' })
    expect(missing.status).toBe(400)
    expect(missing.body).toEqual({ error: 'drive_required' })
    expect(mismatched.status).toBe(400)
    expect(mismatched.body).toEqual({ error: 'drive_mismatch' })
    expect(clientMock.controlApiStreamRequest).not.toHaveBeenCalled()
  })

  it('rejects malformed drive wire values without forwarding them upstream', async () => {
    const malformed = ['', ' archive', 'archive ', '\tarchive', 'archive\n']
    for (const drive of malformed) {
      const response = await request(buildApp())
        .get(`/me/gfs/capabilities?drive=${encodeURIComponent(drive)}`)
        .set('authorization', 'Bearer sess-xyz')
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'drive_required' })
    }
    const arrayValue = await request(buildApp())
      .get('/me/gfs/capabilities?drive=archive&drive=main')
      .set('authorization', 'Bearer sess-xyz')
    expect(arrayValue.status).toBe(400)
    expect(arrayValue.body).toEqual({ error: 'drive_required' })
    expect(clientMock.controlApiStreamRequest).not.toHaveBeenCalled()
  })

  it('preserves one non-main drive and the part stream through every upload lifecycle relay', async () => {
    const uploadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let streamedPart = Buffer.alloc(0)
    clientMock.controlApiStreamRequest.mockImplementation(
      async (method: string, _path: string, options: { body?: unknown }) => {
        if (method === 'PUT' && options.body && typeof options.body !== 'string') {
          const chunks: Buffer[] = []
          for await (const chunk of options.body as AsyncIterable<Buffer>) {
            chunks.push(Buffer.from(chunk))
          }
          streamedPart = Buffer.concat(chunks)
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    )
    const app = buildApp()
    const authed = (builder: request.Test) => builder.set('authorization', 'Bearer sess-xyz')

    await authed(request(app).get('/me/gfs/capabilities?drive=archive')).expect(200)
    await authed(request(app).post('/me/gfs/uploads?drive=archive'))
      .send({ drive: 'archive', operation: 'create' })
      .expect(200)
    await authed(request(app).head(`/me/gfs/uploads/${uploadId}?drive=archive`)).expect(200)
    await authed(
      request(app).get(`/me/gfs/uploads/${uploadId}/status?drive=archive&limit=256&cursor=next`)
    ).expect(200)
    await authed(
      request(app)
        .put(`/me/gfs/uploads/${uploadId}/parts/0?drive=archive`)
        .set('content-type', 'application/offset+octet-stream')
        .set('upload-part-number', '0')
        .set('upload-offset', '0')
        .set('upload-chunk-length', '4')
        .set('upload-checksum', 'sha256 dGVzdA==')
    )
      .send(Buffer.from('test'))
      .expect(200)
    for (const action of ['pause', 'resume', 'complete']) {
      await authed(request(app).post(`/me/gfs/uploads/${uploadId}/${action}?drive=archive`))
        .send({})
        .expect(200)
    }
    await authed(request(app).delete(`/me/gfs/uploads/${uploadId}?drive=archive`)).expect(200)

    expect(streamedPart.toString()).toBe('test')
    expect(clientMock.controlApiStreamRequest).toHaveBeenCalledTimes(9)
    for (const call of clientMock.controlApiStreamRequest.mock.calls) {
      expect(call[2]).toMatchObject({
        userSessionToken: 'sess-xyz',
        query: { drive: 'archive' },
      })
    }
    const partOptions = clientMock.controlApiStreamRequest.mock.calls[4][2]
    expect(partOptions.extraHeaders).toMatchObject({
      'content-length': '4',
      'upload-chunk-length': '4',
      'x-gfs-upload-source-ip': expect.any(String),
    })
  })

  it('propagates the authoritative upload 429 and Retry-After header unchanged', async () => {
    clientMock.controlApiStreamRequest.mockRejectedValue(
      new ControlApiError(
        'rate limited',
        429,
        { error: 'gfs_upload_rate_limited', limit: 'principal_bytes', retryAfterSeconds: 7 },
        new Headers({ 'retry-after': '7' })
      )
    )
    const response = await request(buildApp())
      .get('/me/gfs/capabilities?drive=archive')
      .set('authorization', 'Bearer sess-xyz')
    expect(response.status).toBe(429)
    expect(response.headers['retry-after']).toBe('7')
    expect(response.body).toEqual({
      error: 'gfs_upload_rate_limited',
      limit: 'principal_bytes',
      retryAfterSeconds: 7,
    })
  })

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
    expect(res.body).toEqual({ error: 'Too Many Requests', retryAfterSeconds: 17 })
  })
})
