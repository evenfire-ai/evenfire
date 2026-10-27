import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { ControlApiError } from '../src/controlApiClient.js'
import { createAuthRouter } from '../src/routes/auth.js'

const authServiceMock = vi.hoisted(() => ({
  loginWithGoogle: vi.fn(),
  loginWithPassword: vi.fn(),
  requestPasswordReset: vi.fn(),
}))
const googleMock = vi.hoisted(() => ({ verifyIdToken: vi.fn() }))

vi.mock('../src/services/authService.js', () => authServiceMock)
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken(...args: unknown[]) {
      return googleMock.verifyIdToken(...args)
    }
  },
}))

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/api/v1', createAuthRouter())
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  )
  return app
}

describe('routes/auth password-login', () => {
  let previousCutover = config.authProtocolCutoverEnabled

  beforeEach(() => {
    previousCutover = config.authProtocolCutoverEnabled
    authServiceMock.loginWithGoogle.mockReset()
    config.authProtocolCutoverEnabled = true
    authServiceMock.loginWithPassword.mockReset()
    authServiceMock.requestPasswordReset.mockReset()
    googleMock.verifyIdToken.mockReset()
  })

  afterEach(() => {
    config.authProtocolCutoverEnabled = previousCutover
  })

  it.each(['/api/v1/auth/password-login', '/api/v1/auth/google'])(
    'rejects the historical login route %s without issuing a session',
    async path => {
      const res = await request(buildApp()).post(path).send({
        email: 'user@example.invalid',
        password: 'correct-password',
        idToken: 'synthetic-id-token',
      })

      expect(res.status).toBe(426)
      expect(res.body).toEqual({ error: 'supported_client_upgrade_required' })
      expect(authServiceMock.loginWithPassword).not.toHaveBeenCalled()
      expect(authServiceMock.loginWithGoogle).not.toHaveBeenCalled()
    }
  )

  it('propagates invalid credentials as a 401 instead of a 500', async () => {
    authServiceMock.loginWithPassword.mockRejectedValueOnce(
      new ControlApiError('control-api error (401)', 401, { error: 'Unauthorized' })
    )

    const res = await request(buildApp())
      .post('/api/v1/auth/v2/password-login')
      .send({ email: 'user@example.invalid', password: 'wrong-password' })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'invalid_credentials' })
  })

  it('sanitizes password-operation programming errors without marking them retryable', async () => {
    authServiceMock.loginWithPassword.mockRejectedValueOnce(
      new TypeError('private URL and credential detail')
    )

    const res = await request(buildApp())
      .post('/api/v1/auth/v2/password-login')
      .send({ email: 'user@example.invalid', password: 'synthetic-password' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Internal Server Error' })
    expect(res.headers['retry-after']).toBeUndefined()
    expect(res.text).not.toContain('private URL')
    expect(res.text).not.toContain('credential detail')
  })

  it('sets an HttpOnly profile session cookie and omits bearer token body for browser login', async () => {
    authServiceMock.loginWithPassword.mockResolvedValueOnce({
      token: 'profile-session-jwt',
      me: {
        id: 'user-1',
        email: 'user@example.invalid',
        name: null,
        picture: null,
        teamId: null,
        teamName: null,
        role: 'member',
      },
    })

    const res = await request(buildApp())
      .post('/api/v1/auth/v2/password-login')
      .set('origin', 'http://localhost:3001')
      .set('x-forwarded-proto', 'https')
      .send({ email: 'user@example.invalid', password: 'correct-password' })
      .expect(200)

    expect(res.body.token).toBeUndefined()
    expect(res.body.me.email).toBe('user@example.invalid')
    expect(String(res.headers['set-cookie'])).toContain('profile_session=profile-session-jwt')
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly')
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=43200')
    expect(String(res.headers['set-cookie'])).toContain('Secure')
    expect(String(res.headers['set-cookie'])).toContain('SameSite=Lax')
  })

  it('returns the bearer token body for non-browser Desktop App login', async () => {
    authServiceMock.loginWithPassword.mockResolvedValueOnce({
      token: 'desktop-session-jwt',
      me: {
        id: 'user-1',
        email: 'user@example.invalid',
        name: null,
        picture: null,
        teamId: null,
        teamName: null,
        role: 'member',
      },
    })

    const res = await request(buildApp())
      .post('/api/v1/auth/v2/password-login')
      .send({ email: 'user@example.invalid', password: 'correct-password' })
      .expect(200)

    expect(res.body.token).toBe('desktop-session-jwt')
    expect(res.body.me.email).toBe('user@example.invalid')
    expect(String(res.headers['set-cookie'])).toContain('profile_session=desktop-session-jwt')
    expect(authServiceMock.loginWithPassword).toHaveBeenCalledWith(
      'user@example.invalid',
      'correct-password',
      2
    )
  })

  it('routes protocol-v2 Google login through the v2 public producer', async () => {
    googleMock.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'user@example.invalid' }),
    })
    authServiceMock.loginWithGoogle.mockResolvedValueOnce({
      token: 'google-v2-session-jwt',
      me: { email: 'user@example.invalid' },
    })

    const res = await request(buildApp())
      .post('/api/v1/auth/v2/google')
      .send({ idToken: 'google-id-token' })
      .expect(200)

    expect(googleMock.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'google-id-token',
      audience: config.googleClientId,
    })
    expect(authServiceMock.loginWithGoogle).toHaveBeenCalledWith({ idToken: 'google-id-token' }, 2)
    expect(res.body.token).toBe('google-v2-session-jwt')
  })

  it('documents the password-reset limiter headers and client-IP contract', async () => {
    authServiceMock.requestPasswordReset.mockResolvedValue({ requested: true })
    const app = buildApp()
    const email = 'rate-limit-contract@example.invalid'

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await request(app)
        .post('/api/v1/auth/password-reset/request')
        .set('x-forwarded-for', '198.51.100.44')
        .send({ email })
        .expect(200)
      expect(res.headers['x-ratelimit-limit']).toBe('5')
      expect(res.headers['x-ratelimit-remaining']).toBe(String(4 - attempt))
    }

    const limited = await request(app)
      .post('/api/v1/auth/password-reset/request')
      .set('x-forwarded-for', '198.51.100.44')
      .send({ email })
      .expect(429)
    expect(limited.headers['retry-after']).toMatch(/^\d+$/)
    expect(limited.headers['x-ratelimit-limit']).toBe('5')
    expect(limited.headers['x-ratelimit-remaining']).toBe('0')
    expect(limited.body).toMatchObject({ retryAfterSeconds: expect.any(Number) })
  })
})
