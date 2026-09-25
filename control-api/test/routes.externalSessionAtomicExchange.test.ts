import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'

const sessions = vi.hoisted(() => ({ authenticateExternalUserSession: vi.fn() }))
const issuance = vi.hoisted(() => ({
  exchangeLegacyExternalUserSession: vi.fn(),
  issueExternalUserSession: vi.fn(),
  selectExternalSessionRepresentation: vi.fn(),
}))
const limiter = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
const database = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../src/services/auth/externalSessionAuthentication.js', () => ({
  ...sessions,
  renewExternalUserSession: vi.fn(),
}))
vi.mock('../src/services/auth/externalSessionIssuance.js', () => issuance)
vi.mock('../src/services/rateLimiterService.js', () => limiter)
vi.mock('../src/db.js', () => ({ pool: { query: database.query } }))

function app() {
  const value = express()
  value.use(express.json())
  value.use(createExternalAuthRouter({} as never))
  return value
}

describe('legacy external-session replacement exchange', () => {
  const claims = {
    userId: 'user-1',
    email: 'user@example.test',
    teamId: 'team-old',
    role: 'admin' as const,
    authGeneration: 1,
    iat: 1_700_000_000,
    exp: 1_800_000_000,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    limiter.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })
    sessions.authenticateExternalUserSession.mockResolvedValue({
      status: 'authenticated',
      contract: 'v1',
      claims,
      authorityContext: {
        contract: 'v1',
        userId: claims.userId,
        tokenHash: 'source-hash',
        issuedAt: claims.iat,
        authGeneration: 1,
      },
      policy: { issueV1: true, switchCompatibility: true },
    })
    issuance.issueExternalUserSession.mockResolvedValue({ token: 'stale-token', contract: 'v1' })
    database.query.mockResolvedValue({
      rows: [{ role: 'admin', lifecycle_version: 1 }],
      rowCount: 1,
    })
  })

  it('fails closed when locked final validation observes a password invalidation', async () => {
    issuance.exchangeLegacyExternalUserSession.mockResolvedValue({ status: 'invalid_session' })

    const response = await request(app())
      .post('/external/auth/session-token')
      .set('x-forwarded-for', '203.0.113.44')
      .set('x-user-session-token', 'source-token')
      .send({ userId: claims.userId, email: claims.email, teamId: 'team-new' })

    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ error: { code: 'invalid_session' } })
    expect(issuance.exchangeLegacyExternalUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'source-token', teamId: 'team-new', claims }),
      expect.objectContaining({ policy: expect.any(Object) })
    )
    expect(issuance.issueExternalUserSession).not.toHaveBeenCalled()
  })

  it('uses the current locked membership role for the replacement representation', async () => {
    issuance.exchangeLegacyExternalUserSession.mockResolvedValue({
      status: 'issued',
      token: 'replacement-token',
      role: 'member',
    })

    const response = await request(app())
      .post('/external/auth/session-token')
      .set('x-forwarded-for', '203.0.113.44')
      .set('x-user-session-token', 'source-token')
      .send({ userId: claims.userId, email: claims.email, teamId: 'team-new' })
      .expect(200)

    expect(response.body).toEqual({
      token: 'replacement-token',
      sessionContract: 'v1',
      deprecated: true,
    })
  })

  it('rejects a removed membership without signing a replacement', async () => {
    issuance.exchangeLegacyExternalUserSession.mockResolvedValue({
      status: 'membership_not_found',
    })

    await request(app())
      .post('/external/auth/session-token')
      .set('x-forwarded-for', '203.0.113.44')
      .set('x-user-session-token', 'source-token')
      .send({ userId: claims.userId, email: claims.email, teamId: 'team-new' })
      .expect(403, { error: 'membership_not_found' })

    expect(issuance.issueExternalUserSession).not.toHaveBeenCalled()
  })
})
