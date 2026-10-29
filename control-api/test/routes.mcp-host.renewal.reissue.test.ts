import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { mcpHostJwtReissueTotal } from '../src/observability/metrics.js'
import {
  MCP_HOST_CREDENTIAL_CAPABILITY,
  MCP_HOST_HCC_AUDIENCE,
  MCP_HOST_WORKFLOW_AUDIENCE,
  type McpHostControlScope,
  issueMcpHostAccessJwt,
  issueMcpHostRefreshJwt,
  verifyMcpHostControlJwt,
} from '../src/utils/auth/mcpHostJwtToken.js'
import { captureRequestLogs } from './helpers/requestLogCapture.js'
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
  rateLimitPool: {
    query: (...args: unknown[]) => mockPoolQuery(args[0], args[1] as unknown[] | undefined),
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

/**
 * Mint an already-expired refresh token through the real producer by moving
 * the signing clock back past the refresh TTL.
 */
async function reissueCount(result: string): Promise<number> {
  const metric = await mcpHostJwtReissueTotal.get()
  return metric.values.find(v => v.labels.result === result)?.value ?? 0
}

function issueExpiredRefreshFromProducer(
  ns: string,
  recipe: string,
  hostRefs: string[] | undefined,
  options: Parameters<typeof issueMcpHostRefreshJwt>[3],
  expiredSeconds = 60
): string {
  const realNow = Date.now()
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(realNow - (config.mcpHostJwtRefreshTtlSec + expiredSeconds) * 1000)
  try {
    return issueMcpHostRefreshJwt(ns, recipe, hostRefs, options).token
  } finally {
    clock.mockRestore()
  }
}

describe('POST /api/v1/workflow-auth/reissue', () => {
  let app: ReturnType<typeof createApp>
  let gateway: MockGateway

  afterEach(() => vi.restoreAllMocks())

  beforeEach(() => {
    vi.clearAllMocks()
    rateLimitCounts.clear()
    revokedJtis.clear()
    consumedJtis.clear()
    conflictOnInsertJtis.clear()
    throwOnConsumeInsert = false
    gateway = new MockGateway('mcp-server')
    app = createApp(gateway as never)
  })

  async function seedHost(name = HOST_REF): Promise<string> {
    const created = (await gateway.createResource(
      'hosts',
      { metadata: { name }, spec: { host: name, contextRef: 'ctx-a', secretRef: `${name}-llm` } },
      config.hostsNamespace
    )) as { metadata: { uid: string } }
    return created.metadata.uid
  }

  function issueExpiredHccRefresh(
    hostUid: string,
    workflowControlScopes: McpHostControlScope[] = ['workflow:list']
  ): string {
    return issueExpiredRefreshFromProducer(HOST_NS, STANDALONE_RECIPE, [HOST_REF], {
      workflowControlScopes,
      hccCredential: { hostUid },
    })
  }

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
    const hostUid = await seedHost()
    const token = issueExpiredHccRefresh(hostUid)
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
    const hostUid = await seedHost()
    const token = issueExpiredHccRefresh(hostUid)
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ hostRef: HOST_REF })

    expect(res.status).toBe(200)
  })

  it('F2e: rejects a hosts-namespace standalone refresh that lacks the HCC audience', async () => {
    await seedHost()
    // Pre-host_uid chain shape: the producer still emits it without an HCC credential.
    const token = issueExpiredRefreshFromProducer(HOST_NS, STANDALONE_RECIPE, [HOST_REF], {
      workflowControlScopes: ['workflow:list'],
    })
    const lineageBefore = await reissueCount('lineage_without_audience')
    const mismatchBefore = await reissueCount('host_mismatch')
    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ host_ref: HOST_REF })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
    expect(consumedJtis.size).toBe(0)
    expect(await reissueCount('lineage_without_audience')).toBe(lineageBefore + 1)
    expect(await reissueCount('host_mismatch')).toBe(mismatchBefore)
  })

  it('preserves HCC audience, Host UID, and capability through bounded reissue (F2b)', async () => {
    const hostUid = await seedHost()
    const token = issueExpiredHccRefresh(hostUid)
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
      expect(claims.host_uid).toBe(hostUid)
      expect(claims.mcpCapabilities).toEqual([MCP_HOST_CREDENTIAL_CAPABILITY])
    }
    const control = jwt.decode(res.body.mcpHostControlToken) as Record<string, unknown>
    expect(control.host_uid).toBe(hostUid)
    expect(control.mcpCapabilities).toBeUndefined()
    expect(verifyMcpHostControlJwt(res.body.mcpHostControlToken)?.host_uid).toBe(hostUid)
  })

  it('F2c: rejects an HCC reissue whose Host no longer exists, without consuming the jti', async () => {
    const hostUid = await seedHost()
    const token = issueExpiredHccRefresh(hostUid)
    await gateway.deleteResource('hosts', HOST_REF, config.hostsNamespace)
    const mismatchBefore = await reissueCount('host_mismatch')

    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ host_ref: HOST_REF })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
    expect(consumedJtis.size).toBe(0)
    expect(await reissueCount('host_mismatch')).toBe(mismatchBefore + 1)
  })

  it('F2c: rejects an HCC reissue after the Host was recreated under the same name', async () => {
    const oldUid = await seedHost()
    const token = issueExpiredHccRefresh(oldUid)
    await gateway.deleteResource('hosts', HOST_REF, config.hostsNamespace)
    expect(await seedHost()).not.toBe(oldUid)

    const res = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ host_ref: HOST_REF })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('answers 503 on a transient Host read error and leaves the expired refresh reusable', async () => {
    const hostUid = await seedHost()
    const token = issueExpiredHccRefresh(hostUid)
    gateway.failGetResource(
      'hosts',
      Object.assign(new Error('apiserver down'), { statusCode: 503 })
    )

    const failed = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ host_ref: HOST_REF })
    expect(failed.status).toBe(503)
    expect(failed.body).toEqual({ error: 'host_state_unavailable' })
    expect(consumedJtis.size).toBe(0)

    const retried = await request(app)
      .post('/api/v1/workflow-auth/reissue')
      .set('Authorization', `Bearer ${token}`)
      .send({ host_ref: HOST_REF })
    expect(retried.status).toBe(200)
  })

  it('E2: strips oauth:user-token from the control token of a reissued WRC chain and logs it', async () => {
    const token = issueExpiredRefreshFromProducer(NS, RECIPE, undefined, {
      workflowControlScopes: ['workflow:list', 'oauth:user-token'],
    })
    const logs = captureRequestLogs()
    let res: request.Response
    try {
      res = await request(app)
        .post('/api/v1/workflow-auth/reissue')
        .set('Authorization', `Bearer ${token}`)
        .send({ recipe_name: RECIPE })
    } finally {
      logs.restore()
    }

    expect(res.status).toBe(200)
    expect(verifyMcpHostControlJwt(res.body.mcpHostControlToken)?.scopes).toEqual(['workflow:list'])
    for (const encoded of [res.body.accessToken, res.body.refreshToken]) {
      const claims = jwt.decode(encoded) as Record<string, unknown>
      expect(claims.workflowControlScopes).toEqual(['workflow:list', 'oauth:user-token'])
    }
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'oauth_user_token_scope_stripped', route: 'reissue' }),
      expect.any(String)
    )
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

  it.each([
    { offsetMs: 10_000, retryAfter: '50' },
    { offsetMs: 59_999, retryAfter: '1' },
  ])(
    'rate-limits a recipe within one window at offset $offsetMs ms',
    async ({ offsetMs, retryAfter }) => {
      const limit = config.approvalRlReissuePerMin
      // Every request must stay in one fixed window, even at its final millisecond.
      // Keep real timers/HTTP and the actual RS256 sign/verify path running.
      const baseNow = Math.floor(Date.now() / 60_000) * 60_000 + offsetMs
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow)
      // JTIs are single-use; distinct tokens still share the namespace/recipe quota.
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
      expect(limited.headers['retry-after']).toBe(retryAfter)
      expect(limited.headers['x-ratelimit-remaining']).toBe('0')
      expect(limited.body.code).toBe('rate_limited')

      // Denial must not consume the token: the same token works in the next window.
      nowSpy.mockReturnValue(baseNow + 60_000)
      const retried = await request(app)
        .post('/api/v1/workflow-auth/reissue')
        .set('Authorization', `Bearer ${overflowToken}`)
        .send({ recipe_name: RECIPE })
      expect(retried.status).toBe(200)
      expect(retried.body.refreshToken).toBeTypeOf('string')

      const replayed = await request(app)
        .post('/api/v1/workflow-auth/reissue')
        .set('Authorization', `Bearer ${overflowToken}`)
        .send({ recipe_name: RECIPE })
      expect(replayed.status).toBe(401)
    }
  )

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
