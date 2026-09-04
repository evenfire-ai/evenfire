import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'

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
  return value
}

describe('external session renewal rate limiting', () => {
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
    limiter.checkAndIncrement
      .mockResolvedValueOnce({
        allowed: true,
        remaining: 9,
        resetMs: Date.now() + 60_000,
        windowStartMs: Date.now(),
        count: 1,
      })
      .mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetMs: Date.now() + 60_000,
        windowStartMs: Date.now(),
        count: 11,
      })
  })

  it('stops a rate-limited authenticated renewal before rotating the session', async () => {
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
})
