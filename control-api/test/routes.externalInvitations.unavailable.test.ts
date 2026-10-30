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

const rateLimiter = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
vi.mock('../src/services/rateLimiterService.js', () => rateLimiter)

vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  rejectBodyUserTeamMismatch: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
  requireValidExternalSessionToken: (
    req: express.Request & { externalAuth?: Record<string, unknown> },
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.externalAuth = {
      userId: 'caller-user',
      email: 'caller@example.com',
      teamId: null,
      role: 'member',
      exp: 4_102_444_800,
    }
    next()
  },
}))
const tokenSigner = vi.hoisted(() => ({ sign: vi.fn(() => 'synthetic-session-token') }))
vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  signExternalSessionToken: tokenSigner.sign,
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
    database.query.mockReset()
    database.withTransaction.mockImplementation(async work => work({ query: database.query }))
    rateLimiter.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })
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

  it('issues a session only for the first acceptance and returns a replay without one', async () => {
    flow.validateInvitationFlowToken.mockResolvedValue({
      email: 'a@b.c',
      invitationUuid: 'database-capability',
    })
    const replayData = {
      accepted: true as const,
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'a@b.c',
      teamId: null,
      role: 'member',
      authGeneration: 1,
      replay: true as const,
    }
    directory.acceptInvitationForEmailInTransaction
      .mockResolvedValueOnce({
        data: {
          accepted: true,
          userId: '00000000-0000-4000-8000-000000000001',
          email: 'a@b.c',
          teamId: null,
          role: 'member',
          authGeneration: 1,
        },
      })
      .mockResolvedValueOnce({ data: replayData })
    database.query.mockImplementation(async sql => {
      const text = String(sql)
      if (text.includes('SELECT id FROM users') && text.includes('FOR UPDATE')) {
        return { rows: [{ id: '00000000-0000-4000-8000-000000000001' }], rowCount: 1 }
      }
      if (text.includes('SELECT lifecycle_state, lifecycle_version')) {
        return { rows: [{ lifecycle_state: 'active', lifecycle_version: 1 }], rowCount: 1 }
      }
      if (text.includes('clock_timestamp()')) {
        return { rows: [{ db_now: new Date('2026-10-07T12:00:00.000Z') }], rowCount: 1 }
      }
      if (text.includes('SELECT valid_after')) return { rows: [], rowCount: 0 }
      throw new Error(`unexpected invitation session issuance query: ${text}`)
    })

    const first = await request(app())
      .post('/external/invitations/accept')
      .send({ email: 'a@b.c', token: 'synthetic-one-use-flow' })
    const replay = await request(app())
      .post('/external/invitations/accept')
      .send({ email: 'a@b.c', token: 'synthetic-one-use-flow' })

    expect(first.status).toBe(200)
    expect(first.body.token).toBe('synthetic-session-token')
    expect(first.body).not.toHaveProperty('replay')
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(replayData)
    expect(replay.body).not.toHaveProperty('token')
    expect(replay.body).not.toHaveProperty('sessionContract')
    expect(tokenSigner.sign).toHaveBeenCalledTimes(1)
    // Only the first acceptance reaches the user lock and the issuance reads.
    expect(database.query).toHaveBeenCalledTimes(4)
    expect(String(database.query.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    expect(String(database.query.mock.calls[1]?.[0])).toContain('lifecycle_version')
    expect(String(database.query.mock.calls[2]?.[0])).toContain('clock_timestamp()')
    expect(String(database.query.mock.calls[3]?.[0])).toContain('SELECT valid_after')
    expect(flow.validateInvitationFlowToken).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['not_pending', 400, 'not_pending'],
    ['user_retired', 401, 'Unauthorized'],
  ])(
    'maps %s acceptance without starting a session',
    async (error, expectedStatus, responseError) => {
      flow.validateInvitationFlowToken.mockResolvedValue({
        email: 'a@b.c',
        invitationUuid: 'database-capability',
      })
      directory.acceptInvitationForEmailInTransaction.mockReset()
      directory.acceptInvitationForEmailInTransaction.mockResolvedValue({ error })

      const res = await request(app())
        .post('/external/invitations/accept')
        .send({ email: 'a@b.c', token: 'synthetic-not-pending-flow' })

      expect(res.status).toBe(expectedStatus)
      expect(res.body).toEqual({ error: responseError })
      expect(tokenSigner.sign).not.toHaveBeenCalled()
      expect(database.query).not.toHaveBeenCalled()
      expect(directory.acceptInvitationForEmailInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        'a@b.c',
        'database-capability'
      )
    }
  )

  it('binds the secret capability to the public id and never issues on password setup', async () => {
    flow.validateInvitationFlowToken.mockResolvedValue({
      email: 'a@b.c',
      invitationUuid: 'database-secret-capability',
    })
    directory.getInvitationByToken.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000200',
      email: 'a@b.c',
      purpose: 'password_reset',
      status: 'pending',
    })
    directory.setInvitationPasswordForEmail.mockResolvedValue({
      data: {
        id: '00000000-0000-4000-8000-000000000200',
        userId: '00000000-0000-4000-8000-000000000001',
        passwordUpdated: true,
        authGeneration: 1,
        lifecycleState: 'active',
        token: 'synthetic-producer-session-token',
        sessionContext: {
          userId: '00000000-0000-4000-8000-000000000001',
          email: 'a@b.c',
          teamId: null,
          role: 'member',
          authGeneration: 1,
        },
      },
    })

    const response = await request(app()).post('/external/invitations/password-token').send({
      email: 'a@b.c',
      token: 'synthetic-member-registration-flow-token',
      invitationId: '00000000-0000-4000-8000-000000000200',
      password: 'synthetic-valid-password',
    })

    expect(response.status).toBe(200)
    expect(response.body.reauthenticationRequired).toBe(true)
    expect(response.body).not.toHaveProperty('token')
    expect(response.body).not.toHaveProperty('sessionContext')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(directory.getInvitationByToken).toHaveBeenCalledWith('database-secret-capability')
    expect(directory.setInvitationPasswordForEmail).toHaveBeenCalledWith(
      'a@b.c',
      '00000000-0000-4000-8000-000000000200',
      'synthetic-valid-password'
    )
    expect(tokenSigner.sign).not.toHaveBeenCalled()
  })

  it('rejects a recovery row id that does not match the trusted token capability', async () => {
    flow.validateInvitationFlowToken.mockResolvedValue({
      email: 'a@b.c',
      invitationUuid: 'database-secret-capability',
    })
    directory.getInvitationByToken.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000201',
      email: 'a@b.c',
      purpose: 'password_reset',
      status: 'pending',
    })

    const response = await request(app()).post('/external/invitations/password-token').send({
      email: 'a@b.c',
      token: 'synthetic-member-registration-flow-token',
      invitationId: '00000000-0000-4000-8000-000000000200',
      password: 'synthetic-valid-password',
    })

    expect(response.status).toBe(403)
    expect(directory.setInvitationPasswordForEmail).not.toHaveBeenCalled()
    expect(tokenSigner.sign).not.toHaveBeenCalled()
  })

  it('lists invitations only for the authenticated email', async () => {
    directory.listPendingInvitations.mockResolvedValue([])

    const res = await request(app()).get('/external/invitations/pending?email=victim@example.com')

    expect(res.status).toBe(200)
    expect(directory.listPendingInvitations).toHaveBeenCalledWith('caller@example.com')
    expect(directory.listPendingInvitations).not.toHaveBeenCalledWith('victim@example.com')
  })

  it('reads owned pending invitations without an added user quota', async () => {
    directory.listPendingInvitations.mockResolvedValue([])
    await request(app()).get('/external/invitations/pending').expect(200)
    expect(directory.listPendingInvitations).toHaveBeenCalledWith('caller@example.com')
    expect(rateLimiter.checkAndIncrement).not.toHaveBeenCalled()
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
