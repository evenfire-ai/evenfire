import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createExternalAccessRouter } from '../src/routes/external/access.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { signUserSessionV2Token } from '../src/utils/auth/userSessionV2Token.js'

const mocks = vi.hoisted(() => ({
  validateV1: vi.fn(),
  validateV2: vi.fn(),
  resolvePolicy: vi.fn(),
  resolveAuthorization: vi.fn(),
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
vi.mock('../src/services/access/liveAuthorizationResolver.js', () => ({
  resolveLiveAuthorization: mocks.resolveAuthorization,
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
    computeCatalogShadow: false,
    serveCatalog: true,
    actionContextV2: true,
    rpcDelegationV2: false,
    desktopAllTeamMode: false,
    profileV2Mode: false,
    minimumClientVersion: null,
    enforceMinimumClient: false,
    advertisedCatalogFamilies: [],
    ...overrides,
  }
}

function app() {
  const value = express()
  value.use(express.json())
  value.use(createExternalAccessRouter({} as never))
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

  it('limits catalog before runtime policy work using the retained user bucket', async () => {
    const response = await request(app())
      .get('/external/access/catalog')
      .set('x-user-session-token', sessionToken())
    expect(response.status).toBe(429)
    expect(response.body).toMatchObject({ error: { code: 'rate_limited' } })
    expect(response.headers['retry-after']).toBeDefined()
    expect(rateLimiter.checkAndIncrement).toHaveBeenCalledWith(
      `external_access_catalog:${userId}`,
      10
    )
    expect(mocks.resolvePolicy).not.toHaveBeenCalled()
    expect(mocks.resolveAuthorization).not.toHaveBeenCalled()
  })

  it('shares the users edge family across capabilities and resolve without per-user PG charges', async () => {
    const server = app()
    const session = sessionToken()
    const limit = config.approvalRlExternalEdgePerMin
    expect(limit).toBe(120)
    for (let index = 0; index < limit; index += 1) {
      const response =
        index % 2 === 0
          ? await request(server)
              .get('/external/access/capabilities')
              .set('x-user-session-token', session)
          : await request(server)
              .post('/external/access/resolve')
              .set('x-user-session-token', session)
              .send({})
      expect(response.status).toBe(index % 2 === 0 ? 200 : 400)
    }
    await request(server)
      .get('/external/access/capabilities')
      .set('x-user-session-token', session)
      .expect(429)
    expect(rateLimiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(mocks.resolvePolicy).toHaveBeenCalled()
  })

  it('rejects an invalid GET /external/access/catalog session before limiting or policy work', async () => {
    const response = await request(app())
      .get('/external/access/catalog')
      .set('x-user-session-token', 'invalid-session')

    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ error: { code: 'invalid_session' } })
    expect(rateLimiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(mocks.resolvePolicy).not.toHaveBeenCalled()
  })

  // Capabilities and resolve use the single session boundary shared by every
  // other protected route: policy and the minimum-client gate are read once,
  // before identity, and no PG limiter is charged.
  it.each([
    ['GET', '/external/access/capabilities'],
    ['POST', '/external/access/resolve'],
  ] as const)(
    'rejects an invalid %s %s session through the single session boundary',
    async (method, path) => {
      const response = await request(app())
        [method === 'GET' ? 'get' : 'post'](path)
        .set('x-user-session-token', 'invalid-session')
        .send(method === 'POST' ? {} : undefined)

      expect(response.status).toBe(401)
      expect(response.body).toMatchObject({ error: { code: 'invalid_session' } })
      expect(rateLimiter.checkAndIncrement).not.toHaveBeenCalled()
      expect(mocks.resolvePolicy).toHaveBeenCalledOnce()
    }
  )

  it.each([
    ['GET', '/external/access/catalog'],
    ['POST', '/external/access/resolve'],
  ] as const)('preserves 409 when %s %s reaches final policy validation', async (method, path) => {
    rateLimiter.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
      backendAvailable: true,
    })
    mocks.resolvePolicy.mockResolvedValue(
      effectivePolicy({ serveCatalog: false, actionContextV2: false })
    )

    const response = await request(app())
      [method === 'GET' ? 'get' : 'post'](path)
      .set('x-user-session-token', sessionToken())
      .send(method === 'POST' ? {} : undefined)

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ error: { code: 'invalid_request' } })
    expect(mocks.resolvePolicy).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['GET', '/external/access/catalog'],
    ['POST', '/external/access/resolve'],
  ] as const)('preserves 503 when %s %s reaches final policy validation', async (method, path) => {
    rateLimiter.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      backendAvailable: true,
      count: 1,
    })
    mocks.resolvePolicy
      .mockResolvedValueOnce(effectivePolicy())
      .mockRejectedValueOnce(new Error('readiness unavailable'))

    const response = await request(app())
      [method === 'GET' ? 'get' : 'post'](path)
      .set('x-user-session-token', sessionToken())
      .send(method === 'POST' ? {} : undefined)

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ error: { code: 'authority_unavailable' } })
    expect(mocks.resolvePolicy).toHaveBeenCalledTimes(2)
  })

  it('continues an allowed resolve request after final policy validation', async () => {
    rateLimiter.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      backendAvailable: true,
      count: 1,
    })
    const teamId = '40000000-0000-4000-8000-000000000004'
    const accessPathId = `ap1_${'A'.repeat(43)}`
    mocks.resolveAuthorization.mockResolvedValue({
      status: 'allowed',
      effectiveCapabilities: ['team.manage'],
      paths: [{ id: accessPathId, kind: 'team', teamId }],
      selectedPath: { id: accessPathId, kind: 'team', teamId },
      authorizationRevision: 'revision-1',
    })

    const response = await request(app())
      .post('/external/access/resolve')
      .set('x-user-session-token', sessionToken())
      .send({
        requiredCapability: 'team.manage',
        resource: {
          environmentId: canonicalEnvironmentId(),
          type: 'team',
          logicalId: teamId,
        },
        operationTarget: { teamId, action: 'rename' },
      })

    expect(response.status).toBe(200)
    expect(mocks.resolvePolicy).toHaveBeenCalledTimes(2)
    expect(mocks.resolveAuthorization).toHaveBeenCalledOnce()
  })

  it('rejects a session revoked after one validation for POST /external/access/resolve', async () => {
    mocks.validateV2.mockResolvedValueOnce({ status: 'revoked', reason: 'logout' })

    const response = await request(app())
      .post('/external/access/resolve')
      .set('x-user-session-token', sessionToken())
      .send({})

    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ error: { code: 'invalid_session' } })
    // One live session validation per request (P-7).
    expect(mocks.validateV2).toHaveBeenCalledOnce()
    expect(mocks.resolveAuthorization).not.toHaveBeenCalled()
  })

  it.each([['GET', '/external/access/catalog']] as const)(
    'rechecks current session authority for %s %s',
    async (method, path) => {
      rateLimiter.checkAndIncrement.mockResolvedValue({
        allowed: true,
        remaining: 9,
        resetMs: Date.now() + 60_000,
        windowStartMs: Date.now(),
        backendAvailable: true,
        count: 1,
      })
      mocks.validateV2
        .mockResolvedValueOnce({
          status: 'valid',
          identity: {
            userId,
            email: 'user@example.test',
            sid: sessionId,
            jti: sessionJti,
            sessionVersion: 1,
          },
        })
        .mockResolvedValueOnce({ status: 'revoked', reason: 'logout' })

      const response = await request(app())
        [method === 'GET' ? 'get' : 'post'](path)
        .set('x-user-session-token', sessionToken())
        .send(method === 'POST' ? {} : undefined)

      expect(response.status).toBe(401)
      expect(response.body).toMatchObject({ error: { code: 'invalid_session' } })
      expect(mocks.validateV2).toHaveBeenCalledTimes(2)
      expect(mocks.resolveAuthorization).not.toHaveBeenCalled()
    }
  )
})
