import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import {
  MCP_HOST_CREDENTIAL_CAPABILITY,
  MCP_HOST_HCC_AUDIENCE,
  MCP_HOST_WORKFLOW_AUDIENCE,
  issueMcpHostAccessJwt,
} from '../src/utils/auth/mcpHostJwtToken.js'
import { MockGateway } from './mockGateway.js'

// Preserve the real mcpHostJwtToken helpers — we want the full RS256 sign
// + verify path exercised end-to-end. The route-level test that cares about
// mocking consumption is routes.mcpHost.test.ts; this file is
// specifically about /workflow-auth/reissue behaviour under realistic
// crypto, rate-limit, and race conditions.
vi.mock('../src/utils/auth/mcpHostJwtToken.js', async () =>
  vi.importActual<typeof import('../src/utils/auth/mcpHostJwtToken.js')>(
    '../src/utils/auth/mcpHostJwtToken.js'
  )
)
vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

// The handler hits the DB for two things:
//   1. rate_limit_buckets INSERT ... RETURNING count (rate limiter)
//   2. workflow_revoked_refresh_jtis SELECT / INSERT (revocation + consume)
// A single mock dispatches on SQL fragment so tests can choreograph both
// paths independently.
const rateLimitCounts = new Map<string, number>()
const revokedJtis = new Set<string>()
const consumedJtis = new Set<string>()
const conflictOnInsertJtis = new Set<string>()
let throwOnConsumeInsert = false

const mockPoolQuery = vi.fn(async (sql: unknown, params?: unknown[]) => {
  const text = typeof sql === 'string' ? sql : ''
  if (/rate_limit_buckets/i.test(text)) {
    const bucketKey = Array.isArray(params) && typeof params[0] === 'string' ? params[0] : 'unknown'
    const windowStart = Array.isArray(params) && typeof params[1] === 'number' ? params[1] : 0
    const key = `${bucketKey}|${windowStart}`
    const next = (rateLimitCounts.get(key) ?? 0) + 1
    rateLimitCounts.set(key, next)
    return { rows: [{ count: next }], rowCount: 1 }
  }
  if (/SELECT 1 FROM workflow_revoked_refresh_jtis/i.test(text)) {
    const jti = Array.isArray(params) && typeof params[0] === 'string' ? params[0] : ''
    return {
      rows: revokedJtis.has(jti) || consumedJtis.has(jti) ? [{ '?column?': 1 }] : [],
      rowCount: revokedJtis.has(jti) || consumedJtis.has(jti) ? 1 : 0,
    }
  }
  if (/INSERT INTO workflow_revoked_refresh_jtis/i.test(text)) {
    if (throwOnConsumeInsert) {
      throwOnConsumeInsert = false
      throw new Error('consume failed')
    }
    const jti = Array.isArray(params) && typeof params[0] === 'string' ? params[0] : ''
    if (conflictOnInsertJtis.has(jti)) {
      return { rows: [], rowCount: 0 }
    }
    if (consumedJtis.has(jti) || revokedJtis.has(jti)) {
      // ON CONFLICT DO NOTHING — rowCount 0 means race lost / already revoked.
      return { rows: [], rowCount: 0 }
    }
    consumedJtis.add(jti)
    return { rows: [{ jti }], rowCount: 1 }
  }
  return { rows: [], rowCount: 0 }
})

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(args[0], args[1] as unknown[] | undefined),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

const NS = 'sandbox-recipes'
const RECIPE = 'test-recipe'
const HOST_NS = 'mcp-host'
const STANDALONE_RECIPE = 'standalone'
const HOST_REF = 'chatllm'

function issueExpiredRefreshToken(
  ns = NS,
  recipe = RECIPE,
  expiredSeconds = 60,
  hostRefs = [`${ns}/${recipe}`],
  workflowControlScopes = ['workflow:list', 'workflow:read'],
  hccCredential?: { hostUid: string }
): string {
  // Use the real private key but override expiresIn to a past timestamp via
  // the `exp` claim directly. `jwt.sign` with a numeric `exp` bypasses the
  // expiresIn option and writes the payload verbatim.
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign(
    {
      sub: `${ns}/${recipe}`,
      recipeNamespace: ns,
      recipeName: recipe,
      hostRefs,
      scope: 'workflow:approval:refresh',
      workflowControlScopes,
      ...(hccCredential
        ? {
            host_uid: hccCredential.hostUid,
            mcpCapabilities: [MCP_HOST_CREDENTIAL_CAPABILITY],
          }
        : {}),
      exp: now - expiredSeconds,
    },
    config.adminJwtPrivateKey,
    {
      algorithm: 'RS256',
      issuer: config.adminJwtIssuer,
      audience: hccCredential
        ? [MCP_HOST_WORKFLOW_AUDIENCE, MCP_HOST_HCC_AUDIENCE]
        : MCP_HOST_WORKFLOW_AUDIENCE,
      jwtid: `jti-expired-${Math.random().toString(36).slice(2)}`,
    }
  )
}

describe('POST /api/v1/workflow-auth/reissue', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    rateLimitCounts.clear()
    revokedJtis.clear()
    consumedJtis.clear()
    conflictOnInsertJtis.clear()
    throwOnConsumeInsert = false
    app = createApp(new MockGateway('mcp-server') as never)
  })

  it('mints a fresh pair for a valid-but-expired refresh token', async () => {
    const token = issueExpiredRefreshToken()
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipe_name: RECIPE })

    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeTypeOf('string')
    expect(res.body.refreshToken).toBeTypeOf('string')
    expect(res.body.mcpHostControlToken).toBeTypeOf('string')
    expect(res.body.controlExpiresInSeconds).toBeGreaterThan(0)
    expect(res.body.expiresInSeconds).toBeGreaterThan(0)
    expect(res.body.accessToken).not.toBe(token)
    expect(res.body.refreshToken).not.toBe(token)
    const control = jwt.decode(res.body.mcpHostControlToken) as { scopes?: string[] }
    expect(control.scopes).toEqual(['workflow:list', 'workflow:read'])
  })

  it('also accepts camelCase recipeName field for JSON idiom parity', async () => {
    const token = issueExpiredRefreshToken()
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipeName: RECIPE })
    expect(res.status).toBe(200)
  })

  it('mints a fresh pair for an HCC standalone host using host_ref binding', async () => {
    const token = issueExpiredRefreshToken(HOST_NS, STANDALONE_RECIPE, 60, [HOST_REF])
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ host_ref: HOST_REF })

    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeTypeOf('string')
    expect(res.body.refreshToken).toBeTypeOf('string')
    const decoded = jwt.decode(res.body.accessToken) as { hostRefs?: string[]; recipeName?: string }
    expect(decoded.hostRefs?.[0]).toBe(HOST_REF)
    expect(decoded.recipeName).toBe(STANDALONE_RECIPE)
  })

  it('also accepts camelCase hostRef field for HCC standalone reissue', async () => {
    const token = issueExpiredRefreshToken(HOST_NS, STANDALONE_RECIPE, 60, [HOST_REF])
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ hostRef: HOST_REF })

    expect(res.status).toBe(200)
  })

  it('preserves HCC audience, Host UID, and capability through bounded reissue', async () => {
    const token = issueExpiredRefreshToken(
      HOST_NS,
      STANDALONE_RECIPE,
      60,
      [HOST_REF],
      ['workflow:list'],
      { hostUid: 'signed-host-uid' }
    )
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({
        host_ref: HOST_REF,
        hostUid: 'body-controlled-uid',
        mcpCapabilities: [],
      })

    expect(res.status).toBe(200)
    for (const encoded of [res.body.accessToken, res.body.refreshToken]) {
      const claims = jwt.decode(encoded) as Record<string, unknown>
      expect(claims.aud).toEqual([MCP_HOST_WORKFLOW_AUDIENCE, MCP_HOST_HCC_AUDIENCE])
      expect(claims.host_uid).toBe('signed-host-uid')
      expect(claims.mcpCapabilities).toEqual([MCP_HOST_CREDENTIAL_CAPABILITY])
    }
  })

  it('returns 401 when the Authorization header is missing', async () => {
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .send({ recipe_name: RECIPE })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })

  it('returns 401 when the JWT signature is invalid (tampered)', async () => {
    // Tamper the signature segment of a real token so RS256 verify fails.
    const realToken = issueExpiredRefreshToken()
    const tampered = realToken.slice(0, -10) + 'xxxxxxxxxx'

    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${tampered}`)
      .send({ recipe_name: RECIPE })
    expect(res.status).toBe(401)
  })

  it('returns 401 when the expired refresh token is outside the reissue grace window', async () => {
    const token = issueExpiredRefreshToken(NS, RECIPE, 6 * 60)
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipe_name: RECIPE })

    expect(res.status).toBe(401)
  })

  it('returns 401 when an access token (wrong scope) is presented', async () => {
    // Access tokens have scope "workflow:approval:request" — the reissue
    // route rejects anything other than "workflow:approval:refresh".
    const accessToken = issueMcpHostAccessJwt(NS, RECIPE).token
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ recipe_name: RECIPE })
    expect(res.status).toBe(401)
  })

  it('returns 401 when the jti is already revoked', async () => {
    const token = issueExpiredRefreshToken()
    // Extract jti and pre-seed the revocation table.
    const decoded = jwt.decode(token) as { jti: string }
    revokedJtis.add(decoded.jti)

    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipe_name: RECIPE })
    expect(res.status).toBe(401)
  })

  it('returns 401 when another worker already consumed the expired refresh jti', async () => {
    const token = issueExpiredRefreshToken()
    const decoded = jwt.decode(token) as { jti: string }
    consumedJtis.add(decoded.jti)

    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipe_name: RECIPE })

    expect(res.status).toBe(401)
  })

  it('returns 401 when body.recipe_name does not match the JWT sub', async () => {
    const token = issueExpiredRefreshToken()
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipe_name: 'different-recipe' })
    expect(res.status).toBe(401)
  })

  it('returns 401 when HCC standalone host_ref does not match hostRefs[0]', async () => {
    const token = issueExpiredRefreshToken(HOST_NS, STANDALONE_RECIPE, 60, [HOST_REF])
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ host_ref: 'other-host' })

    expect(res.status).toBe(401)
  })

  it('returns 401 when the consume insert loses a concurrent conflict', async () => {
    const token = issueExpiredRefreshToken()
    const decoded = jwt.decode(token) as { jti: string }
    conflictOnInsertJtis.add(decoded.jti)

    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipe_name: RECIPE })

    expect(res.status).toBe(401)
  })

  it('returns 401 when the body is missing recipe_name', async () => {
    const token = issueExpiredRefreshToken()
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(401)
  })

  it('returns 401 when HCC standalone body is missing host_ref', async () => {
    const token = issueExpiredRefreshToken(HOST_NS, STANDALONE_RECIPE, 60, [HOST_REF])
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(res.status).toBe(401)
  })

  it('returns 401 when the refresh token namespace is unsupported for reissue', async () => {
    const token = issueExpiredRefreshToken('rpc-proxy', 'standalone', 60, ['rpc-proxy/standalone'])
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipe_name: 'standalone' })

    expect(res.status).toBe(401)
  })

  it('returns 401 when the request has no JSON body', async () => {
    const token = issueExpiredRefreshToken()
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send()
    expect(res.status).toBe(401)
  })

  it('consumes the jti — a second reissue with the same token fails', async () => {
    const token = issueExpiredRefreshToken()
    const first = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipe_name: RECIPE })
    expect(first.status).toBe(200)

    const second = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipe_name: RECIPE })
    expect(second.status).toBe(401)
  })

  it('propagates refresh-jti consume failures to the error handler', async () => {
    const token = issueExpiredRefreshToken()
    throwOnConsumeInsert = true

    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipe_name: RECIPE })

    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal Server Error')
  })

  it('rate-limits by jti: bursts over approvalRlReissuePerMin return 429', async () => {
    const limit = config.approvalRlReissuePerMin
    // Note: each reissue needs a DIFFERENT token (jti is single-use), so the
    // rate limiter bucket is keyed on (namespace/recipe) NOT per-jti — we
    // re-read the middleware to confirm. Actually per the route config the
    // bucket key is `reissue:${recipeNamespace}/${recipeName}` because
    // getMcpHostRefreshRateLimitKey returns ns/recipe (not jti).
    //
    // So: limit+1 calls with DIFFERENT tokens for the SAME recipe should
    // trip the limiter on the (limit+1)-th call.
    for (let i = 0; i < limit; i++) {
      const token = issueExpiredRefreshToken()
      const res = await request(app)
        .post('/api/v1/workflow-auth/reissue')
        .set('Authorization', `Bearer ${token}`)
        .send({ recipe_name: RECIPE })
      expect(res.status).toBe(200)
    }

    const overflowToken = issueExpiredRefreshToken()
    const limited = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${overflowToken}`)
      .send({ recipe_name: RECIPE })
    expect(limited.status).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
  })

  it('does not let forged expired refresh claims poison the reissue rate-limit bucket', async () => {
    const now = Math.floor(Date.now() / 1000)
    const forged = jwt.sign(
      {
        sub: `${NS}/${RECIPE}`,
        recipeNamespace: NS,
        recipeName: RECIPE,
        hostRefs: [`${NS}/${RECIPE}`],
        scope: 'workflow:approval:refresh',
        exp: now - 60,
      },
      'attacker-controlled-secret',
      {
        algorithm: 'HS256',
        issuer: config.adminJwtIssuer,
        audience: 'workflow-approvals',
        jwtid: 'forged-expired-refresh-jti',
      }
    )

    for (let i = 0; i < config.approvalRlReissuePerMin + 1; i++) {
      const res = await request(app)
        .post('/api/v1/workflow-auth/reissue')
        .set('Authorization', `Bearer ${forged}`)
        .send({ recipe_name: RECIPE })
      expect(res.status).toBe(401)
    }

    const validExpired = issueExpiredRefreshToken()
    const valid = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${validExpired}`)
      .send({ recipe_name: RECIPE })

    expect(valid.status).toBe(200)
  })
})
