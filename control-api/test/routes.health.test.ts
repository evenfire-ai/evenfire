import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createHealthRouter } from '../src/routes/health.js'
import { MockGateway } from './mockGateway.js'

const mockConnect = vi.hoisted(() => vi.fn())

vi.mock('../src/db.js', () => ({
  pool: {
    connect: mockConnect,
  },
}))

describe('routes/health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnect.mockReset()
  })

  it('returns status ok with namespace', async () => {
    const app = express()
    app.use(createHealthRouter(new MockGateway('control-plane') as never))

    const res = await request(app).get('/health').expect(200)
    expect(res.body).toEqual({
      status: 'ok',
      namespace: 'control-plane',
    })
  })

  it('returns 404 for unsupported method/path', async () => {
    const app = express()
    app.use(createHealthRouter(new MockGateway('control-plane') as never))

    await request(app).post('/health').expect(404)
    await request(app).get('/not-health').expect(404)
  })

  it('does not expose raw database errors from notification health', async () => {
    mockConnect.mockRejectedValueOnce(new Error('password auth failed for user postgres'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = express()
    app.use(createHealthRouter(new MockGateway('control-plane') as never))

    const res = await request(app).get('/health/notifications').expect(503)

    expect(res.body).toMatchObject({
      status: 'error',
      dbRead: 'error',
      streamRouteMounted: true,
      listenWakeup: 'degraded',
      error: 'notification_health_unavailable',
    })
    expect(JSON.stringify(res.body)).not.toContain('password auth failed')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
