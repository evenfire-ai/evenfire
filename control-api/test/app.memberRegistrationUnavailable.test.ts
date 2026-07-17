import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MemberRegistrationUnavailableError } from '../src/services/memberRegistrationErrors.js'
import { MockGateway } from './mockGateway.js'

const adminReg = vi.hoisted(() => ({
  registerAndSendControlAdminInvitation: vi.fn(),
  validateControlAdminInvitationToken: vi.fn(),
  registerAndSendControlAdminEmailConfirmation: vi.fn(),
  validateControlAdminEmailConfirmationToken: vi.fn(),
  registerAndSendControlAdminPasswordReset: vi.fn(),
  validateControlAdminPasswordResetToken: vi.fn(),
}))
vi.mock('../src/services/controlAdminInvitationRegistrationService.js', () => adminReg)
vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))

describe('app: member-registration unavailability maps to 503 (real error middleware)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // /admin/auth/* is mounted at app.ts:46, BEFORE the /admin auth gate at :49,
  // so this public validate route reaches the real middleware without a token.
  it('returns 503 member_registration_unavailable through the production app', async () => {
    adminReg.validateControlAdminPasswordResetToken.mockRejectedValue(
      new MemberRegistrationUnavailableError()
    )
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await request(app)
      .post('/api/v1/admin/auth/password-reset/validate')
      .send({ token: 't' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('member_registration_unavailable')
  })

  it('REGRESSION: an untyped error still gets the route catch-all, not the 503 branch', async () => {
    adminReg.validateControlAdminPasswordResetToken.mockRejectedValue(new Error('boom'))
    const app = createApp(new MockGateway('mcp-server') as never)
    const res = await request(app)
      .post('/api/v1/admin/auth/password-reset/validate')
      .send({ token: 't' })
    expect(res.status).toBe(400) // the route's own catch-all still owns generic errors
    expect(res.body.error).toBe('invalid_password_reset')
  })
})
