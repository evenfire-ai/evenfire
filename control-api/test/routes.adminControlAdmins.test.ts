import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminControlAdminsRouter } from '../src/routes/admin/controlAdmins.js'

const adminSvc = vi.hoisted(() => ({
  createControlAdminEmailChangeRequest: vi.fn(),
  createControlAdminInvitation: vi.fn(),
  deleteControlAdmin: vi.fn(),
  findAdminById: vi.fn(),
  getPendingControlAdminEmailChangeForAdmin: vi.fn(),
  isValidAdminEmail: vi.fn(() => true),
  isValidAdminUsername: vi.fn(() => true),
  listControlAdmins: vi.fn(),
  revokeControlAdminEmailChangeRequest: vi.fn(),
  revokeControlAdminInvitation: vi.fn(),
  updateAdminPassword: vi.fn(),
  updateAdminUsername: vi.fn(),
}))

const controlAdminInvitationRegistrationSvc = vi.hoisted(() => ({
  registerAndSendControlAdminEmailConfirmation: vi.fn(),
  registerAndSendControlAdminInvitation: vi.fn(),
}))

const uiAuth = vi.hoisted(() => ({
  requireAuthForControlUI: vi.fn((req: any, _res: any, next: any) => {
    req.adminAuth = {
      sub: 'current-admin-id',
      role: 'admin',
      jti: 'j1',
      exp: 9999999999,
      typ: 'user',
    }
    next()
  }),
}))

vi.mock('../src/services/adminAuthService.js', () => adminSvc)
vi.mock(
  '../src/services/controlAdminInvitationRegistrationService.js',
  () => controlAdminInvitationRegistrationSvc
)
vi.mock('../src/middleware/controlUIAuth.js', () => uiAuth)

function createTestApp() {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => {
    req.adminAuth = {
      sub: 'current-admin-id',
      role: 'admin',
      jti: 'j1',
      exp: 9999999999,
      typ: 'user',
    }
    next()
  })
  app.use(createAdminControlAdminsRouter())
  return app
}

describe('routes/adminControlAdmins', () => {
  beforeEach(() => {
    Object.values(adminSvc).forEach(fn => fn.mockReset())
    Object.values(controlAdminInvitationRegistrationSvc).forEach(fn => fn.mockReset())
    Object.values(uiAuth).forEach(fn => fn.mockClear())
  })

  it('deletes another admin', async () => {
    adminSvc.deleteControlAdmin.mockResolvedValue({ deleted: true })

    const res = await request(createTestApp())
      .delete('/admin/control-admins/other-admin-id')
      .expect(200)

    expect(res.body).toEqual({ deleted: true })
    expect(adminSvc.deleteControlAdmin).toHaveBeenCalledWith('current-admin-id', 'other-admin-id')
  })

  it('rejects deleting the current admin', async () => {
    const res = await request(createTestApp())
      .delete('/admin/control-admins/current-admin-id')
      .expect(400)

    expect(res.body).toEqual({ error: 'cannot_delete_current_admin' })
    expect(adminSvc.deleteControlAdmin).not.toHaveBeenCalled()
  })

  it('returns 404 when the target admin does not exist', async () => {
    adminSvc.deleteControlAdmin.mockResolvedValue({ error: 'not_found' })

    const res = await request(createTestApp())
      .delete('/admin/control-admins/missing-admin-id')
      .expect(404)

    expect(res.body).toEqual({ error: 'not_found' })
  })
})
