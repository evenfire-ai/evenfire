import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import request from 'supertest'
import { requireInternalToken } from '../../control-api/src/middleware/internalServiceAuth.js'
import { createExternalInvitationsRouter } from '../../control-api/src/routes/external/invitations.js'
import { PasswordAdmissionError } from '../../control-api/src/services/auth/passwordCredentialVerification.js'
import { config as externalConfig } from '../src/config.js'
import { createInvitationsRouter } from '../src/routes/invitations.js'

const internalServiceToken = 'Synthetic-R6-Producer-Contract-Token'
const producerConfig = vi.hoisted(() => ({
  internalServiceTokens: { 'external-rest-api': 'Synthetic-R6-Producer-Contract-Token' },
  approvalRlExternalClientIpPerMin: 100,
  approvalRlExternalEdgePerMin: 100,
}))
const flow = vi.hoisted(() => ({ validateInvitationFlowToken: vi.fn() }))
const directory = vi.hoisted(() => ({
  acceptInvitationForEmail: vi.fn(),
  getInvitationByToken: vi.fn(),
  listPendingInvitations: vi.fn(),
  setInvitationPasswordForEmail: vi.fn(),
  setInvitationPasswordForUser: vi.fn(),
  verifyUserPassword: vi.fn(),
}))
const desktopFlow = vi.hoisted(() => ({ storeDesktopAuthorizationToken: vi.fn() }))

vi.mock('../../control-api/src/config.js', () => ({ config: producerConfig }))
vi.mock('../../control-api/src/utils/auth/externalSessionAuthToken.js', () => ({
  signExternalSessionToken: () => 'synthetic-producer-session',
}))
vi.mock('../../control-api/src/services/directory/index.js', () => directory)
vi.mock('../../control-api/src/services/invitationFlowRegistrationService.js', () => ({
  ...flow,
  ...desktopFlow,
}))
vi.mock('../../control-api/src/middleware/rateLimitMiddleware.js', async importOriginal => {
  const real =
    await importOriginal<typeof import('../../control-api/src/middleware/rateLimitMiddleware.js')>()
  return {
    ...real,
    rateLimitMiddleware:
      () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
        next(),
  }
})
vi.mock('../../control-api/src/middleware/externalSessionAuth.js', () => ({
  rejectBodyUserTeamMismatch: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
  requireValidExternalSessionToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    ;(req as express.Request & { externalAuth?: unknown }).externalAuth = {
      userId: 'r6-user',
      email: 'r6-member@example.invalid',
      teamId: null,
      role: 'member',
      authGeneration: 1,
    }
    next()
  },
}))
vi.mock('../src/authToken.js', () => ({
  verifyToken: () => ({
    userId: 'r6-user',
    email: 'r6-member@example.invalid',
    teamId: '',
    role: 'member',
    exp: 4_102_444_800,
  }),
}))

const preview = {
  id: 'r6-reset-row',
  email: 'r6-member@example.invalid',
  purpose: 'password_reset',
  status: 'pending',
  userId: 'r6-user',
  teamId: null,
  teamName: null,
}

let producerServer: Server
let previousControlApiBaseUrl: string
let previousControlApiServiceToken: string
let previousControlApiServiceName: string

function publicApp() {
  const app = express()
  app.use(express.json())
  app.use(createInvitationsRouter())
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: unknown) => {
    res.status(500).json({ error: 'Internal Server Error' })
  })
  return app
}

function producerResponseApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', requireInternalToken, createExternalInvitationsRouter())
  return app
}

describe('R6 invitation/password producer response mappings', () => {
  beforeAll(async () => {
    previousControlApiBaseUrl = externalConfig.controlApiBaseUrl
    previousControlApiServiceToken = externalConfig.controlApiServiceToken
    previousControlApiServiceName = externalConfig.controlApiServiceName
    producerServer = producerResponseApp().listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      producerServer.once('error', reject)
      producerServer.once('listening', resolve)
    })
    const address = producerServer.address()
    if (!address || typeof address === 'string') throw new Error('producer did not bind TCP')
    externalConfig.controlApiBaseUrl = `http://127.0.0.1:${address.port}/api/v1`
    externalConfig.controlApiServiceToken = internalServiceToken
    externalConfig.controlApiServiceName = 'external-rest-api'
  })

  afterAll(async () => {
    externalConfig.controlApiBaseUrl = previousControlApiBaseUrl
    externalConfig.controlApiServiceToken = previousControlApiServiceToken
    externalConfig.controlApiServiceName = previousControlApiServiceName
    if (producerServer) {
      producerServer.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        producerServer.close(error => (error ? reject(error) : resolve()))
      )
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    flow.validateInvitationFlowToken.mockImplementation(
      async (token: string, claimedEmail?: string) => {
        if (token !== 'r6-reset-proof') throw new Error('invalid proof')
        if (claimedEmail && claimedEmail.toLowerCase() !== preview.email) {
          throw new Error('wrong email')
        }
        return { email: preview.email, invitationUuid: 'r6-producer-invitation-token' }
      }
    )
    directory.getInvitationByToken.mockResolvedValue(preview)
  })

  it.each([
    [
      'invalid password',
      { error: 'invalid_password' },
      400,
      { error: 'Password must be between 8 and 256 characters' },
    ],
    ['invalid proof', { error: 'invalid_invitation' }, 400, { error: 'invalid_invitation' }],
    ['retired member', { error: 'user_retired' }, 400, { error: 'invalid_invitation' }],
    [
      'wrong invitation binding',
      { error: 'forbidden' },
      403,
      { error: 'Invitation is invalid or unavailable' },
    ],
    ['missing invitation', { error: 'not_found' }, 404, { error: 'Invitation not found' }],
    [
      'redeemed invitation',
      { error: 'not_pending' },
      409,
      { error: 'Invitation has already been used' },
    ],
    ['expired invitation', { error: 'expired' }, 410, { error: 'Invitation has expired' }],
  ])(
    'maps the producer %s domain response to the public contract',
    async (label, result, status, body) => {
      if (label === 'invalid proof') {
        flow.validateInvitationFlowToken.mockRejectedValue(new Error('invalid proof'))
      } else {
        directory.setInvitationPasswordForEmail.mockResolvedValue(result)
      }

      const response = await request(publicApp()).post('/invitations/password').send({
        token: 'r6-reset-proof',
        email: preview.email,
        invitationId: preview.id,
        password: 'R6-synthetic-valid-password',
      })

      expect(response.status).toBe(status)
      expect(response.body).toEqual(body)
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(JSON.stringify(response.body)).not.toMatch(
        /r6-reset-proof|producer-invitation|sql|stack/i
      )
      if (label !== 'invalid proof') {
        expect(directory.setInvitationPasswordForEmail).toHaveBeenCalledOnce()
      } else {
        expect(directory.setInvitationPasswordForEmail).not.toHaveBeenCalled()
      }
    }
  )

  it('preserves bounded admission responses from the real Control API route', async () => {
    directory.setInvitationPasswordForEmail.mockRejectedValueOnce(
      new PasswordAdmissionError(429, 17, 'verification_busy')
    )

    const response = await request(publicApp()).post('/invitations/password').send({
      token: 'r6-reset-proof',
      email: preview.email,
      invitationId: preview.id,
      password: 'R6-synthetic-valid-password',
    })

    expect(response.status).toBe(429)
    expect(response.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 17 })
    expect(response.headers['retry-after']).toBe('17')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(/verification_busy|r6-|sql|stack/i)
  })

  it('maps a real producer password mismatch for desktop authorization', async () => {
    directory.verifyUserPassword.mockResolvedValueOnce(false)

    const response = await request(publicApp())
      .post('/invitations/desktop-authorization')
      .set('authorization', 'Bearer r6-synthetic-session')
      .send({ password: 'R6-synthetic-current-password' })

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Invalid password' })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(/invalid_password|r6-|sql|stack/i)
    expect(directory.verifyUserPassword).toHaveBeenCalledWith({
      userId: 'r6-user',
      email: 'r6-member@example.invalid',
      password: 'R6-synthetic-current-password',
    })
    expect(desktopFlow.storeDesktopAuthorizationToken).not.toHaveBeenCalled()
  })

  it('maps an unavailable desktop-authorization producer to bounded public retry guidance', async () => {
    directory.verifyUserPassword.mockRejectedValueOnce(
      new PasswordAdmissionError(503, 23, 'authority_failure')
    )

    const response = await request(publicApp())
      .post('/invitations/desktop-authorization')
      .set('authorization', 'Bearer r6-synthetic-session')
      .send({ password: 'R6-synthetic-current-password' })

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'authority_unavailable', retryAfterSeconds: 23 })
    expect(response.headers['retry-after']).toBe('23')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(/authority_failure|r6-|sql|stack/i)
    expect(desktopFlow.storeDesktopAuthorizationToken).not.toHaveBeenCalled()
  })

  it('maps the producer desktop-registration not-found code without leaking details', async () => {
    directory.verifyUserPassword.mockResolvedValueOnce(true)
    desktopFlow.storeDesktopAuthorizationToken.mockRejectedValueOnce(
      new Error(
        'Member registration service POST /invitations-flow/desktop-authorizations failed (404): private'
      )
    )

    const response = await request(publicApp())
      .post('/invitations/desktop-authorization')
      .set('authorization', 'Bearer r6-synthetic-session')
      .send({ password: 'R6-synthetic-current-password' })

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'Invitation setup not found' })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(
      /desktop-authorization|private|r6-|sql|stack/i
    )
    expect(desktopFlow.storeDesktopAuthorizationToken).toHaveBeenCalledOnce()
  })
})
