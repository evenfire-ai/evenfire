import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ControlApiError } from '../src/controlApiClient.js'
import { createAuthRouter } from '../src/routes/auth.js'

const authServiceMock = vi.hoisted(() => ({
  loginWithGoogle: vi.fn(),
  loginWithPassword: vi.fn(),
}))

const identityProviderServiceMock = vi.hoisted(() => ({
  exchangeIdentityProviderLogin: vi.fn(),
  listIdentityProviders: vi.fn(),
  startMicrosoftIdentityProviderLogin: vi.fn(),
}))

vi.mock('../src/services/authService.js', () => authServiceMock)
vi.mock('../src/services/identityProvidersService.js', () => identityProviderServiceMock)

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
})

describe('routes/auth Microsoft identity provider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fails closed when a browser start request has no Origin header', async () => {
    const response = await request(buildApp())
      .post('/api/v1/auth/providers/microsoft/start')
      .set('x-forwarded-for', '198.51.100.10')
      .send({
        connectionId: 'connection-1',
        flow: 'profile_login',
        flowBinding: 'a'.repeat(43),
        returnUrl: 'http://localhost:3001/auth/provider-callback',
      })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_return_url' })
    expect(identityProviderServiceMock.startMicrosoftIdentityProviderLogin).not.toHaveBeenCalled()
  })

  it('rejects a malformed browser return URL as a client error', async () => {
    const response = await request(buildApp())
      .post('/api/v1/auth/providers/microsoft/start')
      .set('origin', 'http://localhost:3001')
      .set('x-forwarded-for', '198.51.100.11')
      .send({
        connectionId: 'connection-1',
        flow: 'profile_login',
        flowBinding: 'b'.repeat(43),
        returnUrl: 'not a URL',
      })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_return_url' })
  })

  it('passes the initiating client binding through start and exchange', async () => {
    identityProviderServiceMock.startMicrosoftIdentityProviderLogin.mockResolvedValueOnce({
      authorizeUrl: 'https://login.microsoftonline.com/authorize',
    })
    identityProviderServiceMock.exchangeIdentityProviderLogin.mockResolvedValueOnce({
      token: 'desktop-session-jwt',
      me: { id: 'user-1' },
    })
    const binding = 'c'.repeat(43)

    await request(buildApp())
      .post('/api/v1/auth/providers/microsoft/start')
      .set('origin', 'http://localhost:3001')
      .set('x-forwarded-for', '198.51.100.12')
      .send({
        connectionId: 'connection-1',
        flow: 'profile_login',
        flowBinding: binding,
        returnUrl: 'http://localhost:3001/auth/provider-callback',
      })
      .expect(200)

    await request(buildApp())
      .post('/api/v1/auth/providers/exchange')
      .set('x-forwarded-for', '198.51.100.13')
      .send({ code: 'login-code', flowBinding: binding })
      .expect(200)

    expect(identityProviderServiceMock.startMicrosoftIdentityProviderLogin).toHaveBeenCalledWith(
      expect.objectContaining({ flowBinding: binding })
    )
    expect(identityProviderServiceMock.exchangeIdentityProviderLogin).toHaveBeenCalledWith(
      'login-code',
      binding
    )
  })

  it('rate-limits repeated Microsoft login start requests from one client', async () => {
    identityProviderServiceMock.startMicrosoftIdentityProviderLogin.mockResolvedValue({
      authorizeUrl: 'https://login.microsoftonline.com/authorize',
    })
    const requestBody = {
      connectionId: 'connection-1',
      flow: 'profile_login',
      flowBinding: 'd'.repeat(43),
      returnUrl: 'http://localhost:3001/auth/provider-callback',
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await request(buildApp())
        .post('/api/v1/auth/providers/microsoft/start')
        .set('origin', 'http://localhost:3001')
        .set('x-forwarded-for', '198.51.100.20')
        .send(requestBody)
        .expect(200)
    }

    await request(buildApp())
      .post('/api/v1/auth/providers/microsoft/start')
      .set('origin', 'http://localhost:3001')
      .set('x-forwarded-for', '198.51.100.20')
      .send(requestBody)
      .expect(429)
  })
})
