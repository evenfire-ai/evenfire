import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalAccessRouter } from '../src/routes/external/access.js'

const token = vi.hoisted(() => ({ verify: vi.fn() }))
const sessions = vi.hoisted(() => ({ validate: vi.fn() }))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: token.verify,
}))
vi.mock('../src/services/auth/userSessionService.js', () => ({
  validateUserSessionClaims: sessions.validate,
}))

function app() {
  const value = express()
  value.use(express.json())
  value.use(createExternalAccessRouter({} as never))
  return value
}

describe('external aggregate access routes', () => {
  beforeEach(() => {
    token.verify.mockReset()
    sessions.validate.mockReset()
    sessions.validate.mockResolvedValue({
      status: 'valid',
      identity: {
        email: 'user@example.com',
        jti: '00000000-0000-4000-8000-000000000200',
        sessionVersion: 1,
      },
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
      aggregateCatalog: { shadow: false, served: false, contractVersion: '2' },
      actionContext: { v2: false },
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
})
