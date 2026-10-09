import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createInvitationsRouter } from '../src/routes/invitations.js'

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)

const fetchMock = vi.fn<typeof fetch>()

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createInvitationsRouter())
  return app
}

function upstreamResponse(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
  })
}

describe('accepted invitation password authority outcomes', () => {
  let previousControlApiBaseUrl: string
  let previousControlApiServiceToken: string

  beforeEach(() => {
    authTokenMock.verifyToken.mockReset().mockReturnValue({
      userId: 'synthetic-user-id',
      email: 'member@example.invalid',
      teamId: '',
      role: 'member',
      exp: 4_102_444_800,
    })
    previousControlApiBaseUrl = config.controlApiBaseUrl
    previousControlApiServiceToken = config.controlApiServiceToken
    config.controlApiBaseUrl = 'http://control-api.synthetic.test/api/v1'
    config.controlApiServiceToken = 'synthetic-internal-service-token'
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    config.controlApiBaseUrl = previousControlApiBaseUrl
    config.controlApiServiceToken = previousControlApiServiceToken
    vi.unstubAllGlobals()
  })

  async function submitPassword() {
    return request(makeApp())
      .post('/invitations/password')
      .set('authorization', 'Bearer synthetic-authenticated-session')
      .send({ invitationId: 'synthetic-invitation-row', password: 'Synthetic-Password-123' })
  }

  it('preserves busy-owner denial and permits a later retry without consuming the invitation', async () => {
    fetchMock
      .mockResolvedValueOnce(
        upstreamResponse(
          429,
          { error: 'verification_busy', retryAfterSeconds: 11 },
          { 'retry-after': '11', 'x-ratelimit-remaining': '0' }
        )
      )
      .mockResolvedValueOnce(
        upstreamResponse(200, {
          id: 'synthetic-invitation-row',
          passwordUpdated: true,
          status: 'accepted',
        })
      )

    const denied = await submitPassword()

    expect(denied.status).toBe(429)
    expect(denied.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 11 })
    expect(denied.headers['retry-after']).toBe('11')
    expect(denied.headers['x-ratelimit-remaining']).toBeUndefined()
    expect(JSON.stringify(denied.body)).not.toContain('verification_busy')
    expect(denied.headers['set-cookie']).toBeUndefined()

    const retried = await submitPassword()

    expect(retried.status).toBe(200)
    expect(retried.body).toEqual({
      id: 'synthetic-invitation-row',
      passwordUpdated: true,
      status: 'accepted',
    })
    expect(String(retried.headers['set-cookie'])).toContain(
      'profile_session=synthetic-authenticated-session'
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('preserves authority unavailability without presenting a password-format error', async () => {
    fetchMock.mockResolvedValueOnce(
      upstreamResponse(
        503,
        { error: 'authority_failure', detail: 'private database diagnostic' },
        { 'retry-after': '1200', 'x-ratelimit-remaining': '0' }
      )
    )

    const response = await submitPassword()

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'authority_unavailable', retryAfterSeconds: 900 })
    expect(response.headers['retry-after']).toBe('900')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('invalid_password')
    expect(JSON.stringify(response.body)).not.toContain('database')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
