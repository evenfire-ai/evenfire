import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextFunction, Response } from 'express'
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

const BASE_CLAIMS = {
  sub: 'admin-id',
  typ: 'user' as const,
  role: 'admin' as const,
  jti: 'j1',
  exp: 9999999999,
  sessionVersion: 2,
}

function mockReq(cookie?: string, extraHeaders: Record<string, string> = {}): UiAuthedRequest {
  const headers: Record<string, string> = { ...extraHeaders }
  if (cookie) headers.cookie = cookie
  return {
    headers,
    header(name: string) {
      const key = name.toLowerCase()
      return headers[key] ?? headers[name]
    },
  } as UiAuthedRequest
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: unknown) {
      res.body = payload
      return res
    },
  }
  return res as Response & { statusCode: number; body: unknown }
}

async function invokeMiddleware(
  req: UiAuthedRequest,
  res: ReturnType<typeof mockRes>,
  next: NextFunction = vi.fn()
): Promise<{ next: NextFunction }> {
  await requireAuthForControlUI(req, res, next)
  return { next }
}

describe('middleware/controlUIAuth', () => {
  beforeEach(() => {
    adminTokenMock.verifyAdminToken.mockReset()
    adminSvcMock.findAdminById.mockReset()
    adminSvcMock.isAdminTokenRevoked.mockReset()
  })

  it('accepts the HttpOnly admin session cookie as the UI auth token', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue({
      id: 'admin-id',
      status: 'active',
      sessionVersion: 2,
    })

    const req = mockReq('control_ui_admin_session=admin-cookie-token')
    const res = mockRes()
    const next = vi.fn()
    await invokeMiddleware(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.adminAuth?.sub).toBe('admin-id')
    expect(adminTokenMock.verifyAdminToken).toHaveBeenCalledWith('admin-cookie-token')
  })

  it('rejects legacy bearer tokens for Control UI browser auth', async () => {
    const req = mockReq(undefined, { authorization: 'Bearer old-admin-token' })
    const res = mockRes()
    const next = vi.fn()
    await invokeMiddleware(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
    expect(next).not.toHaveBeenCalled()
    expect(adminTokenMock.verifyAdminToken).not.toHaveBeenCalled()
  })

  it('rejects revoked administrator JTIs', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(true)

    const req = mockReq('control_ui_admin_session=admin-cookie-token')
    const res = mockRes()
    const next = vi.fn()
    await invokeMiddleware(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(adminSvcMock.findAdminById).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects stale sessionVersion claims after password reset', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue({ ...BASE_CLAIMS, sessionVersion: 1 })
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue({
      id: 'admin-id',
      status: 'active',
      sessionVersion: 2,
    })

    const req = mockReq('control_ui_admin_session=admin-cookie-token')
    const res = mockRes()
    const next = vi.fn()
    await invokeMiddleware(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects disabled administrator accounts', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockResolvedValue({
      id: 'admin-id',
      status: 'disabled',
      sessionVersion: 2,
    })

    const req = mockReq('control_ui_admin_session=admin-cookie-token')
    const res = mockRes()
    const next = vi.fn()
    await invokeMiddleware(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('propagates findAdminById failures via Express error handling', async () => {
    adminTokenMock.verifyAdminToken.mockReturnValue(BASE_CLAIMS)
    adminSvcMock.isAdminTokenRevoked.mockResolvedValue(false)
    adminSvcMock.findAdminById.mockRejectedValue(new Error('pg connection terminated'))

    const req = mockReq('control_ui_admin_session=admin-cookie-token')
    const res = mockRes()
    const next = vi.fn()
    await invokeMiddleware(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0]).toEqual(new Error('pg connection terminated'))
    expect(res.statusCode).toBe(200)
  })
})
