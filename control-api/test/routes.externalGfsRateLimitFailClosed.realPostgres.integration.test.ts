import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'

// The external GFS limiter's Postgres backend, against real PostgreSQL at the
// production pool bounds: the CORE_POOL_* and RATE_LIMIT_POOL_* variables are
// deleted before db.js is imported. Requests go through the production
// Express app; the ONLY mock is the session-token verifier (identity), as in
// routes.externalGfsRateLimitStress. Skipped without
// CONTROL_API_REAL_PG_ADMIN_URL.

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

const LIMITER_POOL_MAX = 6
const LIMITER_ACQUIRE_TIMEOUT_MS = 5_000
// An affordances read walks four Postgres buckets in series (three
// pre-resolution, one resolved). Were the limiter to fail open again, each
// would wait out the acquire timeout before the request reached the handler;
// the budget covers that walk so the regression fails on the status assertion,
// not on the test timeout.
const T3_TIMEOUT_MS = (4 + 2) * LIMITER_ACQUIRE_TIMEOUT_MS
const CORE_POOL_MAX = 10
const CORE_ACQUIRE_TIMEOUT_MS = 2_000
// T5: serial same-row upserts per pool. 10 ms per upsert is the regression
// line; the plan's reversal rule (report and stop) sits at 2.5 ms with sync off.
const T5_UPSERTS = 200
const T5_MAX_TOTAL_MS = T5_UPSERTS * 10

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

describeRealPostgres('external GFS rate limiter backend (real PostgreSQL)', () => {
  const database = `control_api_gfs_rl_fail_closed_${randomBytes(6).toString('hex')}`
  const envKeys = [
    'CONTROL_API_PG_CONNECTION_STRING',
    'CORE_POOL_MAX',
    'CORE_POOL_CONNECTION_TIMEOUT_MS',
    'CORE_POOL_STATEMENT_TIMEOUT_MS',
    'RATE_LIMIT_POOL_MAX',
    'RATE_LIMIT_POOL_CONNECTION_TIMEOUT_MS',
    'RATE_LIMIT_POOL_STATEMENT_TIMEOUT_MS',
  ] as const
  const previousEnv = new Map<string, string | undefined>()

  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  let mod: {
    createApp: (gateway: unknown) => import('express').Express
    config: typeof import('../src/config.js').config
    requestsTotal: typeof import('../src/observability/metrics.js').externalGfsRateLimitRequestsTotal
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
      requestsTotal: metricsMod.externalGfsRateLimitRequestsTotal,
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

  it('U1: the limiter pool runs with synchronous_commit off and a 3 s statement timeout; the core pool keeps the defaults', async () => {
    type Options = {
      options: { max: number; connectionTimeoutMillis: number; statement_timeout: number }
    }
    expect((limiterPool as unknown as Options).options).toMatchObject({
      max: 6,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 3_000,
    })

    const settings = `SELECT current_setting('synchronous_commit') AS sync,
                             current_setting('statement_timeout') AS timeout,
                             current_database() AS db`
    const limiter = await limiterPool.query<{ sync: string; timeout: string; db: string }>(settings)
    const core = await corePool.query<{ sync: string; timeout: string; db: string }>(settings)

    // Witness: both answers come from this suite's database.
    expect(limiter.rows[0]?.db).toBe(database)
    expect(core.rows[0]?.db).toBe(database)
    expect(limiter.rows[0]).toMatchObject({ sync: 'off', timeout: '3s' })
    expect(core.rows[0]).toMatchObject({ sync: 'on', timeout: '15s' })
  })

  async function seedUser(): Promise<string> {
    const id = randomUUID()
    await corePool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      id,
      `${id}@example.test`,
      'fail-closed',
    ])
    return id
  }

  async function getAffordances(app: import('express').Express, userId: string) {
    const internalToken = mod.config.internalServiceTokens['external-rest-api']
    if (!internalToken) throw new Error('config has no external-rest-api internal service token')
    return request(app)
      .get(`/api/v1/external/gfs/resources/${randomUUID()}/affordances?drive=main`)
      .set('Authorization', `Bearer ${internalToken}`)
      .set('x-service-token', 'external-rest-api')
      .set('x-user-session-token', JSON.stringify({ userId }))
      .set('x-forwarded-for', '203.0.113.7')
  }

  async function unavailableDecisions(): Promise<number> {
    const { values } = await mod.requestsTotal.get()
    return values
      .filter(sample => sample.labels.outcome === 'unavailable')
      .reduce((total, sample) => total + sample.value, 0)
  }

  /** Read through the core pool: the limiter pool is the one being held. */
  async function ledgerKeys(): Promise<string[]> {
    const result = await corePool.query<{ bucket_key: string }>(
      'SELECT bucket_key FROM rate_limit_buckets ORDER BY bucket_key'
    )
    return result.rows.map(row => row.bucket_key)
  }

  it(
    'T3: with every limiter connection held, an external GFS read fails closed with 503 and is not counted; after release it passes',
    async () => {
      const app = mod.createApp(new mod.MockGateway())
      const userId = await seedUser()
      await corePool.query('DELETE FROM rate_limit_buckets')
      const unavailableBefore = await unavailableDecisions()

      const held: PoolClient[] = []
      let denied: Awaited<ReturnType<typeof getAffordances>>
      let elapsedMs: number
      try {
        for (let index = 0; index < LIMITER_POOL_MAX; index += 1) {
          held.push(await limiterPool.connect())
        }
        // Witness: the pool is exhausted, not merely busy.
        expect(limiterPool.totalCount).toBe(LIMITER_POOL_MAX)
        expect(limiterPool.idleCount).toBe(0)

        const startedAt = Date.now()
        denied = await getAffordances(app, userId)
        elapsedMs = Date.now() - startedAt
      } finally {
        for (const client of held) client.release()
      }

      expect(denied.status).toBe(503)
      expect(denied.body).toEqual({ error: 'gfs_rate_limit_unavailable', retryAfterSeconds: 2 })
      expect(denied.headers['retry-after']).toBe('2')
      expect(denied.headers['cache-control']).toBe('no-store')
      // Witness: the 503 came from waiting out the limiter's acquire timeout.
      expect(elapsedMs).toBeGreaterThanOrEqual(LIMITER_ACQUIRE_TIMEOUT_MS - 250)
      expect((await unavailableDecisions()) - unavailableBefore).toBe(1)
      expect(await ledgerKeys()).toEqual([])

      const allowed = await getAffordances(app, userId)
      expect(allowed.status).toBe(200)
      // Liveness witness for the empty ledger above: the same request, once the
      // pool is free, is counted in rate_limit_buckets.
      const keys = await ledgerKeys()
      expect(keys.length).toBeGreaterThan(0)
      expect(keys.every(key => key.startsWith('gfs-ext:'))).toBe(true)
      expect((await unavailableDecisions()) - unavailableBefore).toBe(1)
    },
    T3_TIMEOUT_MS
  )

  // Holding the pool (T3) cannot reach the grants rateLimitMiddleware: the
  // pre-resolution Postgres bucket fails closed first. A trigger instead
  // fails every limiter upsert whose key is not an external GFS Postgres
  // bucket, so those keep counting and the grants bucket gets a real query
  // error (plan addendum A2).
  async function injectLimiterFault(): Promise<void> {
    await corePool.query(`
      CREATE FUNCTION t3b_limiter_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.bucket_key NOT LIKE 'gfs-ext:%' THEN
          RAISE EXCEPTION 't3b injected limiter fault';
        END IF;
        RETURN NEW;
      END
      $$`)
    await corePool.query(`
      CREATE TRIGGER t3b_limiter_fault BEFORE INSERT ON rate_limit_buckets
        FOR EACH ROW EXECUTE FUNCTION t3b_limiter_fault()`)
  }

  async function removeLimiterFault(): Promise<void> {
    await corePool.query('DROP TRIGGER IF EXISTS t3b_limiter_fault ON rate_limit_buckets')
    await corePool.query('DROP FUNCTION IF EXISTS t3b_limiter_fault()')
  }

  it('T3b: the external grants limiter fails closed on a backend error while a process-memory route still passes', async () => {
    const app = mod.createApp(new mod.MockGateway())
    const userId = await seedUser()
    const internalToken = mod.config.internalServiceTokens['external-rest-api']
    if (!internalToken) throw new Error('config has no external-rest-api internal service token')
    const external = (req: request.Test) =>
      req
        .set('Authorization', `Bearer ${internalToken}`)
        .set('x-service-token', 'external-rest-api')
        .set('x-user-session-token', JSON.stringify({ userId }))
        .set('x-forwarded-for', '203.0.113.7')
    await corePool.query('DELETE FROM rate_limit_buckets')

    let grants: request.Response
    let ack: request.Response
    await injectLimiterFault()
    try {
      grants = await external(
        request(app).get(`/api/v1/external/gfs/grants?drive=main&resourceId=${randomUUID()}`)
      )
      ack = await external(request(app).post(`/api/v1/external/notifications/${randomUUID()}/ack`))
    } finally {
      await removeLimiterFault()
    }

    // The 503 comes from rateLimitMiddleware, not from the external GFS
    // Postgres buckets (whose body is gfs_rate_limit_unavailable).
    expect(grants.status).toBe(503)
    expect(grants.body).toEqual({ error: 'rate_limit_unavailable', retryAfterSeconds: 2 })
    expect(grants.headers['retry-after']).toBe('2')
    expect(grants.headers['cache-control']).toBe('no-store')
    // Witness for the process-memory policy under the same fault: the ack
    // route's Postgres limiter could not count either, its in-memory counter
    // admitted the first request, and its handler answered.
    expect(ack.status).toBe(404)
    expect(ack.body).toEqual({ error: 'notification_not_found' })

    // Witness that the fault is scoped as intended: the external GFS Postgres
    // buckets counted, and nothing else reached the ledger.
    const keys = await ledgerKeys()
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every(key => key.startsWith('gfs-ext:'))).toBe(true)
  }, 30_000)

  it('T4: with every core connection held, session validation answers 503 while an invalid token still answers 401', async () => {
    type Options = { options: { max: number; connectionTimeoutMillis: number } }
    expect((corePool as unknown as Options).options).toMatchObject({
      max: CORE_POOL_MAX,
      connectionTimeoutMillis: CORE_ACQUIRE_TIMEOUT_MS,
    })
    const app = mod.createApp(new mod.MockGateway())
    const userId = await seedUser()
    const internalToken = mod.config.internalServiceTokens['external-rest-api']
    if (!internalToken) throw new Error('config has no external-rest-api internal service token')
    const external = (req: request.Test, sessionToken: string) =>
      req
        .set('Authorization', `Bearer ${internalToken}`)
        .set('x-service-token', 'external-rest-api')
        .set('x-user-session-token', sessionToken)
        .set('x-forwarded-for', '203.0.113.7')
    const affordancesPath = () =>
      `/api/v1/external/gfs/resources/${randomUUID()}/affordances?drive=main`

    const held: PoolClient[] = []
    let unavailable: request.Response
    let invalid: request.Response
    let elapsedMs: number
    try {
      for (let index = 0; index < CORE_POOL_MAX; index += 1) {
        held.push(await corePool.connect())
      }
      // Witness: the core pool is exhausted, not merely busy.
      expect(corePool.totalCount).toBe(CORE_POOL_MAX)
      expect(corePool.idleCount).toBe(0)

      const startedAt = Date.now()
      unavailable = await external(request(app).get(affordancesPath()), JSON.stringify({ userId }))
      elapsedMs = Date.now() - startedAt
      invalid = await external(request(app).get(affordancesPath()), 'not-a-session-token')
    } finally {
      for (const client of held) client.release()
    }

    expect(unavailable.status).toBe(503)
    expect(unavailable.body).toEqual({
      error: 'session_backend_unavailable',
      retryAfterSeconds: 2,
    })
    expect(unavailable.headers['retry-after']).toBe('2')
    expect(unavailable.headers['cache-control']).toBe('no-store')
    // Witness: the 503 came from waiting out the core pool's acquire timeout.
    expect(elapsedMs).toBeGreaterThanOrEqual(CORE_ACQUIRE_TIMEOUT_MS - 250)

    expect(invalid.status).toBe(401)
    expect(invalid.body).toEqual({ error: 'Unauthorized' })

    // Liveness witness: the same valid request, once the pool is free, passes
    // session validation and reaches the handler.
    const allowed = await external(request(app).get(affordancesPath()), JSON.stringify({ userId }))
    expect(allowed.status).toBe(200)
  }, 30_000)

  it('T5 (informational): same-row limiter upserts with synchronous_commit off vs on', async () => {
    const { checkAndIncrementWithQuery } = await import('../src/services/rateLimiterService.js')
    const measure = async (pool: Pool, label: string): Promise<number> => {
      const key = `t5:${label}:${randomUUID()}`
      const nowMs = Date.now()
      const startedAt = process.hrtime.bigint()
      let last = 0
      for (let index = 0; index < T5_UPSERTS; index += 1) {
        const result = await checkAndIncrementWithQuery(
          (text, values) => pool.query(text, values),
          key,
          T5_UPSERTS,
          nowMs
        )
        expect(result.backendAvailable).toBe(true)
        last = result.count
      }
      const totalMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      // Witness: every upsert landed on the same row.
      expect(last).toBe(T5_UPSERTS)
      return totalMs
    }

    const offMs = await measure(limiterPool, 'sync-off')
    const onMs = await measure(corePool, 'sync-on')
    console.info(
      `[T5] ${T5_UPSERTS} serial same-row upserts: synchronous_commit=off ` +
        `${(offMs / T5_UPSERTS).toFixed(3)} ms/upsert, on ${(onMs / T5_UPSERTS).toFixed(3)} ms/upsert`
    )
    expect(offMs).toBeLessThan(T5_MAX_TOTAL_MS)
  }, 30_000)
})
