import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { UiAuthedRequest } from '../src/middleware/controlUIAuth.js'
import { requireAuthForControlUI } from '../src/middleware/controlUIAuth.js'
import { rateLimitMiddleware } from '../src/middleware/rateLimitMiddleware.js'

const adminTokenMock = vi.hoisted(() => ({
  verifyAdminToken: vi.fn(),
}))

const adminSvcMock = vi.hoisted(() => ({
  findAdminById: vi.fn(),
  isAdminTokenRevoked: vi.fn(),
}))

const mockCheckAndIncrement = vi.hoisted(() => vi.fn())

vi.mock('../src/utils/auth/adminAuthToken.js', () => adminTokenMock)
vi.mock('../src/services/adminAuthService.js', () => adminSvcMock)
vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: (...args: unknown[]) => mockCheckAndIncrement(...args),
}))
vi.mock('../src/observability/metrics.js', () => ({
  rateLimitHitsTotal: { inc: vi.fn() },
}))

const testAuthRateLimit = rateLimitMiddleware({
  bucketType: 'control_ui_auth_test',
  maxPerMinute: 100,
  getBucketKey: () => 'control-ui-auth-test',
})

const BASE_CLAIMS = {
  sub: 'admin-id',
  typ: 'user' as const,
  role: 'admin' as const,
  jti: 'j1',
  exp: 9999999999,
  sessionVersion: 2,
}

function makeProtectedApp() {
  const app = express()
  app.get('/protected', testAuthRateLimit, requireAuthForControlUI, (req: UiAuthedRequest, res) => {
    res.status(200).json({ adminId: req.adminAuth?.sub })
  })
  return app
}

describe('middleware/controlUIAuth', () => {
  beforeEach(() => {
    adminTokenMock.verifyAdminToken.mockReset()
    adminSvcMock.findAdminById.mockReset()
    adminSvcMock.isAdminTokenRevoked.mockReset()
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 99,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })
  })

  it('accepts the HttpOnly admin session cookie as the UI auth token', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue({
      id: 'admin-id',
      status: 'active',
      sessionVersion: 2,
    })

    const res = await request(makeProtectedApp())
      .get('/protected')
      .set('cookie', 'control_ui_admin_session=admin-cookie-token')
      .expect(200)

    expect(res.body).toEqual({ adminId: 'admin-id' })
    expect(adminTokenMock.verifyAdminToken).toHaveBeenCalledWith('admin-cookie-token')
  })

  it('rejects legacy bearer tokens for Control UI browser auth', async () => {
    await request(makeProtectedApp())
      .get('/protected')
      .set('authorization', 'Bearer old-admin-token')
      .expect(401)

    expect(adminTokenMock.verifyAdminToken).not.toHaveBeenCalled()
  })

  it('rejects revoked administrator JTIs', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(true)

    await request(makeProtectedApp())
      .get('/protected')
      .set('cookie', 'control_ui_admin_session=admin-cookie-token')
      .expect(401)

    expect(adminSvcMock.findAdminById).not.toHaveBeenCalled()
  })

  it('rejects stale sessionVersion claims after password reset', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue({ ...BASE_CLAIMS, sessionVersion: 1 })
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue({
      id: 'admin-id',
      status: 'active',
      sessionVersion: 2,
    })

    await request(makeProtectedApp())
      .get('/protected')
      .set('cookie', 'control_ui_admin_session=admin-cookie-token')
      .expect(401)
  })

  it('rejects disabled administrator accounts', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue({
      id: 'admin-id',
      status: 'disabled',
      sessionVersion: 2,
    })

    await request(makeProtectedApp())
      .get('/protected')
      .set('cookie', 'control_ui_admin_session=admin-cookie-token')
      .expect(401)
  })

  it('propagates findAdminById failures via Express error handling', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockRejectedValue(new Error('pg connection terminated'))

    const app = express()
    app.get('/protected', testAuthRateLimit, requireAuthForControlUI, (_req, res) => {
      res.status(200).json({ ok: true })
    })
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message })
      }
    )

    const res = await request(app)
      .get('/protected')
      .set('cookie', 'control_ui_admin_session=admin-cookie-token')
      .expect(500)

    expect(res.body).toEqual({ error: 'pg connection terminated' })
  })
})
