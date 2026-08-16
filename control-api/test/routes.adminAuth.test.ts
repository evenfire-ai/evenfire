import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAdminAuthRouter } from '../src/routes/admin/auth.js'

const directorySvc = vi.hoisted(() => ({
  provisionAdminDesktopWorkspace: vi.fn(),
}))
// auth.ts imports provisionAdminDesktopWorkspace from the directory barrel; mock the barrel here.
vi.mock('../src/services/directory/index.js', () => directorySvc)

const adminSvc = vi.hoisted(() => ({
  completeControlAdminEmailChangeRequest: vi.fn(),
  completeControlAdminInvitation: vi.fn(),
  completeControlAdminPasswordResetRequest: vi.fn(),
  createControlAdminPasswordResetRequest: vi.fn(),
  findAdminById: vi.fn(),
  findAdminByLogin: vi.fn(),
  getPendingControlAdminEmailChangeRequest: vi.fn(),
  getPendingControlAdminInvitation: vi.fn(),
  getPendingControlAdminPasswordResetRequest: vi.fn(),
  isValidAdminEmail: vi.fn(() => true),
  isValidAdminUsername: vi.fn(() => true),
  registerAdminFailedLogin: vi.fn(),
  registerAdminSuccessfulLogin: vi.fn(),
  revokeControlAdminPasswordResetRequest: vi.fn(),
  revokeAdminTokenJti: vi.fn(),
  setupInitialAdminCredentials: vi.fn(),
  setupInitialAdminWithDesktopWorkspace: vi.fn(),
}))

const adminToken = vi.hoisted(() => ({
  signAdminToken: vi.fn(() => 'admin-jwt'),
}))

const controlAdminInvitationRegistrationSvc = vi.hoisted(() => ({
  registerAndSendControlAdminPasswordReset: vi.fn(),
  validateControlAdminEmailConfirmationToken: vi.fn(),
  validateControlAdminInvitationToken: vi.fn(),
  validateControlAdminPasswordResetToken: vi.fn(),
}))

const uiAuth = vi.hoisted(() => ({
  requireAuthForControlUI: vi.fn((req: any, _res: any, next: any) => {
    req.adminAuth = { sub: 'admin-id', role: 'admin', jti: 'j1', exp: 9999999999, typ: 'user' }
    next()
  }),
}))

const rateLimit = vi.hoisted(() => ({
  rateLimitMiddleware: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}))

vi.mock('../src/services/adminAuthService.js', () => adminSvc)
vi.mock('../src/services/initialAdminSetupService.js', () => ({
  setupInitialAdminWithDesktopWorkspace: adminSvc.setupInitialAdminWithDesktopWorkspace,
}))
vi.mock(
  '../src/services/controlAdminInvitationRegistrationService.js',
  () => controlAdminInvitationRegistrationSvc
)
vi.mock('../src/utils/auth/adminAuthToken.js', () => adminToken)
vi.mock('../src/middleware/controlUIAuth.js', () => uiAuth)
vi.mock('../src/middleware/rateLimitMiddleware.js', () => rateLimit)

describe('routes/adminAuth', () => {
  beforeEach(() => {
    Object.values(directorySvc).forEach(fn => fn.mockReset())
    Object.values(adminSvc).forEach(fn => fn.mockReset())
    Object.values(adminToken).forEach(fn => fn.mockReset())
    Object.values(controlAdminInvitationRegistrationSvc).forEach(fn => fn.mockReset())
    Object.values(uiAuth).forEach(fn => fn.mockReset())
    Object.values(rateLimit).forEach(fn => fn.mockClear())
    adminSvc.isValidAdminEmail.mockReturnValue(true)
    adminSvc.isValidAdminUsername.mockReturnValue(true)
    config.desktopGfsOperatorLinkingEnabled = false
    adminToken.signAdminToken.mockReturnValue('admin-jwt')
    uiAuth.requireAuthForControlUI.mockImplementation((req: any, _res: any, next: any) => {
      req.adminAuth = { sub: 'admin-id', role: 'admin', jti: 'j1', exp: 9999999999, typ: 'user' }
      next()
    })
  })

  it('logs in with valid username/password', async () => {
    adminSvc.findAdminByLogin.mockResolvedValue({
      id: 'admin-id',
      username: 'admin',
      email: 'admin@example.com',
      passwordHash: '$2b$12$9QdfGGp5KYg8osGa1n0.DuwQiB1RopCWIDJhmsuK4ygjTmIT8pvgy',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })
    adminSvc.registerAdminSuccessfulLogin.mockResolvedValue(undefined)

    const app = express()
    app.set('trust proxy', 1)
    app.use(express.json())
    app.use(createAdminAuthRouter())

    const res = await request(app)
      .post('/admin/auth/login')
      .set('x-forwarded-proto', 'https')
      .send({ username: 'admin', password: 'changeme123!' })
      .expect(200)

    expect(res.body.token).toBeUndefined()
    expect(String(res.headers['set-cookie'])).toContain('control_ui_admin_session=admin-jwt')
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly')
    expect(String(res.headers['set-cookie'])).toContain('Secure')
    expect(String(res.headers['set-cookie'])).toContain('SameSite=Lax')
    expect(adminSvc.registerAdminSuccessfulLogin).toHaveBeenCalledWith('admin-id')
  })

  it('sets up the initial admin with email, username, and password', async () => {
    adminSvc.setupInitialAdminCredentials.mockResolvedValue({
      id: 'admin-id',
      username: 'admin',
      email: 'admin@example.com',
      passwordHash: 'hash',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })

    const app = express()
    app.use(express.json())
    app.use(createAdminAuthRouter())

    const res = await request(app)
      .post('/admin/auth/setup')
      .send({ email: 'Admin@Example.com', username: 'admin', password: 'changeme123!' })
      .expect(200)

    expect(res.body.me).toMatchObject({
      id: 'admin-id',
      username: 'admin',
      email: 'admin@example.com',
      role: 'admin',
    })
    expect(adminSvc.setupInitialAdminCredentials).toHaveBeenCalledWith(
      expect.any(String),
      'admin@example.com',
      'admin',
      expect.stringMatching(/^\$2/)
    )
  })

  it('rejects invalid password and updates failure count', async () => {
    adminSvc.findAdminByLogin.mockResolvedValue({
      id: 'admin-id',
      username: 'admin',
      email: 'admin@example.com',
      passwordHash: '$2b$12$9QdfGGp5KYg8osGa1n0.DuwQiB1RopCWIDJhmsuK4ygjTmIT8pvgy',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })
    adminSvc.registerAdminFailedLogin.mockResolvedValue(undefined)

    const app = express()
    app.use(express.json())
    app.use(createAdminAuthRouter())

    await request(app)
      .post('/admin/auth/login')
      .send({ username: 'admin', password: 'wrong-pass' })
      .expect(401)

    expect(adminSvc.registerAdminFailedLogin).toHaveBeenCalled()
  })

  it('provisions the desktop workspace after first-run setup', async () => {
    adminSvc.setupInitialAdminCredentials.mockResolvedValue({
      id: 'admin-1',
      username: 'newadmin',
      email: 'new@example.com',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })
    directorySvc.provisionAdminDesktopWorkspace.mockResolvedValue(undefined)

    const app = express()
    app.use(express.json())
    app.use(createAdminAuthRouter())

    const res = await request(app)
      .post('/admin/auth/setup')
      .send({ email: 'New@Example.com', username: 'newadmin', password: 'secret123' })

    expect(res.status).toBe(200)
    expect(directorySvc.provisionAdminDesktopWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        controlAdminId: 'admin-1',
        email: 'new@example.com',
        displayName: 'newadmin',
        passwordHash: expect.any(String),
        agentNames: expect.any(Array),
        contextIds: expect.any(Array),
        linkDesktopOperator: false,
      })
    )
  })

  it('requests the exact initial-setup link only when the narrow self-hosted flag is enabled', async () => {
    config.desktopGfsOperatorLinkingEnabled = true
    adminSvc.setupInitialAdminWithDesktopWorkspace.mockResolvedValue({
      id: 'admin-1',
      username: 'newadmin',
      email: 'new@example.com',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })

    const app = express()
    app.use(express.json())
    app.use(createAdminAuthRouter())

    await request(app)
      .post('/admin/auth/setup')
      .send({ email: 'new@example.com', username: 'newadmin', password: 'secret123' })
      .expect(200)

    expect(adminSvc.setupInitialAdminWithDesktopWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrapUsername: expect.any(String),
        email: 'new@example.com',
        username: 'newadmin',
        linkDesktopOperator: true,
      })
    )
  })

  it('threads seedDesktopPassword:false through to provisioning as seedPassword:false', async () => {
    adminSvc.setupInitialAdminCredentials.mockResolvedValue({
      id: 'admin-1',
      username: 'newadmin',
      email: 'new@example.com',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })
    directorySvc.provisionAdminDesktopWorkspace.mockResolvedValue(undefined)

    const app = express()
    app.use(express.json())
    app.use(createAdminAuthRouter())

    const res = await request(app).post('/admin/auth/setup').send({
      email: 'new@example.com',
      username: 'newadmin',
      password: 'secret123',
      seedDesktopPassword: false,
    })

    expect(res.status).toBe(200)
    expect(directorySvc.provisionAdminDesktopWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ seedPassword: false })
    )
  })

  it('defaults seedPassword:true when the flag is absent or non-boolean', async () => {
    adminSvc.setupInitialAdminCredentials.mockResolvedValue({
      id: 'admin-1',
      username: 'newadmin',
      email: 'new@example.com',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })
    directorySvc.provisionAdminDesktopWorkspace.mockResolvedValue(undefined)

    const app = express()
    app.use(express.json())
    app.use(createAdminAuthRouter())

    // absent → true
    await request(app)
      .post('/admin/auth/setup')
      .send({ email: 'new@example.com', username: 'newadmin', password: 'secret123' })
    expect(directorySvc.provisionAdminDesktopWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ seedPassword: true })
    )

    // string "false" (non-boolean junk) → true; only literal false opts out
    adminSvc.setupInitialAdminCredentials.mockResolvedValue({
      id: 'admin-1',
      username: 'newadmin',
      email: 'new@example.com',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })
    await request(app).post('/admin/auth/setup').send({
      email: 'new2@example.com',
      username: 'newadmin2',
      password: 'secret123',
      seedDesktopPassword: 'false',
    })
    expect(directorySvc.provisionAdminDesktopWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ seedPassword: true })
    )
  })

  it('fails closed and remains retryable when self-hosted provisioning throws', async () => {
    config.desktopGfsOperatorLinkingEnabled = true
    adminSvc.setupInitialAdminWithDesktopWorkspace.mockRejectedValue(new Error('boom'))
    adminSvc.setupInitialAdminCredentials.mockResolvedValue({
      id: 'admin-1',
      username: 'newadmin',
      email: 'new@example.com',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })

    const app = express()
    app.use(express.json())
    app.use(createAdminAuthRouter())

    const res = await request(app)
      .post('/admin/auth/setup')
      .send({ email: 'new@example.com', username: 'newadmin', password: 'secret123' })

    expect(res.status).toBe(503)
    expect(res.body.token).toBeUndefined()
    expect(String(res.headers['set-cookie'] || '')).not.toContain('control_ui_admin_session=')
    expect(res.body).toEqual({ error: 'Initial admin setup is incomplete; retry' })
  })

  it('returns me and supports logout', async () => {
    adminSvc.findAdminById.mockResolvedValue({
      id: 'admin-id',
      username: 'admin',
      email: 'admin@example.com',
      passwordHash: 'hash',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })
    adminSvc.revokeAdminTokenJti.mockResolvedValue(undefined)

    const app = express()
    app.use(express.json())
    app.use(createAdminAuthRouter())

    const meRes = await request(app)
      .get('/admin/auth/me')
      .set('authorization', 'Bearer token')
      .expect(200)
    // Exposes the recipe-secret namespaces the UI must write secrets to (the
    // same source of truth POST /admin/recipes/secrets validates against).
    expect(meRes.body.namespaces).toEqual({
      sandbox: config.sandboxNamespace,
      mcpServer: config.mcpServersNamespace,
    })
    const logoutRes = await request(app)
      .post('/admin/auth/logout')
      .set('authorization', 'Bearer token')
      .expect(200)
    expect(String(logoutRes.headers['set-cookie'])).toContain('control_ui_admin_session=')
    expect(String(logoutRes.headers['set-cookie'])).toContain('Expires=Thu, 01 Jan 1970')
    expect(adminSvc.revokeAdminTokenJti).toHaveBeenCalledWith('j1', 9999999999)
  })

  it('validates control admin email confirmation tokens', async () => {
    controlAdminInvitationRegistrationSvc.validateControlAdminEmailConfirmationToken.mockResolvedValue(
      {
        email: 'admin@example.com',
        confirmationUuid: 'confirmation-id',
      }
    )
    adminSvc.getPendingControlAdminEmailChangeRequest.mockResolvedValue({
      id: 'confirmation-id',
      adminId: 'admin-id',
      email: 'admin@example.com',
      status: 'pending',
      expiresAt: new Date('2026-04-23T10:00:00.000Z'),
      createdAt: new Date('2026-04-21T10:00:00.000Z'),
      confirmedAt: null,
    })

    const app = express()
    app.use(express.json())
    app.use(createAdminAuthRouter())

    const res = await request(app)
      .post('/admin/auth/control-admin-email-confirmations/validate')
      .send({ token: 'signed.jwt.value' })
      .expect(200)

    expect(res.body).toEqual({
      valid: true,
      email: 'admin@example.com',
      confirmationUuid: 'confirmation-id',
    })
    expect(
      controlAdminInvitationRegistrationSvc.validateControlAdminEmailConfirmationToken
    ).toHaveBeenCalledWith('signed.jwt.value', undefined)
  })

  it('completes control admin email confirmations', async () => {
    controlAdminInvitationRegistrationSvc.validateControlAdminEmailConfirmationToken.mockResolvedValue(
      {
        email: 'admin@example.com',
        confirmationUuid: 'confirmation-id',
      }
    )
    adminSvc.completeControlAdminEmailChangeRequest.mockResolvedValue({
      id: 'admin-id',
      username: 'admin',
      email: 'admin@example.com',
      passwordHash: 'hash',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })

    const app = express()
    app.use(express.json())
    app.use(createAdminAuthRouter())

    const res = await request(app)
      .post('/admin/auth/control-admin-email-confirmations/complete')
      .send({ token: 'signed.jwt.value', email: 'Admin@Example.com' })
      .expect(200)

    expect(res.body).toEqual({
      completed: true,
      alreadyConfirmed: false,
      login: {
        username: 'admin@example.com',
      },
    })
    expect(adminSvc.completeControlAdminEmailChangeRequest).toHaveBeenCalledWith({
      requestId: 'confirmation-id',
      email: 'admin@example.com',
    })
  })

  it('silently accepts password reset requests when no email-backed admin is found', async () => {
    adminSvc.createControlAdminPasswordResetRequest.mockResolvedValue({ skipped: true })

    const app = express()
    app.use(express.json())
    app.use(createAdminAuthRouter())

    const res = await request(app)
      .post('/admin/auth/password-reset/request')
      .send({ username: 'missing-admin' })
      .expect(202)

    expect(res.body).toEqual({ requested: true })
    expect(
      controlAdminInvitationRegistrationSvc.registerAndSendControlAdminPasswordReset
    ).not.toHaveBeenCalled()
  })

  it('completes control admin password resets', async () => {
    controlAdminInvitationRegistrationSvc.validateControlAdminPasswordResetToken.mockResolvedValue({
      email: 'admin@example.com',
      resetUuid: 'reset-id',
    })
    adminSvc.completeControlAdminPasswordResetRequest.mockResolvedValue({
      id: 'admin-id',
      username: 'admin',
      email: 'admin@example.com',
      passwordHash: 'hash',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })

    const app = express()
    app.use(express.json())
    app.use(createAdminAuthRouter())

    const res = await request(app)
      .post('/admin/auth/password-reset/complete')
      .send({ token: 'signed.jwt.value', email: 'Admin@Example.com', password: 'newpass!' })
      .expect(200)

    expect(res.body).toEqual({
      completed: true,
      login: {
        username: 'admin@example.com',
      },
    })
    expect(adminSvc.completeControlAdminPasswordResetRequest).toHaveBeenCalledWith({
      requestId: 'reset-id',
      email: 'admin@example.com',
      passwordHash: expect.stringMatching(/^\$2/),
    })
  })
})
