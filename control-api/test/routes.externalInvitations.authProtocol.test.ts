import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import { verifyExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'

const invitationFlow = vi.hoisted(() => ({
  validateInvitationFlowToken: vi.fn(),
  storeDesktopAuthorizationToken: vi.fn(),
}))
vi.mock('../src/services/invitationFlowRegistrationService.js', () => invitationFlow)

const directory = vi.hoisted(() => ({
  acceptInvitationForEmail: vi.fn(),
  getInvitationByToken: vi.fn(),
  listPendingInvitations: vi.fn(),
  setInvitationPasswordForEmail: vi.fn(),
  setInvitationPasswordForUser: vi.fn(),
  verifyUserPassword: vi.fn(),
}))
vi.mock('../src/services/directory/index.js', () => directory)

vi.mock('../src/middleware/externalClientIdentity.js', () => ({
  createExternalClientRateLimiters: () => [
    (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  ],
}))
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

function buildApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(createExternalInvitationsRouter())
  return app
}

function acceptedInvitation() {
  return {
    data: {
      accepted: true,
      userId: 'user-1',
      email: 'user@example.com',
      teamId: 'team-1',
      role: 'member',
      authGeneration: 4,
      lifecycleState: 'active',
      sessionContext: {
        userId: 'user-1',
        email: 'user@example.com',
        teamId: 'team-1',
        role: 'member',
        authGeneration: 4,
      },
    },
  }
}

describe('unversioned invitation session producers', () => {
  let previousCutover = config.authProtocolCutoverEnabled

  beforeEach(() => {
    previousCutover = config.authProtocolCutoverEnabled
    config.authProtocolCutoverEnabled = false
    vi.clearAllMocks()
    invitationFlow.validateInvitationFlowToken.mockResolvedValue({
      email: 'user@example.com',
      invitationUuid: 'invitation-1',
    })
  })

  afterEach(() => {
    config.authProtocolCutoverEnabled = previousCutover
  })

  it('does not promote invitation acceptance to protocol v2 and cutover rejects its session', async () => {
    directory.acceptInvitationForEmail.mockResolvedValue(acceptedInvitation())

    const response = await request(buildApp())
      .post('/external/invitations/accept')
      .send({ email: 'user@example.com', token: 'valid-invitation-flow-token' })
      .expect(200)
    const claims = verifyExternalSessionToken(response.body.token)

    expect(claims).toMatchObject({
      userId: 'user-1',
      teamId: 'team-1',
      role: 'member',
      authGeneration: 4,
    })
    expect(claims).not.toHaveProperty('authProtocolVersion')
    expect(directory.acceptInvitationForEmail).toHaveBeenCalledOnce()

    config.authProtocolCutoverEnabled = true
    expect(verifyExternalSessionToken(response.body.token)).toBeNull()
  })

  it('does not promote password-token invitation sessions to protocol v2', async () => {
    directory.getInvitationByToken.mockResolvedValue({
      id: 'invitation-1',
      token: 'invitation-1',
      email: 'user@example.com',
      purpose: 'password_reset',
      status: 'pending',
    })
    directory.setInvitationPasswordForEmail.mockResolvedValue(acceptedInvitation())

    const response = await request(buildApp())
      .post('/external/invitations/password-token')
      .send({
        email: 'user@example.com',
        token: 'valid-invitation-flow-token',
        invitationId: 'invitation-1',
        password: 'Strong password 123!',
      })
      .expect(200)
    const claims = verifyExternalSessionToken(response.body.token)

    expect(claims).toMatchObject({ userId: 'user-1', authGeneration: 4 })
    expect(claims).not.toHaveProperty('authProtocolVersion')
    expect(directory.setInvitationPasswordForEmail).toHaveBeenCalledOnce()

    config.authProtocolCutoverEnabled = true
    expect(verifyExternalSessionToken(response.body.token)).toBeNull()
  })
})
