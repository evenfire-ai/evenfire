import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import {
  MemberRegistrationUnavailableError,
  memberRegistrationErrorResponse,
} from '../src/services/memberRegistrationErrors.js'

const flow = vi.hoisted(() => ({
  validateInvitationFlowToken: vi.fn(),
  storeDesktopAuthorizationToken: vi.fn(),
}))
vi.mock('../src/services/invitationFlowRegistrationService.js', () => flow)

const directory = vi.hoisted(() => ({
  acceptInvitationForEmail: vi.fn(),
  getInvitationByToken: vi.fn(),
  listPendingInvitations: vi.fn(),
  setInvitationPasswordForEmail: vi.fn(),
  setInvitationPasswordForUser: vi.fn(),
  verifyUserPassword: vi.fn(),
}))
vi.mock('../src/services/directory/index.js', () => directory)

vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))
vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  rejectBodyUserTeamMismatch: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
  requireValidExternalSessionToken: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
}))
const sessionToken = vi.hoisted(() => ({ signExternalSessionToken: vi.fn(() => 'session-token') }))
vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => sessionToken)

// Router-level harness: proves the ROUTE GUARDS rethrow instead of swallowing.
// The real app.ts middleware is covered separately in
// test/app.memberRegistrationUnavailable.test.ts (Step 1b) — do not treat this
// local mapper as evidence that app.ts is wired.
function app(): express.Express {
  const a = express()
  a.use(express.json())
  a.use(createExternalInvitationsRouter())
  a.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const mapped = memberRegistrationErrorResponse(err)
      if (mapped) return res.status(mapped.status).json({ error: mapped.error })
      res.status(500).json({ error: 'Internal Server Error' })
    }
  )
  return a
}

describe('external invitation routes when the hub is unavailable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('GET token lookup returns 503 member_registration_unavailable, NOT 400 invalid_invitation', async () => {
    flow.validateInvitationFlowToken.mockRejectedValue(new MemberRegistrationUnavailableError())
    const res = await request(app()).get('/external/invitations/token/some-token')
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('member_registration_unavailable')
  })

  it('POST accept returns 503 when validation hits an unavailable hub', async () => {
    flow.validateInvitationFlowToken.mockRejectedValue(new MemberRegistrationUnavailableError())
    const res = await request(app())
      .post('/external/invitations/accept')
      .send({ email: 'a@b.c', token: 't' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('member_registration_unavailable')
  })

  it('REGRESSION: a generic validation error still maps to 400 invalid_invitation', async () => {
    flow.validateInvitationFlowToken.mockRejectedValue(new Error('invalid_invitation'))
    const res = await request(app()).get('/external/invitations/token/some-token')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_invitation')
  })

  it('issues a normal session only after trusted password-reset validation and completion', async () => {
    flow.validateInvitationFlowToken.mockResolvedValue({
      email: 'member@example.invalid',
      invitationUuid: 'Synthetic-producer-token-1',
    })
    directory.getInvitationByToken.mockResolvedValue({
      id: 'database-row-1',
      token: 'Synthetic-producer-token-1',
      email: 'member@example.invalid',
      purpose: 'password_reset',
      status: 'pending',
    })
    directory.setInvitationPasswordForEmail.mockResolvedValue({
      data: {
        id: 'database-row-1',
        userId: 'user-1',
        email: 'member@example.invalid',
        teamId: null,
        role: 'member',
        purpose: 'password_reset',
        status: 'accepted',
        lifecycleState: 'active',
        authGeneration: 7,
        passwordUpdated: true,
        sessionContext: {
          userId: 'user-1',
          email: 'member@example.invalid',
          teamId: 'team-1',
          role: 'admin',
          authGeneration: 7,
        },
      },
    })

    const res = await request(app())
      .post('/external/invitations/password-token')
      .send({
        token: 'Synthetic-trusted-reset-proof',
        email: 'member@example.invalid',
        invitationId: 'database-row-1',
        password: 'Synthetic-new-password',
      })
      .expect(200)

    expect(flow.validateInvitationFlowToken).toHaveBeenCalledWith(
      'Synthetic-trusted-reset-proof',
      'member@example.invalid'
    )
    expect(directory.setInvitationPasswordForEmail).toHaveBeenCalledWith(
      'member@example.invalid',
      'database-row-1',
      'Synthetic-new-password'
    )
    expect(sessionToken.signExternalSessionToken).toHaveBeenCalledWith({
      userId: 'user-1',
      email: 'member@example.invalid',
      teamId: 'team-1',
      role: 'admin',
      authGeneration: 7,
    })
    expect(res.body.token).toBe('session-token')
    expect(res.body).not.toHaveProperty('sessionContext')
  })

  it('does not issue a session when reset proof or pending state is invalid', async () => {
    directory.setInvitationPasswordForEmail.mockReset()
    sessionToken.signExternalSessionToken.mockReset().mockReturnValue('session-token')
    flow.validateInvitationFlowToken.mockRejectedValue(new Error('invalid'))
    const invalidProof = await request(app())
      .post('/external/invitations/password-token')
      .send({
        token: 'Synthetic-invalid-reset-proof',
        email: 'member@example.invalid',
        invitationId: 'reset-1',
        password: 'Synthetic-new-password',
      })
      .expect(400)
    expect(invalidProof.body.error).toBe('invalid_invitation')

    flow.validateInvitationFlowToken.mockResolvedValue({
      email: 'member@example.invalid',
      invitationUuid: 'Synthetic-producer-token-1',
    })
    directory.getInvitationByToken.mockResolvedValue({
      id: 'database-row-1',
      token: 'Synthetic-producer-token-1',
      email: 'member@example.invalid',
      purpose: 'password_reset',
      status: 'accepted',
    })
    await request(app())
      .post('/external/invitations/password-token')
      .send({
        token: 'Synthetic-redeemed-reset-proof',
        email: 'member@example.invalid',
        invitationId: 'database-row-1',
        password: 'Synthetic-new-password',
      })
      .expect(409)

    expect(directory.setInvitationPasswordForEmail).not.toHaveBeenCalled()
    expect(sessionToken.signExternalSessionToken).not.toHaveBeenCalled()

    directory.getInvitationByToken.mockReset().mockResolvedValue({
      id: 'database-row-1',
      token: 'Synthetic-producer-token-1',
      email: 'member@example.invalid',
      purpose: 'password_reset',
      status: 'pending',
    })
    directory.setInvitationPasswordForEmail.mockResolvedValue({ error: 'not_pending' })
    await request(app())
      .post('/external/invitations/password-token')
      .send({
        token: 'Synthetic-raced-reset-proof',
        email: 'member@example.invalid',
        invitationId: 'database-row-1',
        password: 'Synthetic-new-password',
      })
      .expect(409)
    expect(sessionToken.signExternalSessionToken).not.toHaveBeenCalled()
  })

  it('rejects a database row ID that does not match the trusted flow token', async () => {
    flow.validateInvitationFlowToken.mockResolvedValue({
      email: 'member@example.invalid',
      invitationUuid: 'Synthetic-producer-token-1',
    })
    directory.getInvitationByToken.mockResolvedValue({
      id: 'database-row-1',
      token: 'Synthetic-producer-token-1',
      email: 'member@example.invalid',
      purpose: 'password_reset',
      status: 'pending',
    })

    const res = await request(app())
      .post('/external/invitations/password-token')
      .send({
        token: 'Synthetic-trusted-reset-proof',
        email: 'member@example.invalid',
        invitationId: 'another-row',
        password: 'Synthetic-new-password',
      })
      .expect(403)

    expect(res.body.error).toBe('forbidden')
    expect(directory.setInvitationPasswordForEmail).not.toHaveBeenCalled()
    expect(sessionToken.signExternalSessionToken).not.toHaveBeenCalled()
  })

  it('POST desktop-authorization returns 503, NOT 404, when the hub-rejection message shape collides with the "(404)" not_found string match', async () => {
    // enroll() builds messages like `...rejected enrollment for '<domain>'
    // (${response.status})`. A hub 404 during boot/on-demand enrollment
    // therefore produces a MemberRegistrationUnavailableError whose message
    // contains the literal substring "(404)" — the same substring this
    // route's catch used to key off of to detect an invitation 404. Without
    // the memberRegistrationErrorResponse guard, this typed 503 gets
    // misclassified as a 404 invitation lookup failure.
    directory.verifyUserPassword.mockResolvedValue(true)
    flow.storeDesktopAuthorizationToken.mockRejectedValue(
      new MemberRegistrationUnavailableError(
        "member-registration hub rejected enrollment for 'x.acme.com' (404)"
      )
    )
    const res = await request(app())
      .post('/external/invitations/desktop-authorization')
      .send({ userId: 'u1', email: 'a@b.c', password: 'pw' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('member_registration_unavailable')
  })

  it('REGRESSION: POST desktop-authorization still maps a generic upstream 404 message to 404 not_found', async () => {
    directory.verifyUserPassword.mockResolvedValue(true)
    flow.storeDesktopAuthorizationToken.mockRejectedValue(new Error('upstream responded (404)'))
    const res = await request(app())
      .post('/external/invitations/desktop-authorization')
      .send({ userId: 'u1', email: 'a@b.c', password: 'pw' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
  })
})
