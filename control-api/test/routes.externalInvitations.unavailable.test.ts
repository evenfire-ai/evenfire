import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

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
  rateLimitMiddleware: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}))
vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  rejectBodyUserTeamMismatch: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  requireValidExternalSessionToken: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}))
vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  signExternalSessionToken: vi.fn(() => 'session-token'),
}))

import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import {
  MemberRegistrationUnavailableError,
  memberRegistrationErrorResponse,
} from '../src/services/memberRegistrationErrors.js'

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
})
