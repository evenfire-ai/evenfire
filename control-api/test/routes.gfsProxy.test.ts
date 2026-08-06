import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

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

  it('returns 504 gfsc_timeout when the gfsc fetch times out', async () => {
    const fetchMock = vi.fn(async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    })
    vi.stubGlobal('fetch', fetchMock)

    const app = await buildApp()
    const res = await request(app)
      .post('/api/v1/gfs/proxy/v1/resources/root/children')
      .send({ name: 'x', kind: 'file' })

    expect(res.status).toBe(504)
    expect(res.body).toEqual({ error: 'gfsc_timeout' })
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
})
