import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createApp } from '../src/app.js'
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

const realControlApiRequest = controlApiClient.controlApiRequestWithStatus
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
  vi.useRealTimers()
  controlApi.mockReset()
  authServiceMock.loginWithPassword.mockReset()
})

const REASONS = [
  'account_disabled',
  'identity_conflict',
  'account_needs_attention',
  'email_claim_missing',
  'email_unverified',
  'not_eligible',
  'no_account',
  'provider_configuration',
] as const
const CONFIG_URI = 'https://profile.example.test/api/oidc/callback'

async function complete(data: unknown) {
  controlApi.mockResolvedValue({ data, status: 200 } as never)
  return request(buildApp()).post('/api/v1/oidc/profile-flow/complete').send(completeBody)
}

describe('External REST OIDC member sign-in', () => {
  it('member_signed_in sets the same cookie as password login, and keeps the token out of the body', async () => {
    // The cookie's Expires is rounded to the second: freeze the clock so the two
    // responses cannot straddle a second boundary. Only Date is faked, so the
    // HTTP round trips still run on real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-21T12:00:00.500Z'))
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

  it.each(REASONS)('passes the allowlisted refusal reason %s without a cookie', async reason => {
    const response = await complete({
      outcome: 'refused',
      memberAuthenticationActivated: true,
      reason,
      token: 'must-not-escape',
    })
    expect(controlApi).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      outcome: 'refused',
      memberAuthenticationActivated: true,
      reason,
    })
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it.each([
    [
      'an unknown reason',
      { outcome: 'refused', memberAuthenticationActivated: true, reason: 'bogus' },
    ],
    ['a missing reason', { outcome: 'refused', memberAuthenticationActivated: true }],
    [
      'a refusal while sign-in is off',
      { outcome: 'refused', memberAuthenticationActivated: false, reason: 'no_account' },
    ],
    [
      'the retired spike refusal shape',
      {
        outcome: 'identity_proof_verified',
        memberAuthenticationActivated: true,
        memberSignIn: 'no_matching_member',
      },
    ],
    [
      'an unknown refusal shape',
      { outcome: 'identity_proof_verified', memberAuthenticationActivated: true },
    ],
    ['a missing token', { outcome: 'member_signed_in', memberAuthenticationActivated: true }],
    [
      'an oversized token',
      { outcome: 'member_signed_in', memberAuthenticationActivated: true, token: 'x'.repeat(4097) },
    ],
    [
      'a session while sign-in is off',
      { outcome: 'member_signed_in', memberAuthenticationActivated: false, token: SESSION_TOKEN },
    ],
  ])('rejects %s with 503 and no cookie', async (_label, data) => {
    const response = await complete(data)
    expect(controlApi).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'oidc_unavailable' })
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('passes the identity-proof outcome through while sign-in is off', async () => {
    const response = await complete({
      outcome: 'identity_proof_verified',
      memberAuthenticationActivated: false,
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      outcome: 'identity_proof_verified',
      memberAuthenticationActivated: false,
    })
  })

  it('keeps the storage-unavailable failure as 503 with its retry flag', async () => {
    controlApi.mockRejectedValue(
      new controlApiClient.ControlApiError('upstream', 503, {
        error: 'oidc_storage_unavailable',
        retrySameAttempt: false,
      })
    )
    const response = await request(buildApp())
      .post('/api/v1/oidc/profile-flow/complete')
      .send(completeBody)
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'oidc_storage_unavailable', retrySameAttempt: false })
  })

  it('forwards displayLabel and omits an invalid or missing one with 200', async () => {
    const get = async (extra: Record<string, unknown>) => {
      controlApi.mockResolvedValue({
        data: { redirectUri: CONFIG_URI, memberAuthenticationActivated: true, ...extra },
        status: 200,
      } as never)
      return request(buildApp()).get('/api/v1/oidc/profile-flow/configuration')
    }
    const ok = await get({ displayLabel: 'Acme SSO' })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({
      redirectUri: CONFIG_URI,
      memberAuthenticationActivated: true,
      displayLabel: 'Acme SSO',
    })
    const edge = await get({ displayLabel: 'x'.repeat(80) })
    expect(edge.body.displayLabel).toBe('x'.repeat(80))
    for (const bad of ['', 'x'.repeat(81), 42, null, { a: 1 }]) {
      const response = await get({ displayLabel: bad })
      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        redirectUri: CONFIG_URI,
        memberAuthenticationActivated: true,
      })
    }
    const missing = await get({})
    expect(missing.status).toBe(200)
    expect(missing.body).toEqual({ redirectUri: CONFIG_URI, memberAuthenticationActivated: true })
  })

  it('rejects a malformed member sign-in switch with 503', async () => {
    controlApi.mockResolvedValue({
      data: { redirectUri: CONFIG_URI, memberAuthenticationActivated: 'yes', displayLabel: 'Acme' },
      status: 200,
    } as never)
    const malformed = await request(buildApp()).get('/api/v1/oidc/profile-flow/configuration')
    expect(malformed.status).toBe(503)
  })

  it('rotating X-Forwarded-For values still hit the per-socket ceiling', async () => {
    controlApi.mockResolvedValue({
      data: { redirectUri: CONFIG_URI, memberAuthenticationActivated: false },
      status: 200,
    } as never)
    const server = buildApp()
    const send = (i: number) =>
      request(server)
        .get('/api/v1/oidc/profile-flow/configuration')
        .set('X-Forwarded-For', `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`)
    for (let i = 0; i < 600; i++) {
      const ok = await send(i)
      if (ok.status !== 200) throw new Error(`request ${i} unexpectedly ${ok.status}`)
    }
    const limited = await send(600)
    expect(limited.status).toBe(429)
    expect(controlApi).toHaveBeenCalledTimes(600)
  })

  it('the control-api call carries the browser IP that Profile UI forwarded', async () => {
    controlApi.mockImplementation(realControlApiRequest)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ redirectUri: CONFIG_URI, memberAuthenticationActivated: false }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    )
    try {
      const response = await request(createApp())
        .get('/api/v1/oidc/profile-flow/configuration')
        .set('X-Forwarded-For', '203.0.113.9')
      expect(response.status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const init = fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }
      expect(init.headers['x-external-client-ip']).toBe('203.0.113.9')
    } finally {
      fetchSpy.mockRestore()
      controlApi.mockReset()
    }
  })
})
