import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { externalRestPublicErrorHandler } from '../src/app.js'
import { ControlApiError } from '../src/controlApiClient.js'
import { createMeRouter } from '../src/routes/me.js'

const mocks = vi.hoisted(() => ({
  controlApiRequest: vi.fn(),
  verifyToken: vi.fn(),
}))

vi.mock('../src/controlApiClient.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/controlApiClient.js')>()
  return { ...actual, controlApiRequest: mocks.controlApiRequest }
})
vi.mock('../src/authToken.js', () => ({ verifyToken: mocks.verifyToken }))

describe('External REST /me unavailable producer contract', () => {
  beforeEach(() => {
    mocks.controlApiRequest.mockReset()
    mocks.verifyToken.mockReset().mockReturnValue({
      userId: 'synthetic-member-id',
      email: 'member@example.invalid',
      teamId: '',
      role: 'member',
      exp: Math.floor(Date.now() / 1000) + 60,
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it('forwards a Control API outage body verbatim through the public error handler', async () => {
    mocks.controlApiRequest.mockRejectedValue(
      new ControlApiError(
        'private Control API failure',
        503,
        { error: 'authority_failure' },
        {
          'retry-after': '60',
        }
      )
    )
    const app = express()
    app.use(createMeRouter())
    app.use(externalRestPublicErrorHandler)

    const response = await request(app)
      .get('/me')
      .set('authorization', 'Bearer synthetic-session-token')

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'authority_failure' })
    expect(response.headers['retry-after']).toBe('60')
    expect(JSON.stringify(response.body)).not.toMatch(
      /private Control API failure|synthetic-member-id|synthetic-session-token/
    )
    expect(mocks.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      '/external/users/synthetic-member-id/me',
      expect.objectContaining({ userSessionToken: 'synthetic-session-token' })
    )
  })

  it('forwards a revoked upstream session envelope as 401 so the client re-authenticates', async () => {
    const envelope = {
      error: {
        code: 'invalid_session',
        message: 'The session is not valid.',
        correlationId: 'upstream-correlation',
        retryable: false,
      },
    }
    mocks.controlApiRequest.mockRejectedValue(
      new ControlApiError('private upstream detail', 401, envelope)
    )
    const app = express()
    app.use(createMeRouter())
    app.use(externalRestPublicErrorHandler)

    const response = await request(app)
      .get('/me')
      .set('authorization', 'Bearer synthetic-session-token')

    expect(response.status).toBe(401)
    expect(response.body).toEqual(envelope)
    expect(JSON.stringify(response.body)).not.toMatch(/private upstream detail/)
    expect(mocks.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      '/external/users/synthetic-member-id/me',
      expect.objectContaining({ userSessionToken: 'synthetic-session-token' })
    )
  })

  it('answers a bare upstream 401 as dev did (404)', async () => {
    mocks.controlApiRequest.mockRejectedValue(
      new ControlApiError('private upstream detail', 401, { error: 'Unauthorized' })
    )
    const app = express()
    app.use(createMeRouter())
    app.use(externalRestPublicErrorHandler)

    const response = await request(app)
      .get('/me')
      .set('authorization', 'Bearer synthetic-session-token')

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'User not found' })
    expect(JSON.stringify(response.body)).not.toMatch(/private upstream detail/)
    expect(mocks.controlApiRequest).toHaveBeenCalledTimes(1)
    expect(mocks.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      '/external/users/synthetic-member-id/me',
      expect.objectContaining({ userSessionToken: 'synthetic-session-token' })
    )
  })

  it('answers a rejected edge token on /me with the invalid_session envelope', async () => {
    mocks.verifyToken.mockReturnValue(null)
    const app = express()
    app.use(createMeRouter())
    app.use(externalRestPublicErrorHandler)

    const missing = await request(app).get('/me')
    const rejected = await request(app)
      .get('/me')
      .set('authorization', 'Bearer synthetic-expired-token')

    for (const response of [missing, rejected]) {
      expect(response.status).toBe(401)
      expect(response.body).toEqual({
        error: {
          code: 'invalid_session',
          message: 'The session is not valid.',
          correlationId: expect.any(String),
          retryable: false,
        },
      })
    }
    // The edge verified the presented token itself and never reached control-api.
    expect(mocks.verifyToken).toHaveBeenCalledWith('synthetic-expired-token')
    expect(mocks.controlApiRequest).not.toHaveBeenCalled()
  })

  it('keeps the bare 401 on the other /me routes', async () => {
    const app = express()
    app.use(createMeRouter())
    app.use(externalRestPublicErrorHandler)

    const response = await request(app).get('/me/contexts')

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(mocks.controlApiRequest).not.toHaveBeenCalled()
  })

  it('preserves an authenticated /me response with no active team', async () => {
    mocks.controlApiRequest.mockResolvedValue({
      id: 'synthetic-member-id',
      email: 'member@example.invalid',
      name: 'Member',
      picture: null,
      teamId: null,
      teamName: null,
      role: null,
      profile: { displayName: 'Member', channels: {} },
    })
    const app = express()
    app.use(createMeRouter())

    const response = await request(app)
      .get('/me')
      .set('authorization', 'Bearer synthetic-session-token')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      id: 'synthetic-member-id',
      teamId: null,
      teamName: null,
      role: null,
    })
    expect(mocks.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      '/external/users/synthetic-member-id/me',
      expect.objectContaining({ query: { teamId: '' } })
    )
  })
})
