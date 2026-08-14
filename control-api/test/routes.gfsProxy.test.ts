import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
// Imports the MOCKED config object below; mutating gfscProxyTimeoutMs on it lets a
// test drive a real deadline abort (see the 504 timeout test).
import { config } from '../src/config.js'

const mockSignGfsToken = vi.hoisted(() => vi.fn())

vi.mock('../src/config.js', () => ({
  config: {
    gfscBaseUrl: 'http://gfsc.gfs.svc:8087',
    gfscWriteBaseUrl: 'http://gfsc-writer.gfs.svc:8087',
    gfscProxyTimeoutMs: 300_000,
  },
}))

vi.mock('../src/auth/gfsToken.js', () => ({
  GFS_DELETE_SCOPE: 'gfs.delete',
  GFS_READ_SCOPE: 'gfs.read',
  GFS_WRITE_SCOPE: 'gfs.write',
  signGfsToken: (...a: unknown[]) => mockSignGfsToken(...a),
}))

vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (
    req: { adminAuth?: { sub: string } },
    _res: unknown,
    next: () => void
  ) => {
    req.adminAuth = { sub: 'operator' }
    next()
  },
}))

async function buildApp() {
  const { registerGfsProxyRoute } = await import('../src/routes/gfs/proxy.js')
  const router = express.Router()
  const app = express()
  app.use(express.json())
  registerGfsProxyRoute(router)
  app.use('/api/v1', router)
  return app
}

beforeEach(() => {
  mockSignGfsToken.mockReset()
  mockSignGfsToken.mockReturnValue({ token: 'x' })
  // Reset the (mutable) mocked timeout so a test that shrinks it can't leak into others.
  ;(config as { gfscProxyTimeoutMs: number }).gfscProxyTimeoutMs = 300_000
})

afterEach(() => vi.unstubAllGlobals())

describe('/api/v1/gfs/proxy', () => {
  it('sends reads to the read service', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = await buildApp()
    const res = await request(app).get('/api/v1/gfs/proxy/v1/resources/root/children')

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gfsc.gfs.svc:8087/v1/resources/root/children',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('sends upload capabilities and status reads to the writer service', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = await buildApp()
    const status = await request(app).get(
      '/api/v1/gfs/proxy/v1/uploads/01234567-89ab-cdef-0123-456789abcdef/status?limit=256'
    )
    const capabilities = await request(app).get('/api/v1/gfs/proxy/v1/capabilities')

    expect(status.status).toBe(200)
    expect(capabilities.status).toBe(200)
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://gfsc-writer.gfs.svc:8087/v1/uploads/01234567-89ab-cdef-0123-456789abcdef/status?limit=256'
    )
    expect(fetchMock.mock.calls[1][0]).toBe('http://gfsc-writer.gfs.svc:8087/v1/capabilities')
  })

  it('sends mutations to the writer service', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = await buildApp()
    const res = await request(app)
      .post('/api/v1/gfs/proxy/v1/resources/root/children')
      .send({ name: 'docs', kind: 'directory' })

    expect(res.status).toBe(201)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gfsc-writer.gfs.svc:8087/v1/resources/root/children',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'docs', kind: 'directory' }),
      })
    )
  })

  it('returns 504 gfsc_timeout on a REAL deadline abort (AbortError, signal.aborted)', async () => {
    // The proxy aborts its OWN AbortController via setTimeout, so a real timeout
    // surfaces as AbortError with signal.aborted===true — NOT a TimeoutError. A
    // fetch mock that respects the signal (rejects with signal.reason on abort)
    // exercises the real `deadline.signal.aborted` branch; injecting a TimeoutError
    // (as before) only hit the defensive fallback and left the real path untested.
    ;(config as { gfscProxyTimeoutMs: number }).gfscProxyTimeoutMs = 20
    const fetchMock = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason))
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = await buildApp()
    const res = await request(app)
      .post('/api/v1/gfs/proxy/v1/resources/root/children')
      .send({ name: 'x', kind: 'file' })

    expect(res.status).toBe(504)
    expect(res.body).toEqual({ error: 'gfsc_timeout' })
    // Prove the mock actually saw an aborted signal (i.e. the real timeout path ran).
    const init = fetchMock.mock.calls[0][1]
    expect(init.signal.aborted).toBe(true)
  })

  it('returns 502 gfsc_unreachable when the gfsc fetch fails', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    })
    vi.stubGlobal('fetch', fetchMock)

    const app = await buildApp()
    const res = await request(app).get('/api/v1/gfs/proxy/v1/resources/root/children')

    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'gfsc_unreachable' })
  })

  it('forwards a gfsc 5xx error body verbatim (never a silent 500)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: { code: 'internal', message: 'boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = await buildApp()
    const res = await request(app)
      .post('/api/v1/gfs/proxy/v1/resources/root/children')
      .send({ name: 'x', kind: 'file' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ ok: false, error: { code: 'internal', message: 'boom' } })
  })

  it('forwards a gfsc 413 payload_too_large verbatim', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: { code: 'payload_too_large' } }), {
          status: 413,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = await buildApp()
    const res = await request(app)
      .post('/api/v1/gfs/proxy/v1/resources/root/children')
      .send({ name: 'x', kind: 'file' })

    expect(res.status).toBe(413)
    expect(res.body).toEqual({ ok: false, error: { code: 'payload_too_large' } })
  })

  it('preserves upload-length and Retry-After headers for lifecycle clients', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"error":"quota_exceeded"}', {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '3',
            'x-ratelimit-limit': '4',
            'x-gfs-ratelimit-scope': 'active_part_streams_global',
            'x-ratelimit-remaining': '0',
            'upload-length': '209715200',
          },
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = await buildApp()
    const res = await request(app).post('/api/v1/gfs/proxy/v1/uploads').send({})

    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBe('3')
    expect(res.headers['x-ratelimit-limit']).toBe('4')
    expect(res.headers['x-gfs-ratelimit-scope']).toBe('active_part_streams_global')
    expect(res.headers['x-ratelimit-remaining']).toBe('0')
    expect(res.headers['upload-length']).toBe('209715200')
  })

  it('preserves the bounded upload response headers on successful lifecycle responses', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 204,
          headers: {
            location: '/v1/uploads/01234567-89ab-cdef-0123-456789abcdef',
            'upload-offset': '8388608',
            'upload-active-parts': '1',
            'upload-state': 'uploading',
          },
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = await buildApp()
    const res = await request(app).head(
      '/api/v1/gfs/proxy/v1/uploads/01234567-89ab-cdef-0123-456789abcdef'
    )

    expect(res.status).toBe(204)
    expect(res.headers.location).toContain('/v1/uploads/')
    expect(res.headers['upload-offset']).toBe('8388608')
    expect(res.headers['upload-active-parts']).toBe('1')
    expect(res.headers['upload-state']).toBe('uploading')
  })
})
