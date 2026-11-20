import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import * as controlApiClient from '../src/controlApiClient.js'
import { createAuthRouter } from '../src/routes/auth.js'
import { createOidcProfileFlowRouter } from '../src/routes/oidcProfileFlow.js'

const authServiceMock = vi.hoisted(() => ({
  loginWithGoogle: vi.fn(),
  loginWithPassword: vi.fn(),
  requestPasswordReset: vi.fn(),
  logoutUserSession: vi.fn(),
  renewUserSession: vi.fn(),
}))
vi.mock('../src/services/authService.js', () => authServiceMock)

const controlApi = vi.spyOn(controlApiClient, 'controlApiRequestWithStatus')
const SESSION_TOKEN = 'session-token-fixture'
const completeBody = {
  state: 'S'.repeat(43),
  code: 'provider-code',
  browserBinding: 'B'.repeat(43),
}

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/api/v1', createAuthRouter())
  app.use('/api/v1', createOidcProfileFlowRouter())
  return app
}

afterEach(() => {
  controlApi.mockReset()
  authServiceMock.loginWithPassword.mockReset()
})

describe('External REST OIDC member sign-in (dev spike)', () => {
  it('sets exactly the session cookie password login sets, and keeps the token out of the body', async () => {
    authServiceMock.loginWithPassword.mockResolvedValue({
      token: SESSION_TOKEN,
      me: { id: 'user-1' },
    })
    const password = await request(buildApp())
      .post('/api/v1/auth/password-login')
      .set('Origin', 'https://profile.example.test')
      .send({ email: 'member@example.test', password: 'fixture-password' })
    expect(password.status).toBe(200)

    controlApi.mockResolvedValue({
      data: {
        outcome: 'member_signed_in',
        memberAuthenticationActivated: true,
        token: SESSION_TOKEN,
        sessionContract: 'v1',
      },
      status: 200,
    } as never)
    const oidc = await request(buildApp())
      .post('/api/v1/oidc/profile-flow/complete')
      .send(completeBody)

    expect(oidc.status).toBe(200)
    expect(oidc.body).toEqual({ outcome: 'member_signed_in', memberAuthenticationActivated: true })
    expect(JSON.stringify(oidc.body)).not.toContain(SESSION_TOKEN)
    const passwordCookie = password.headers['set-cookie']
    expect(passwordCookie).toHaveLength(1)
    expect(String(passwordCookie[0])).toMatch(/^profile_session=session-token-fixture;/)
    expect(oidc.headers['set-cookie']).toEqual(passwordCookie)
  })

  it('passes a refused member sign-in through without a session cookie', async () => {
    controlApi.mockResolvedValue({
      data: {
        outcome: 'identity_proof_verified',
        memberAuthenticationActivated: true,
        memberSignIn: 'no_matching_member',
      },
      status: 200,
    } as never)
    const response = await request(buildApp())
      .post('/api/v1/oidc/profile-flow/complete')
      .send(completeBody)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      outcome: 'identity_proof_verified',
      memberAuthenticationActivated: true,
      memberSignIn: 'no_matching_member',
    })
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it.each([
    ['a missing token', { outcome: 'member_signed_in', memberAuthenticationActivated: true }],
    [
      'an oversized token',
      { outcome: 'member_signed_in', memberAuthenticationActivated: true, token: 'x'.repeat(4097) },
    ],
    [
      'a session while sign-in is off',
      { outcome: 'member_signed_in', memberAuthenticationActivated: false, token: SESSION_TOKEN },
    ],
    [
      'an unknown refusal shape',
      { outcome: 'identity_proof_verified', memberAuthenticationActivated: true },
    ],
  ])('fails closed on %s', async (_label, data) => {
    controlApi.mockResolvedValue({ data, status: 200 } as never)
    const response = await request(buildApp())
      .post('/api/v1/oidc/profile-flow/complete')
      .send(completeBody)

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'oidc_unavailable' })
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('reports the member sign-in switch from Control API configuration', async () => {
    controlApi.mockResolvedValue({
      data: {
        redirectUri: 'https://profile.example.test/api/oidc/callback',
        memberAuthenticationActivated: true,
      },
      status: 200,
    } as never)
    const on = await request(buildApp()).get('/api/v1/oidc/profile-flow/configuration')
    expect(on.status).toBe(200)
    expect(on.body.memberAuthenticationActivated).toBe(true)

    controlApi.mockResolvedValue({
      data: {
        redirectUri: 'https://profile.example.test/api/oidc/callback',
        memberAuthenticationActivated: 'yes',
      },
      status: 200,
    } as never)
    const malformed = await request(buildApp()).get('/api/v1/oidc/profile-flow/configuration')
    expect(malformed.status).toBe(503)
  })
})
