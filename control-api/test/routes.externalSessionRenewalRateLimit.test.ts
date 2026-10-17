import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'
import {
  ExternalSessionBackendUnavailableError,
  runExternalSessionDatabaseOperation,
} from '../src/services/auth/sessionDatabaseFailure.js'

const sessions = vi.hoisted(() => ({
  authenticateExternalUserSession: vi.fn(),
  renewExternalUserSession: vi.fn(),
}))

const limiter = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))

vi.mock('../src/services/auth/externalSessionAuthentication.js', () => sessions)
vi.mock('../src/services/rateLimiterService.js', () => limiter)

function app() {
  const value = express()
  value.use(express.json())
  value.use(createExternalAuthRouter({} as never))
  value.use(clerumErrorHandler)
  return value
}

describe('external session route error boundaries and renewal rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessions.authenticateExternalUserSession.mockResolvedValue({
      status: 'authenticated',
      contract: 'v2',
      claims: {
        userId: 'user-1',
        email: 'user@example.test',
        teamId: null,
        role: 'member',
      },
      authorityContext: { contract: 'v2', userId: 'user-1', sid: 'sid-1', jti: 'jti-1' },
      policy: {},
    })
    sessions.renewExternalUserSession.mockResolvedValue({
      status: 'renewed',
      session: {
        token: 'rotated-session',
        expiresInSeconds: 3600,
        identity: { absoluteExpiresAt: new Date('2030-01-01T00:00:00.000Z') },
      },
    })
    limiter.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 10,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 0,
      backendAvailable: true,
    })
  })

  it('stops a rate-limited authenticated renewal before rotating the session', async () => {
    limiter.checkAndIncrement
      .mockResolvedValueOnce({
        allowed: true,
        remaining: 9,
        resetMs: Date.now() + 60_000,
        windowStartMs: Date.now(),
        count: 1,
        backendAvailable: true,
      })
      .mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetMs: Date.now() + 60_000,
        windowStartMs: Date.now(),
        count: 11,
        backendAvailable: true,
      })
    const response = await request(app())
      .post('/external/auth/session/renew')
      .set('x-forwarded-for', '203.0.113.44')
      .send({ token: 'session-token' })

    expect(response.status).toBe(429)
    expect(response.body).toMatchObject({ error: { code: 'rate_limited' } })
    expect(response.headers['retry-after']).toBeDefined()
    expect(sessions.authenticateExternalUserSession).toHaveBeenCalledWith(
      'session-token',
      expect.objectContaining({ purpose: 'renew' })
    )
    expect(limiter.checkAndIncrement).toHaveBeenNthCalledWith(
      2,
      'external_session_lifecycle:user:user-1',
      10
    )
    expect(sessions.renewExternalUserSession).not.toHaveBeenCalled()
  })

  it('keeps an application authentication error on the sanitized 500 path', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    sessions.authenticateExternalUserSession.mockRejectedValueOnce(
      new Error('private session policy invariant')
    )

    try {
      const response = await request(app())
        .post('/external/auth/verify')
        .send({ token: 'session-token' })

      expect(response.status).toBe(500)
      expect(response.body).toMatchObject({ error: 'Internal Server Error' })
      expect(JSON.stringify(response.body)).not.toContain('private session policy invariant')
      expect(JSON.stringify(response.headers)).not.toContain('private session policy invariant')
      expect(response.headers['retry-after']).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('preserves canonical 503 semantics for a database-boundary outage', async () => {
    let databaseFailure: unknown
    try {
      await runExternalSessionDatabaseOperation(async () => {
        throw new Error('private pg-pool acquire sentinel')
      })
    } catch (error) {
      databaseFailure = error
    }
    expect(databaseFailure).toBeInstanceOf(ExternalSessionBackendUnavailableError)

    sessions.authenticateExternalUserSession.mockRejectedValueOnce(databaseFailure)

    const response = await request(app())
      .post('/external/auth/verify')
      .send({ token: 'session-token' })

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'session_backend_unavailable', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(JSON.stringify(response.body)).not.toContain('private pg-pool acquire sentinel')
    expect(JSON.stringify(response.headers)).not.toContain('private pg-pool acquire sentinel')
  })

  it('returns the authenticated claims on successful session verification', async () => {
    const response = await request(app())
      .post('/external/auth/verify')
      .send({ token: 'session-token' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      claims: {
        userId: 'user-1',
        email: 'user@example.test',
        teamId: null,
        role: 'member',
      },
    })
  })

  it.each([
    ['invalid', 401, 'invalid_session'],
    ['upgrade_required', 426, 'upgrade_required'],
  ] as const)(
    'preserves the %s authentication result',
    async (status, expectedStatus, expectedCode) => {
      sessions.authenticateExternalUserSession.mockResolvedValueOnce({ status })

      const response = await request(app())
        .post('/external/auth/verify')
        .send({ token: 'session-token' })

      expect(response.status).toBe(expectedStatus)
      expect(response.body.error.code).toBe(expectedCode)
    }
  )
})
