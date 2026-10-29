import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'

const googleVerify = vi.hoisted(() => ({ verifyIdToken: vi.fn() }))

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = googleVerify.verifyIdToken
  },
}))

const directory = vi.hoisted(() => ({
  getTeamAgents: vi.fn(),
  getUserAgents: vi.fn(),
  googleLoginData: vi.fn(),
  requestProfilePasswordReset: vi.fn(),
}))
const database = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../src/services/directory/index.js', () => directory)
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => database.query(...args) },
  withTransaction: vi.fn(),
}))
vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => ({
  resolveEffectiveUserAccessPolicy: vi.fn(async () => ({
    issueV1: true,
    issueV2: true,
    acceptV1: true,
    acceptV2: true,
  })),
}))

/**
 * Stands in for the production request-scoped Pino child that the
 * correlation-id middleware installs as `req.log`.
 */
const requestLog = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((req: Request, _res: Response, next: NextFunction) => {
    ;(req as Request & { log?: typeof requestLog }).log = requestLog
    next()
  })
  app.use(createExternalAuthRouter({} as never))
  app.use(clerumErrorHandler)
  return app
}

function googleLogin(idToken: string) {
  return request(buildApp()).post('/external/auth/google-login').send({ idToken })
}

describe('POST /external/auth/google-login credential rejections', () => {
  beforeEach(() => {
    googleVerify.verifyIdToken.mockReset()
    Object.values(directory).forEach(fn => fn.mockReset())
    Object.values(requestLog).forEach(fn => fn.mockReset())
  })

  it('answers 401 Unauthorized when Google has not verified the email', async () => {
    googleVerify.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'user@example.invalid', email_verified: false }),
    })

    const response = await googleLogin('unverified-token')

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(directory.googleLoginData).not.toHaveBeenCalled()
  })

  it('answers 401 Unauthorized when the verified payload has no email', async () => {
    googleVerify.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email_verified: true }),
    })

    const response = await googleLogin('emailless-token')

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(directory.googleLoginData).not.toHaveBeenCalled()
  })

  it('keeps library verification errors on the sanitized 500 path without logging or returning the token', async () => {
    const submittedToken = 'synthetic-id-token'
    const payloadEmail = 'synthetic-payload@example.invalid'
    googleVerify.verifyIdToken.mockRejectedValue(
      new Error(`Wrong number of segments in token: ${submittedToken} ${payloadEmail}`)
    )

    const response = await googleLogin(submittedToken)

    expect(response.status).toBe(500)
    expect(response.body.error).toBe('Internal Server Error')
    expect(typeof response.body.correlationId).toBe('string')
    expect(directory.googleLoginData).not.toHaveBeenCalled()
    // Liveness witness: the verifier was called with the submitted token.
    expect(googleVerify.verifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ idToken: submittedToken })
    )

    expect(requestLog.error).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(requestLog.error.mock.calls[0] ?? [])
    expect(logged).not.toContain(submittedToken)
    expect(logged).not.toContain(payloadEmail)
    expect(logged).toContain('unhandled_error')

    const body = JSON.stringify(response.body)
    expect(body).not.toContain(submittedToken)
    expect(body).not.toContain(payloadEmail)
  })

  it('does not answer 401 for a verified Google identity', async () => {
    googleVerify.verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email: 'User@Example.invalid',
        email_verified: true,
        name: 'User',
      }),
    })
    directory.googleLoginData.mockResolvedValue({ error: 'user_retired' })

    const response = await googleLogin('verified-token')

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'membership_not_found' })
    expect(directory.googleLoginData).toHaveBeenCalledWith({
      email: 'user@example.invalid',
      name: 'User',
      picture: undefined,
    })
  })
})
