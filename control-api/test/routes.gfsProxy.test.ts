import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const mockSignGfsToken = vi.hoisted(() => vi.fn())

vi.mock('../src/config.js', () => ({
  config: {
    gfscBaseUrl: 'http://gfsc.gfs.svc:8087',
    gfscWriteBaseUrl: 'http://gfsc-writer.gfs.svc:8087',
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
})
