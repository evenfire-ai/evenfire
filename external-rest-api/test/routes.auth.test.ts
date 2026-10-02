import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { externalRestPublicErrorHandler } from '../src/app.js'
import { ControlApiError } from '../src/controlApiClient.js'
import { createAuthRouter } from '../src/routes/auth.js'

const authServiceMock = vi.hoisted(() => ({
  loginWithGoogle: vi.fn(),
  loginWithPassword: vi.fn(),
  requestPasswordReset: vi.fn(),
  logoutUserSession: vi.fn(),
}))

vi.mock('../src/services/authService.js', () => authServiceMock)

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/api/v1', createAuthRouter())
  app.use(externalRestPublicErrorHandler)
  return app
}

describe('routes/auth password-login', () => {
  beforeEach(() => {
    authServiceMock.loginWithPassword.mockReset()
    authServiceMock.requestPasswordReset.mockReset()
    authServiceMock.logoutUserSession.mockReset()
  })

  it('propagates invalid credentials as a 401 instead of a 500', async () => {
    authServiceMock.loginWithPassword.mockRejectedValueOnce(
      new ControlApiError('control-api error (401)', 401, { error: 'Unauthorized' })
    )

    const res = await request(buildApp())
      .post('/api/v1/auth/password-login')
      .send({ email: 'user@example.invalid', password: 'wrong-password' })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
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
      .post('/api/v1/auth/password-login')
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
      .post('/api/v1/auth/password-login')
      .send({ email: 'user@example.invalid', password: 'correct-password' })
      .expect(200)

    expect(res.body.token).toBe('desktop-session-jwt')
    expect(res.body.me.email).toBe('user@example.invalid')
    expect(String(res.headers['set-cookie'])).toContain('profile_session=desktop-session-jwt')
  })

  it('delegates Google verification behind the Control API limiter with trusted client IP', async () => {
    authServiceMock.loginWithGoogle.mockResolvedValueOnce({
      token: 'google-session-jwt',
      me: { id: 'user-1', email: 'user@example.test' },
    })

    const response = await request(buildApp())
      .post('/api/v1/auth/google')
      .set('x-forwarded-for', '198.51.100.52')
      .send({ idToken: 'opaque-google-token' })

    expect(response.status).toBe(200)
    expect(authServiceMock.loginWithGoogle).toHaveBeenCalledWith(
      { idToken: 'opaque-google-token' },
      '198.51.100.52'
    )
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

  it.each([
    [429, 'rate_limited'],
    [503, 'authority_unavailable'],
  ] as const)(
    'expires the Profile cookie without claiming logout success when revocation returns %s',
    async (status, code) => {
      authServiceMock.logoutUserSession.mockRejectedValueOnce(
        new ControlApiError('private upstream detail', status, { error: { code } })
      )

      const response = await request(buildApp())
        .post('/api/v1/auth/logout')
        .set('Cookie', 'profile_session=opaque-session')
        .set('x-forwarded-proto', 'https')
        .expect(status)

      expect(response.body.error.code).toBe(code)
      expect(JSON.stringify(response.body)).not.toContain('private upstream detail')
      expect(response.body.ok).toBeUndefined()
      expect(authServiceMock.logoutUserSession).toHaveBeenCalledOnce()
      const cookie = String(response.headers['set-cookie'])
      expect(cookie).toContain('profile_session=')
      expect(cookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Path=/')
    }
  )

  it('preserves successful logout and expires the Profile cookie', async () => {
    authServiceMock.logoutUserSession.mockResolvedValueOnce(undefined)

    const response = await request(buildApp())
      .post('/api/v1/auth/logout')
      .set('Cookie', 'profile_session=opaque-session')
      .set('x-forwarded-proto', 'https')
      .expect(200)

    expect(response.body).toEqual({ ok: true })
    expect(String(response.headers['set-cookie'])).toContain(
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    )
    expect(String(response.headers['set-cookie'])).toContain('Secure')
  })

  it('keeps already-invalid logout idempotent and expires its cookie', async () => {
    authServiceMock.logoutUserSession.mockRejectedValueOnce(
      new ControlApiError('private upstream detail', 401, { error: 'Unauthorized' })
    )

    const response = await request(buildApp())
      .post('/api/v1/auth/logout')
      .set('Cookie', 'profile_session=opaque-session')
      .set('x-forwarded-proto', 'https')
      .expect(200)

    expect(response.body).toEqual({ ok: true })
    expect(String(response.headers['set-cookie'])).toContain(
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    )
  })

  it('does not call remote revocation or set a cookie when no session is present', async () => {
    const response = await request(buildApp()).post('/api/v1/auth/logout').expect(200)

    expect(response.body).toEqual({ ok: true })
    expect(authServiceMock.logoutUserSession).not.toHaveBeenCalled()
    expect(String(response.headers['set-cookie'])).toContain(
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    )
  })
})
