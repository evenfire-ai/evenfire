import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createInvitationsRouter } from '../src/routes/invitations.js'

const fetchMock = vi.fn<typeof fetch>()

const preview = {
  id: 'synthetic-reset-row',
  email: 'member@example.invalid',
  purpose: 'password_reset' as const,
  status: 'pending',
  expiresAt: '2030-01-01T00:00:00.000Z',
  acceptedAt: null,
  userId: 'synthetic-member-id',
  passwordPending: true,
  teamId: null,
  teamName: null,
  role: 'member',
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createInvitationsRouter())
  return app
}

describe('password reset transport outcomes', () => {
  let previousControlApiBaseUrl: string
  let previousControlApiServiceToken: string

  beforeEach(() => {
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

  function previewRequest() {
    return jsonResponse(200, preview)
  }

  async function submitReset() {
    return request(makeApp()).post('/invitations/password').send({
      token: 'synthetic-one-use-recovery-proof',
      email: preview.email,
      invitationId: preview.id,
      password: 'Synthetic-Replacement-Password-123',
    })
  }

  it('reports an unknown outcome after a potentially committed reset without replaying the proof', async () => {
    let passwordChanged = false
    let resetProofConsumed = false
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      if (init?.method === 'GET') return previewRequest()
      if (url.endsWith('/external/invitations/password-token')) {
        passwordChanged = true
        resetProofConsumed = true
        return new Response('<html>upstream gateway failure</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        })
      }
      throw new Error('Unexpected Control API request')
    })

    const response = await submitReset()

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'recovery_outcome_unknown', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('synthetic-one-use-recovery-proof')
    expect(passwordChanged).toBe(true)
    expect(resetProofConsumed).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('sanitizes a rejected reset transport as an unknown outcome and never retries', async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === 'GET') return previewRequest()
      throw new TypeError('connection reset after request dispatch')
    })

    const response = await submitReset()

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'recovery_outcome_unknown', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(JSON.stringify(response.body)).not.toContain('connection reset')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      status: 429,
      upstreamError: 'verification_busy',
      retryAfter: '9',
      publicError: 'rate_limited',
      retryAfterSeconds: 9,
    },
    {
      status: 503,
      upstreamError: 'authority_failure',
      retryAfter: '1200',
      publicError: 'authority_unavailable',
      retryAfterSeconds: 900,
    },
  ])('preserves typed $status admission outcomes with bounded public retry guidance', async row => {
    fetchMock
      .mockResolvedValueOnce(previewRequest())
      .mockResolvedValueOnce(
        jsonResponse(
          row.status,
          { error: row.upstreamError, diagnostic: 'private Control API detail' },
          { 'retry-after': row.retryAfter }
        )
      )

    const response = await submitReset()

    expect(response.status).toBe(row.status)
    expect(response.body).toEqual({
      error: row.publicError,
      retryAfterSeconds: row.retryAfterSeconds,
    })
    expect(response.headers['retry-after']).toBe(String(row.retryAfterSeconds))
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('diagnostic')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports only explicit password and recovery domain rejections', async () => {
    fetchMock
      .mockResolvedValueOnce(previewRequest())
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_password' }))

    const invalidPassword = await submitReset()
    expect(invalidPassword.status).toBe(400)
    expect(invalidPassword.body).toEqual({
      error: 'Password must be between 8 and 256 characters',
    })

    fetchMock
      .mockResolvedValueOnce(previewRequest())
      .mockResolvedValueOnce(
        jsonResponse(410, { error: 'expired', detail: 'private expired-link detail' })
      )
    const expiredProof = await submitReset()
    expect(expiredProof.status).toBe(410)
    expect(expiredProof.body).toEqual({ error: 'Invitation has expired' })
    expect(JSON.stringify(expiredProof.body)).not.toContain('private')
  })
})
