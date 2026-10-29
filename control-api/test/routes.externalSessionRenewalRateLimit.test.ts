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
        token: 'synthetic-rotated-session',
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

  it('renews an authenticated session without a lifecycle PG budget (dev parity)', async () => {
    // A denying limiter would surface as 429 if renewal still charged a bucket.
    limiter.checkAndIncrement.mockResolvedValue({
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
      .send({ token: 'synthetic-session-token' })

    expect(response.status).toBe(200)
    expect(sessions.authenticateExternalUserSession).toHaveBeenCalledWith(
      'synthetic-session-token',
      expect.objectContaining({ purpose: 'renew' })
    )
    expect(sessions.renewExternalUserSession).toHaveBeenCalledOnce()
    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
  })

  it('keeps an application authentication error on the sanitized 500 path', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    sessions.authenticateExternalUserSession.mockRejectedValueOnce(
      new Error('private session policy invariant')
    )

    try {
      const response = await request(app())
        .post('/external/auth/verify')
        .send({ token: 'synthetic-session-token' })

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
      .send({ token: 'synthetic-session-token' })

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
      .send({ token: 'synthetic-session-token' })

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

  it('returns the dev Unauthorized body when the session is invalid', async () => {
    sessions.authenticateExternalUserSession.mockResolvedValueOnce({ status: 'invalid' })

    const response = await request(app())
      .post('/external/auth/verify')
      .send({ token: 'synthetic-session-token' })

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
  })

  it('returns the dev Unauthorized body when the token is missing', async () => {
    const response = await request(app()).post('/external/auth/verify').send({})

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(sessions.authenticateExternalUserSession).not.toHaveBeenCalled()
  })

  it('preserves the upgrade_required envelope for a client below the minimum', async () => {
    sessions.authenticateExternalUserSession.mockResolvedValueOnce({ status: 'upgrade_required' })

    const response = await request(app())
      .post('/external/auth/verify')
      .send({ token: 'synthetic-session-token' })

    expect(response.status).toBe(426)
    expect(response.body.error.code).toBe('upgrade_required')
  })
})
