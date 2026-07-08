import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { UiAuthedRequest } from '../src/middleware/controlUIAuth.js'
import { requireAuthForControlUI } from '../src/middleware/controlUIAuth.js'

const adminTokenMock = vi.hoisted(() => ({
  verifyAdminToken: vi.fn(),
}))

const adminSvcMock = vi.hoisted(() => ({
  findAdminById: vi.fn(),
  isAdminTokenRevoked: vi.fn(),
}))

vi.mock('../src/utils/auth/adminAuthToken.js', () => adminTokenMock)
vi.mock('../src/services/adminAuthService.js', () => adminSvcMock)

describe('middleware/controlUIAuth', () => {
  beforeEach(() => {
    adminTokenMock.verifyAdminToken.mockReset()
    adminSvcMock.findAdminById.mockReset()
    adminSvcMock.isAdminTokenRevoked.mockReset()
  })

  it('accepts the HttpOnly admin session cookie as the UI auth token', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue({
      sub: 'admin-id',
      typ: 'user',
      role: 'admin',
      jti: 'j1',
      exp: 9999999999,
      sessionVersion: 2,
    })
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue({
      id: 'admin-id',
      status: 'active',
      sessionVersion: 2,
    })

    const app = express()
    app.get('/protected', requireAuthForControlUI, (req: UiAuthedRequest, res) => {
      res.status(200).json({ adminId: req.adminAuth?.sub })
    })

    const res = await request(app)
      .get('/protected')
      .set('cookie', 'control_ui_admin_session=admin-cookie-token')
      .expect(200)

    expect(res.body).toEqual({ adminId: 'admin-id' })
    expect(adminTokenMock.verifyAdminToken).toHaveBeenCalledWith('admin-cookie-token')
  })

  it('rejects legacy bearer tokens for Control UI browser auth', async () => {
    const app = express()
    app.get('/protected', requireAuthForControlUI, (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app).get('/protected').set('authorization', 'Bearer old-admin-token').expect(401)

    expect(adminTokenMock.verifyAdminToken).not.toHaveBeenCalled()
  })
})
