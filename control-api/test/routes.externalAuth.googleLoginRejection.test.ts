import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
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

function buildApp() {
  const app = express()
  app.use(express.json())
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

  it('keeps library verification errors on the sanitized 500 path', async () => {
    googleVerify.verifyIdToken.mockRejectedValue(new Error('Wrong number of segments in token'))

    const response = await googleLogin('malformed-token')

    expect(response.status).toBe(500)
    expect(response.body.error).toBe('Internal Server Error')
    expect(typeof response.body.correlationId).toBe('string')
    expect(directory.googleLoginData).not.toHaveBeenCalled()
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
