import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalAccessRouter } from '../src/routes/external/access.js'

const token = vi.hoisted(() => ({ verify: vi.fn() }))
const sessions = vi.hoisted(() => ({ validate: vi.fn(), validateLegacy: vi.fn() }))
const rateLimits = vi.hoisted(() => ({ check: vi.fn() }))
const rollout = vi.hoisted(() => ({
  sessionV2Acceptance: true,
  sessionV2Issuance: false,
  aggregateCatalogShadowing: false,
  aggregateCatalogServing: true,
  actionContextV2: true,
  rpcDelegationV2: false,
  desktopAllTeamMode: false,
  profileV2Mode: false,
  legacyV1Acceptance: true,
  legacySwitchEndpoint: true,
  minimumClientVersion: null as string | null,
}))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: token.verify,
}))
vi.mock('../src/services/auth/userSessionService.js', () => ({
  validateUserSessionClaims: sessions.validate,
  validateLegacyUserSession: sessions.validateLegacy,
}))
vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: rateLimits.check,
}))
vi.mock('../src/services/access/userAccessRollout.js', () => ({ userAccessRollout: rollout }))

function app(gateway: Record<string, unknown> = {}) {
  const value = express()
  value.use(express.json())
  value.use(createExternalAccessRouter(gateway as never))
  return value
}

describe('external aggregate access routes', () => {
  beforeEach(() => {
    token.verify.mockReset()
    sessions.validate.mockReset()
    sessions.validateLegacy.mockReset()
    sessions.validateLegacy.mockResolvedValue({ status: 'valid', identity: {} })
    rateLimits.check.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      count: 1,
    })
    sessions.validate.mockResolvedValue({
      status: 'valid',
      identity: {
        email: 'user@example.com',
        jti: '00000000-0000-4000-8000-000000000200',
        sessionVersion: 1,
      },
    })
    Object.assign(rollout, {
      sessionV2Acceptance: true,
      sessionV2Issuance: false,
      aggregateCatalogShadowing: false,
      aggregateCatalogServing: true,
      actionContextV2: true,
      rpcDelegationV2: false,
      desktopAllTeamMode: false,
      profileV2Mode: false,
      legacyV1Acceptance: true,
      legacySwitchEndpoint: true,
      minimumClientVersion: null,
    })
  })

  it('uses the frozen public error envelope for an invalid session', async () => {
    const response = await request(app()).get('/external/access/catalog')

    expect(response.status).toBe(401)
    expect(response.body.error).toEqual({
      code: 'invalid_session',
      message: 'The session is not valid.',
      correlationId: expect.any(String),
      retryable: false,
    })
  })

  it('publishes every compatibility gate and rejects invalid catalog filters', async () => {
    token.verify.mockReturnValue({
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.com',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
      sessionContract: 'v1',
    })

    const manifest = await request(app())
      .get('/external/access/capabilities')
      .set('x-user-session-token', 'legacy-session')

    expect(manifest.status).toBe(200)
    expect(manifest.body).toMatchObject({
      session: {
        v2Accepted: true,
        v2Issued: false,
        issuanceMode: 'client_negotiated',
        currentContract: 'v1',
      },
      aggregateCatalog: {
        shadow: false,
        served: true,
        contractVersion: '2',
        resourceTypes: [
          'user',
          'team',
          'host',
          'context',
          'mcp_server',
          'workflow_recipe',
          'workflow_run',
          'workflow_approval',
          'gfs_resource',
          'shared_filesystem',
          'sandbox_app',
          'notification',
        ],
      },
      actionContext: { v2: true },
      rpcDelegation: { v2: false },
      clientModes: { desktopV2: false, profileV2: false },
      compatibility: {
        legacyV1Accepted: true,
        legacySwitchEndpoint: true,
        minimumClientVersion: null,
      },
    })

    const legacyCatalog = await request(app())
      .get('/external/access/catalog?types=unknown')
      .set('x-user-session-token', 'legacy-session')
    expect(legacyCatalog.status).toBe(409)

    token.verify.mockReturnValue({
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.com',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
      iat: 1_999_996_400,
      sessionContract: 'v2',
      sid: '00000000-0000-4000-8000-000000000100',
      jti: '00000000-0000-4000-8000-000000000200',
      sv: 1,
      authTime: 1_999_996_400,
      amr: ['pwd'],
    })
    const invalid = await request(app())
      .get('/external/access/catalog?types=unknown')
      .set('x-user-session-token', 'v2-session')
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('invalid_request')

    const unsupported = await request(app())
      .get('/external/access/catalog?types=workflow_artifact')
      .set('x-user-session-token', 'v2-session')
    expect(unsupported.status).toBe(400)
    expect(unsupported.body.error.code).toBe('invalid_request')
  })

  it('reports independent rollout controls rather than deriving support from the token', async () => {
    Object.assign(rollout, {
      sessionV2Acceptance: true,
      sessionV2Issuance: true,
      aggregateCatalogShadowing: true,
      aggregateCatalogServing: false,
      actionContextV2: false,
      rpcDelegationV2: true,
      desktopAllTeamMode: true,
      profileV2Mode: true,
      legacyV1Acceptance: true,
      legacySwitchEndpoint: false,
      minimumClientVersion: '2.0.0',
    })
    token.verify.mockReturnValue({
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.com',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
      sessionContract: 'v1',
    })

    const response = await request(app())
      .get('/external/access/capabilities')
      .set('x-user-session-token', 'legacy-session')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      session: { v2Accepted: true, v2Issued: true, currentContract: 'v1' },
      aggregateCatalog: { shadow: true, served: false },
      actionContext: { v2: false },
      rpcDelegation: { v2: true },
      clientModes: { desktopV2: true, profileV2: true },
      compatibility: {
        legacyV1Accepted: true,
        legacySwitchEndpoint: false,
        minimumClientVersion: '2.0.0',
      },
    })
  })

  it('keeps catalog serving and action-context gates independently enforceable', async () => {
    token.verify.mockReturnValue({
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.com',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
      iat: 1_999_996_400,
      sessionContract: 'v2',
      sid: '00000000-0000-4000-8000-000000000100',
      jti: '00000000-0000-4000-8000-000000000200',
      sv: 1,
      authTime: 1_999_996_400,
      amr: ['pwd'],
    })
    rollout.aggregateCatalogServing = false
    rollout.actionContextV2 = true

    const catalog = await request(app())
      .get('/external/access/catalog')
      .set('x-user-session-token', 'v2-session')
    expect(catalog.status).toBe(409)

    rollout.aggregateCatalogServing = true
    rollout.actionContextV2 = false
    const resolution = await request(app())
      .post('/external/access/resolve')
      .set('x-user-session-token', 'v2-session')
      .send({
        requiredCapability: 'host.read',
        resource: {
          environmentId: 'development:local-cluster',
          type: 'host',
          logicalId: 'mcp-host/example',
        },
      })
    expect(resolution.status).toBe(409)
  })

  it('rejects a caller-selected foreign environment before resolving authority', async () => {
    token.verify.mockReturnValue({
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.com',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
      sessionContract: 'v2',
      sid: '00000000-0000-4000-8000-000000000100',
      jti: '00000000-0000-4000-8000-000000000200',
      sv: 1,
      authTime: 1_999_996_400,
      amr: ['pwd'],
      iat: 1_999_996_400,
    })

    const response = await request(app())
      .post('/external/access/resolve')
      .set('x-user-session-token', 'legacy-session')
      .send({
        requiredCapability: 'host.read',
        resource: {
          environmentId: 'production:foreign-cluster',
          type: 'host',
          logicalId: 'mcp-host/agent-a',
        },
      })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('invalid_request')
  })

  it('returns a sanitized invalid request for metacharacters in a resource type', async () => {
    token.verify.mockReturnValue({
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.com',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
      sessionContract: 'v2',
      sid: '00000000-0000-4000-8000-000000000100',
      jti: '00000000-0000-4000-8000-000000000200',
      sv: 1,
      authTime: 1_999_996_400,
      amr: ['pwd'],
      iat: 1_999_996_400,
    })

    const response = await request(app())
      .post('/external/access/resolve')
      .set('x-user-session-token', 'legacy-session')
      .send({
        requiredCapability: 'host.read',
        resource: {
          environmentId: 'development:local-cluster',
          type: '[',
          id: 'host:mcp-host/agent-a',
        },
      })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('invalid_request')
  })

  it('rate limits authenticated catalog fan-out with the public error contract', async () => {
    token.verify.mockReturnValue({
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.com',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
      sessionContract: 'v2',
      sid: '00000000-0000-4000-8000-000000000100',
      jti: '00000000-0000-4000-8000-000000000200',
      sv: 1,
      authTime: 1_999_996_400,
      amr: ['pwd'],
      iat: 1_999_996_400,
    })
    rateLimits.check.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 30_000,
      count: 11,
    })

    const response = await request(app())
      .get('/external/access/catalog')
      .set('x-user-session-token', 'v2-session')

    expect(response.status).toBe(429)
    expect(response.body.error).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      details: { retryAfterSeconds: expect.any(Number) },
    })
  })

  it('rate limits live resolution before any operational gateway fan-out', async () => {
    token.verify.mockReturnValue({
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.com',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
      sessionContract: 'v2',
      sid: '00000000-0000-4000-8000-000000000100',
      jti: '00000000-0000-4000-8000-000000000200',
      sv: 1,
      authTime: 1_999_996_400,
      amr: ['pwd'],
      iat: 1_999_996_400,
    })
    rateLimits.check.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 30_000,
      count: 11,
    })
    const gateway = { getResource: vi.fn(), listResource: vi.fn() }

    const response = await request(app(gateway))
      .post('/external/access/resolve')
      .set('x-user-session-token', 'v2-session')
      .send({
        requiredCapability: 'mcp_server.read',
        resource: {
          environmentId: 'development:local-cluster',
          type: 'mcp_server',
          logicalId: 'mcp-server/example',
        },
      })

    expect(response.status).toBe(429)
    expect(response.body.error).toMatchObject({ code: 'rate_limited', retryable: true })
    expect(gateway.getResource).not.toHaveBeenCalled()
    expect(gateway.listResource).not.toHaveBeenCalled()
  })

  it('rejects nested and capability-inapplicable operation targets before resolution', async () => {
    token.verify.mockReturnValue({
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.com',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
      sessionContract: 'v2',
      sid: '00000000-0000-4000-8000-000000000100',
      jti: '00000000-0000-4000-8000-000000000200',
      sv: 1,
      authTime: 1_999_996_400,
      amr: ['pwd'],
      iat: 1_999_996_400,
    })
    const gateway = { getResource: vi.fn(), listResource: vi.fn() }

    for (const operationTarget of [
      { teamId: { nested: 'team-a' } },
      { teamId: 'team-a', role: 'admin' },
      { teamId: 'x'.repeat(129) },
    ]) {
      const response = await request(app(gateway))
        .post('/external/access/resolve')
        .set('x-user-session-token', 'v2-session')
        .send({
          requiredCapability: 'host.read',
          resource: {
            environmentId: 'development:local-cluster',
            type: 'host',
            logicalId: 'mcp-host/example',
          },
          operationTarget,
        })
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('invalid_request')
    }
    expect(gateway.getResource).not.toHaveBeenCalled()
    expect(gateway.listResource).not.toHaveBeenCalled()
  })

  it('rejects oversized resolver identity and path fields before gateway work', async () => {
    token.verify.mockReturnValue({
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.com',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
      sessionContract: 'v2',
      sid: '00000000-0000-4000-8000-000000000100',
      jti: '00000000-0000-4000-8000-000000000200',
      sv: 1,
      authTime: 1_999_996_400,
      amr: ['pwd'],
      iat: 1_999_996_400,
    })
    const gateway = { getResource: vi.fn(), listResource: vi.fn() }

    for (const body of [
      {
        requiredCapability: 'host.read',
        resource: {
          environmentId: 'development:local-cluster',
          type: 'host',
          logicalId: `mcp-host/${'x'.repeat(513)}`,
        },
      },
      {
        requiredCapability: 'host.read',
        resource: {
          environmentId: 'development:local-cluster',
          type: 'host',
          logicalId: 'mcp-host/example',
        },
        accessPathId: `ap1_${'x'.repeat(44)}`,
      },
    ]) {
      const response = await request(app(gateway))
        .post('/external/access/resolve')
        .set('x-user-session-token', 'v2-session')
        .send(body)
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('invalid_request')
    }
    expect(gateway.getResource).not.toHaveBeenCalled()
    expect(gateway.listResource).not.toHaveBeenCalled()
  })
})
