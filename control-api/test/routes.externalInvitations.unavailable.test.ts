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
  acceptInvitationForEmailInTransaction: vi.fn(),
  getInvitationByToken: vi.fn(),
  listPendingInvitations: vi.fn(),
  setInvitationPasswordForEmail: vi.fn(),
  setInvitationPasswordForUser: vi.fn(),
  verifyUserPassword: vi.fn(),
}))
vi.mock('../src/services/directory/index.js', () => directory)

const database = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}))
vi.mock('../src/db.js', () => ({ withTransaction: database.withTransaction }))

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
vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  signExternalSessionToken: vi.fn(() => 'session-token'),
}))
const userSessions = vi.hoisted(() => ({
  create: vi.fn(async () => ({ token: 'session-token' })),
}))
vi.mock('../src/services/auth/userSessionService.js', () => ({
  createUserSession: userSessions.create,
  validateUserSessionClaims: vi.fn(),
}))

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
    database.withTransaction.mockImplementation(async work => work({ query: database.query }))
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

  it('never issues a session when an invitation is already consumed or is a password reset', async () => {
    flow.validateInvitationFlowToken.mockResolvedValue({
      email: 'a@b.c',
      invitationUuid: '00000000-0000-4000-8000-000000000200',
    })
    directory.acceptInvitationForEmailInTransaction.mockResolvedValue({
      error: 'not_pending',
    })

    for (const token of ['already-accepted-flow', 'password-reset-flow']) {
      const res = await request(app())
        .post('/external/invitations/accept')
        .send({ email: 'a@b.c', token, sessionContract: 'v2' })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'not_pending' })
    }
    expect(userSessions.create).not.toHaveBeenCalled()
    expect(database.query).not.toHaveBeenCalled()
  })

  it('issues one session only for the transaction that consumes a pending invitation', async () => {
    flow.validateInvitationFlowToken.mockResolvedValue({
      email: 'a@b.c',
      invitationUuid: '00000000-0000-4000-8000-000000000200',
    })
    directory.acceptInvitationForEmailInTransaction
      .mockResolvedValueOnce({
        data: {
          accepted: true,
          userId: '00000000-0000-4000-8000-000000000001',
          email: 'a@b.c',
          teamId: null,
          role: 'member',
        },
      })
      .mockResolvedValueOnce({ error: 'not_pending' })
    database.query.mockResolvedValue({
      rows: [{ id: '00000000-0000-4000-8000-000000000001' }],
      rowCount: 1,
    })

    const first = await request(app())
      .post('/external/invitations/accept')
      .send({ email: 'a@b.c', token: 'single-use-flow', sessionContract: 'v2' })
    const replay = await request(app())
      .post('/external/invitations/accept')
      .send({ email: 'a@b.c', token: 'single-use-flow', sessionContract: 'v2' })

    expect(first.status).toBe(200)
    expect(first.body.token).toBe('session-token')
    expect(replay.status).toBe(400)
    expect(replay.body).toEqual({ error: 'not_pending' })
    expect(userSessions.create).toHaveBeenCalledTimes(1)
  })

  it('does not let a consumed invitation token reach password mutation or session issuance', async () => {
    flow.validateInvitationFlowToken.mockResolvedValue({
      email: 'a@b.c',
      invitationUuid: '00000000-0000-4000-8000-000000000200',
    })
    directory.setInvitationPasswordForEmail.mockResolvedValue({ error: 'not_pending' })

    const response = await request(app()).post('/external/invitations/password-token').send({
      email: 'a@b.c',
      token: 'consumed-flow',
      invitationId: '00000000-0000-4000-8000-000000000200',
      password: 'attacker-password',
    })

    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'invitation_not_pending' })
    expect(userSessions.create).not.toHaveBeenCalled()
  })

  it('REGRESSION: a generic validation error still maps to 400 invalid_invitation', async () => {
    flow.validateInvitationFlowToken.mockRejectedValue(new Error('invalid_invitation'))
    const res = await request(app()).get('/external/invitations/token/some-token')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_invitation')
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
