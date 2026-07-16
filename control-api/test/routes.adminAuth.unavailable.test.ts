import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

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
  rateLimitMiddleware: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}))

import { createAdminAuthRouter } from '../src/routes/admin/auth.js'
import {
  MemberRegistrationUnavailableError,
  memberRegistrationErrorResponse,
} from '../src/services/memberRegistrationErrors.js'

function app(): express.Express {
  const a = express()
  a.use(express.json())
  a.use(createAdminAuthRouter())
  a.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const mapped = memberRegistrationErrorResponse(err)
      if (mapped) return res.status(mapped.status).json({ error: mapped.error })
      res.status(500).json({ error: 'Internal Server Error' })
    }
  )
  return a
}

describe('admin auth validate routes when the hub is unavailable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('password-reset/validate returns 503, not 400 invalid_password_reset', async () => {
    adminReg.validateControlAdminPasswordResetToken.mockRejectedValue(
      new MemberRegistrationUnavailableError()
    )
    const res = await request(app())
      .post('/admin/auth/password-reset/validate')
      .send({ token: 't' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('member_registration_unavailable')
  })

  it('control-admin-invitations/validate returns 503, not 400 invalid_invitation', async () => {
    adminReg.validateControlAdminInvitationToken.mockRejectedValue(
      new MemberRegistrationUnavailableError()
    )
    const res = await request(app())
      .post('/admin/auth/control-admin-invitations/validate')
      .send({ token: 't' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('member_registration_unavailable')
  })

  it('control-admin-email-confirmations/validate returns 503, not 400 invalid_confirmation', async () => {
    adminReg.validateControlAdminEmailConfirmationToken.mockRejectedValue(
      new MemberRegistrationUnavailableError()
    )
    const res = await request(app())
      .post('/admin/auth/control-admin-email-confirmations/validate')
      .send({ token: 't' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('member_registration_unavailable')
  })

  it('REGRESSION: a generic validation error still maps to 400 invalid_password_reset', async () => {
    adminReg.validateControlAdminPasswordResetToken.mockRejectedValue(new Error('bad token'))
    const res = await request(app())
      .post('/admin/auth/password-reset/validate')
      .send({ token: 't' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_password_reset')
  })
})
