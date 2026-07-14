import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { issueMcpHostRefreshJwt } from '../src/utils/auth/mcpHostJwtToken.js'
import { MockGateway } from './mockGateway.js'

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

// DB pool is now called for TWO things by the refresh endpoint:
//   1. rate_limit_buckets INSERT ... RETURNING count  (rate limiter middleware)
//   2. workflow_revoked_refresh_jtis INSERT            (JTI consumption)
// The mock dispatches on SQL fragment so each call returns the right shape.
const rateLimitCounts = new Map<string, number>()
const consumedJtis = new Set<string>()
const mockPoolQuery = vi.fn(async (sql: unknown, params?: unknown[]) => {
  const text = typeof sql === 'string' ? sql : ''
  if (/rate_limit_buckets/i.test(text)) {
    // Key on (bucketKey, windowStartMs) to match the real PG unique index.
    // Without the windowStartMs, rollover tests can't observe a fresh window.
    const bucketKey = Array.isArray(params) && typeof params[0] === 'string' ? params[0] : 'unknown'
    const windowStart = Array.isArray(params) && typeof params[1] === 'number' ? params[1] : 0
    const key = `${bucketKey}|${windowStart}`
    const next = (rateLimitCounts.get(key) ?? 0) + 1
    rateLimitCounts.set(key, next)
    return { rows: [{ count: next }], rowCount: 1 }
  }
  if (/workflow_revoked_refresh_jtis/i.test(text)) {
    const jti =
      Array.isArray(params) && typeof params[0] === 'string'
        ? params[0]
        : `unknown-${mockPoolQuery.mock.calls.length}`
    if (consumedJtis.has(jti)) {
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

describe('Workflow approval refresh rate limit', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    rateLimitCounts.clear()
    consumedJtis.clear()
    app = createApp(new MockGateway('mcp-server') as never)
  })

  it('does not consume a refresh token when the request is rate limited', async () => {
    const limit = config.approvalRlRefreshPerMin
    // Warm up exactly `limit` calls with unique refresh tokens — all should 200.
    for (let i = 0; i < limit; i++) {
      const { token } = issueMcpHostRefreshJwt('ns', 'recipe')
      const res = await request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${token}`)
        .send()
      expect(res.status).toBe(200)
    }

    // (limit+1)-th call with a fresh probe token → rate limit middleware rejects
    // BEFORE the JTI consumption query runs.
    const { token: probeToken } = issueMcpHostRefreshJwt('ns', 'recipe')
    const rateLimited = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${probeToken}`)
      .send()
    expect(rateLimited.status).toBe(429)

    // Rollover the 60s window so the limiter grants a fresh slot. The
    // rateLimiterService uses `Date.now()` internally — spy on it so we don't
    // actually wait a minute in the test.
    const baseNow = Date.now()
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(baseNow + 60_001)

    try {
      const retried = await request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${probeToken}`)
        .send()
      expect(retried.status).toBe(200)
      expect(retried.body.refreshToken).toBeDefined()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('does not let unsigned refresh claims poison a recipe rate-limit bucket', async () => {
    const forged = jwt.sign(
      {
        sub: 'ns/recipe',
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        hostRefs: ['ns/recipe'],
        scope: 'workflow:approval:refresh',
      },
      'attacker-controlled-secret',
      {
        algorithm: 'HS256',
        issuer: config.adminJwtIssuer,
        audience: 'workflow-approvals',
        expiresIn: 300,
        jwtid: 'forged-refresh-jti',
      }
    )

    for (let i = 0; i < config.approvalRlRefreshPerMin + 1; i++) {
      const res = await request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${forged}`)
        .send()
      expect(res.status).toBe(401)
    }

    const { token } = issueMcpHostRefreshJwt('ns', 'recipe')
    const valid = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .send()

    expect(valid.status).toBe(200)
  })
})
