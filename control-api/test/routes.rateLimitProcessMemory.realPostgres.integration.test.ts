import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'

// rateLimitMiddleware's 'process-memory' mode against real PostgreSQL: with
// every limiter pool connection held, a real route's limiter cannot count in
// Postgres and counts in process memory instead. Requests go through the
// production Express app; the ONLY mock is the session-token verifier
// (identity), as in routes.externalGfsRateLimitFailClosed. Skipped without
// CONTROL_API_REAL_PG_ADMIN_URL.
//
// The limiter pool is small with a short acquire timeout, and the external
// per-operation limit is low, so each held-pool request waits 200 ms instead
// of the production 5 s and the suite needs four of them, not sixty-one.

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  // A token that is not a JSON identity fails verification, as a bad
  // signature does in production.
  verifyExternalSessionToken: (token: string) => {
    if (!token.startsWith('{')) return null
    const parsed = JSON.parse(token) as { userId: string }
    return {
      userId: parsed.userId,
      email: `${parsed.userId}@example.test`,
      teamId: null,
      role: 'member',
      authGeneration: 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }
  },
}))

const LIMITER_POOL_MAX = 2
const LIMITER_ACQUIRE_TIMEOUT_MS = 200
const EXTERNAL_PER_MIN = 3

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('rateLimitMiddleware process-memory mode (real PostgreSQL)', () => {
  const database = `control_api_rl_process_memory_${randomBytes(6).toString('hex')}`
  const envKeys = [
    'CONTROL_API_PG_CONNECTION_STRING',
    'CORE_POOL_MAX',
    'CORE_POOL_CONNECTION_TIMEOUT_MS',
    'CORE_POOL_STATEMENT_TIMEOUT_MS',
    'RATE_LIMIT_POOL_MAX',
    'RATE_LIMIT_POOL_CONNECTION_TIMEOUT_MS',
    'RATE_LIMIT_POOL_STATEMENT_TIMEOUT_MS',
    'APPROVAL_RL_EXTERNAL_PER_MIN',
  ] as const
  const previousEnv = new Map<string, string | undefined>()

  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  let mod: {
    createApp: (gateway: unknown) => import('express').Express
    config: typeof import('../src/config.js').config
    hitsTotal: typeof import('../src/observability/metrics.js').rateLimitHitsTotal
    MockGateway: typeof import('./mockGateway.js').MockGateway
  }

  beforeAll(async () => {
    if (adminUrl === undefined) {
      throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required by this suite')
    }
    const connectionString = databaseUrl(adminUrl, database)
    for (const key of envKeys) {
      previousEnv.set(key, process.env[key])
      delete process.env[key]
    }
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString
    process.env.RATE_LIMIT_POOL_MAX = String(LIMITER_POOL_MAX)
    process.env.RATE_LIMIT_POOL_CONNECTION_TIMEOUT_MS = String(LIMITER_ACQUIRE_TIMEOUT_MS)
    process.env.APPROVAL_RL_EXTERNAL_PER_MIN = String(EXTERNAL_PER_MIN)

    const dbMod = await import('../src/db.js')
    corePool = dbMod.pool as unknown as Pool
    corePool.on('error', () => {})
    limiterPool = dbMod.rateLimitPool as unknown as Pool
    limiterPool.on('error', () => {})
    const migratePool = new Pool({ connectionString })
    await dbMod.initDb({ connect: () => migratePool.connect() })
    await migratePool.end()

    const appMod = await import('../src/app.js')
    const configMod = await import('../src/config.js')
    const metricsMod = await import('../src/observability/metrics.js')
    const { MockGateway } = await import('./mockGateway.js')
    mod = {
      createApp: appMod.createApp as never,
      config: configMod.config,
      hitsTotal: metricsMod.rateLimitHitsTotal,
      MockGateway,
    }
  }, 60_000)

  afterAll(async () => {
    for (const key of envKeys) {
      const value = previousEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await corePool?.end().catch(() => {})
    await limiterPool?.end().catch(() => {})
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  async function seedUser(): Promise<string> {
    const id = randomUUID()
    await corePool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      id,
      `${id}@example.test`,
      'process-memory',
    ])
    return id
  }

  async function ack(app: import('express').Express, userId: string) {
    const internalToken = mod.config.internalServiceTokens['external-rest-api']
    if (!internalToken) throw new Error('config has no external-rest-api internal service token')
    return request(app)
      .post(`/api/v1/external/notifications/${randomUUID()}/ack`)
      .set('Authorization', `Bearer ${internalToken}`)
      .set('x-service-token', 'external-rest-api')
      .set('x-user-session-token', JSON.stringify({ userId }))
      .set('x-forwarded-for', '203.0.113.7')
  }

  async function externalUserHits(): Promise<Record<string, number>> {
    const { values } = await mod.hitsTotal.get()
    const totals: Record<string, number> = {}
    for (const sample of values) {
      if (sample.labels.bucket_type !== 'external_user') continue
      const result = String(sample.labels.result)
      totals[result] = (totals[result] ?? 0) + sample.value
    }
    return totals
  }

  function delta(after: Record<string, number>, before: Record<string, number>, result: string) {
    return (after[result] ?? 0) - (before[result] ?? 0)
  }

  /** Read through the core pool: the limiter pool is the one being held. */
  async function ledgerCount(bucketKey: string): Promise<number | null> {
    const result = await corePool.query<{ count: number }>(
      'SELECT count FROM rate_limit_buckets WHERE bucket_key = $1',
      [bucketKey]
    )
    return result.rows[0]?.count ?? null
  }

  it('T5: with every limiter connection held, the ack route admits max requests from process memory and answers 429 to the next; after release Postgres decides again', async () => {
    expect(mod.config.approvalRlExternalPerMin).toBe(EXTERNAL_PER_MIN)
    const app = mod.createApp(new mod.MockGateway())
    const userId = await seedUser()
    const bucketKey = `user:${userId}:notification-ack`
    await corePool.query('DELETE FROM rate_limit_buckets')
    const hitsBefore = await externalUserHits()

    const held: PoolClient[] = []
    const responses: request.Response[] = []
    try {
      for (let index = 0; index < LIMITER_POOL_MAX; index += 1) {
        held.push(await limiterPool.connect())
      }
      // Witness: the pool is exhausted, not merely busy.
      expect(limiterPool.totalCount).toBe(LIMITER_POOL_MAX)
      expect(limiterPool.idleCount).toBe(0)

      for (let n = 0; n <= EXTERNAL_PER_MIN; n += 1) responses.push(await ack(app, userId))
    } finally {
      for (const client of held) client.release()
    }

    // The handler ran for the first max requests: an unknown id is a 404.
    for (const admitted of responses.slice(0, EXTERNAL_PER_MIN)) {
      expect(admitted.status).toBe(404)
      expect(admitted.body).toEqual({ error: 'notification_not_found' })
    }
    const denied = responses[EXTERNAL_PER_MIN]!
    expect(denied.status).toBe(429)
    const retryAfterSeconds = Number(denied.headers['retry-after'])
    expect(retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(retryAfterSeconds).toBeLessThanOrEqual(60)
    expect(denied.body).toEqual({ error: 'Too Many Requests', retryAfterSeconds })
    expect(denied.headers['x-ratelimit-remaining']).toBe('0')

    const hitsHeld = await externalUserHits()
    expect(delta(hitsHeld, hitsBefore, 'fallback_allowed')).toBe(EXTERNAL_PER_MIN)
    expect(delta(hitsHeld, hitsBefore, 'fallback_denied')).toBe(1)
    expect(delta(hitsHeld, hitsBefore, 'allowed')).toBe(0)
    expect(await ledgerCount(bucketKey)).toBeNull()

    // The in-memory counter for this key is over the limit, so an admitted
    // request now proves Postgres decided it.
    const recovered = await ack(app, userId)
    expect(recovered.status).toBe(404)
    expect(recovered.body).toEqual({ error: 'notification_not_found' })
    expect(recovered.headers['x-ratelimit-remaining']).toBe(String(EXTERNAL_PER_MIN - 1))
    // Liveness witness for the empty ledger above: the same request, once the
    // pool is free, is counted in rate_limit_buckets.
    expect(await ledgerCount(bucketKey)).toBe(1)
    const hitsAfter = await externalUserHits()
    expect(delta(hitsAfter, hitsHeld, 'allowed')).toBe(1)
    expect(delta(hitsAfter, hitsHeld, 'fallback_allowed')).toBe(0)
    expect(delta(hitsAfter, hitsHeld, 'fallback_denied')).toBe(0)
  }, 30_000)
})
