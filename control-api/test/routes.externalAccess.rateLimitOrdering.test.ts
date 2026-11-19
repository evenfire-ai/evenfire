import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createExternalAccessRouter } from '../src/routes/external/access.js'
import { signUserSessionV2Token } from '../src/utils/auth/userSessionV2Token.js'

const mocks = vi.hoisted(() => ({
  validateV1: vi.fn(),
  validateV2: vi.fn(),
  resolvePolicy: vi.fn(),
}))

const rateLimiter = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))

vi.mock('../src/services/auth/userSessionService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/auth/userSessionService.js')>()
  return {
    ...actual,
    validateLegacyUserSession: mocks.validateV1,
    validateUserSessionClaims: mocks.validateV2,
  }
})
vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => ({
  resolveEffectiveUserAccessPolicy: mocks.resolvePolicy,
}))
vi.mock('../src/services/rateLimiterService.js', () => rateLimiter)

const userId = '10000000-0000-4000-8000-000000000001'
const sessionId = '20000000-0000-4000-8000-000000000002'
const sessionJti = '30000000-0000-4000-8000-000000000003'

function sessionToken() {
  return signUserSessionV2Token({
    sub: userId,
    sid: sessionId,
    jti: sessionJti,
    sv: 1,
    email: 'user@example.test',
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
}

function effectivePolicy(overrides: Record<string, unknown> = {}) {
  return {
    policyVersion: '1',
    policyRevision: 'test-policy',
    acceptV1: true,
    issueV1: true,
    acceptV2: true,
    issueV2: false,
    renewV2: false,
    switchCompatibility: true,
    actionContextV2: true,
    rpcDelegationV2: false,
    minimumClientVersion: null,
    enforceMinimumClient: false,
    ...overrides,
  }
}

function app() {
  const value = express()
  value.use(express.json())
  value.use(createExternalAccessRouter())
  return value
}

describe('external access authenticated rate-limit ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.validateV2.mockResolvedValue({
      status: 'valid',
      identity: {
        userId,
        email: 'user@example.test',
        sid: sessionId,
        jti: sessionJti,
        sessionVersion: 1,
      },
    })
    mocks.resolvePolicy.mockResolvedValue(effectivePolicy())
    rateLimiter.checkAndIncrement.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      backendAvailable: true,
      count: 11,
    })
  })

  it('limits capabilities on the users edge family without per-user PG charges', async () => {
    const server = app()
    const session = sessionToken()
    const limit = config.approvalRlExternalEdgePerMin
    expect(limit).toBe(120)
    for (let index = 0; index < limit; index += 1) {
      await request(server)
        .get('/external/access/capabilities')
        .set('x-user-session-token', session)
        .expect(200)
    }
    await request(server)
      .get('/external/access/capabilities')
      .set('x-user-session-token', session)
      .expect(429)
    expect(rateLimiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(mocks.resolvePolicy).toHaveBeenCalled()
  })

  // Capabilities uses the single session boundary shared by every other
  // protected route: policy and the minimum-client gate are read once, before
  // identity, and no PG limiter is charged.
  it('rejects an invalid capabilities session through the single session boundary', async () => {
    const response = await request(app())
      .get('/external/access/capabilities')
      .set('x-user-session-token', 'invalid-session')

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(rateLimiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(mocks.resolvePolicy).toHaveBeenCalledOnce()
  })
})
