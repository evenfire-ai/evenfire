import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ControlApiError } from '../src/controlApiClient.js'
import { createAuthRouter } from '../src/routes/auth.js'

const authServiceMock = vi.hoisted(() => ({
  loginWithGoogle: vi.fn(),
  loginWithPassword: vi.fn(),
}))

vi.mock('../src/services/authService.js', () => authServiceMock)

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
  beforeEach(() => {
    authServiceMock.loginWithPassword.mockReset()
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
})
