import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'

// The limiter's upserts run on their own pool (db.ts `rateLimitPool`, max 6,
// 5 s acquire), separate from the core pool (max 10, 2 s acquire).
//
// Service-level contract when the LIMITER pool is saturated: every
// checkAndIncrement call waits for the limiter pool's acquire timeout, logs
// rate_limit_db_error, counts nothing, and returns allowed:true with
// backendAvailable:false. `allowed` alone is not an admission decision there:
// each caller reads backendAvailable and decides. The external GFS limiter and
// upload admission fail closed with 503 (routes.externalGfsRateLimitFailClosed
// T3); callers that still admit on backendAvailable:false do so by their own
// choice, not because the service decided it.
//
// Isolation: a saturated CORE pool no longer reaches the limiter; it keeps
// counting.
//
// The production pool bounds are used unchanged: the CORE_POOL_* and
// RATE_LIMIT_POOL_* variables are deleted before db.js is imported, and the
// resulting bounds are asserted before anything else.
//
// Route-level corollary: with the core pool held, an external GFS request
// returns 503 session_backend_unavailable, because session auth queries the
// users table first (externalSessionAuth.ts) and fails closed before the
// limiter runs. The only mock is the session-token verifier (identity). Skipped without
// CONTROL_API_REAL_PG_ADMIN_URL.

const mockVerifyExternalSessionToken = vi.fn()

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: (...args: unknown[]) => mockVerifyExternalSessionToken(...args),
}))

const PRODUCTION_POOL_MAX = 10
const PRODUCTION_ACQUIRE_TIMEOUT_MS = 2_000
const LIMITER_POOL_MAX = 6
const LIMITER_ACQUIRE_TIMEOUT_MS = 5_000
const CONCURRENT_CHECKS = 25
const LIMIT = 2

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

describeRealPostgres('rate limiter under pool saturation', () => {
  const database = `rate_limiter_saturation_${randomBytes(6).toString('hex')}`
  const poolEnvKeys = [
    'CONTROL_API_PG_CONNECTION_STRING',
    'CORE_POOL_MAX',
    'CORE_POOL_CONNECTION_TIMEOUT_MS',
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
    checkAndIncrement: typeof import('../src/services/rateLimiterService.js').checkAndIncrement
    rootLogger: typeof import('../src/observability/logger.js').rootLogger
    MockGateway: typeof import('./mockGateway.js').MockGateway
  }

  async function holdEveryClient(target: Pool, max: number): Promise<PoolClient[]> {
    const held = await Promise.all(Array.from({ length: max }, () => target.connect()))
    expect(target.totalCount).toBe(max)
    expect(target.idleCount).toBe(0)
    return held
  }

  beforeAll(async () => {
    if (adminUrl === undefined) {
      throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required by this suite')
    }
    const connectionString = databaseUrl(adminUrl, database)
    for (const key of poolEnvKeys) previousEnv.set(key, process.env[key])
    for (const key of poolEnvKeys) {
      if (key !== 'CONTROL_API_PG_CONNECTION_STRING') delete process.env[key]
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
    const limiterMod = await import('../src/services/rateLimiterService.js')
    const loggerMod = await import('../src/observability/logger.js')
    const { MockGateway } = await import('./mockGateway.js')
    mod = {
      createApp: appMod.createApp as never,
      config: configMod.config,
      checkAndIncrement: limiterMod.checkAndIncrement,
      rootLogger: loggerMod.rootLogger,
      MockGateway,
    }
  }, 60_000)

  afterAll(async () => {
    for (const key of poolEnvKeys) {
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

  it('runs against the production pool bounds', () => {
    type Options = { options: { max: number; connectionTimeoutMillis: number } }
    const core = (corePool as unknown as Options).options
    expect(core.max).toBe(PRODUCTION_POOL_MAX)
    expect(core.connectionTimeoutMillis).toBe(PRODUCTION_ACQUIRE_TIMEOUT_MS)
    const limiter = (limiterPool as unknown as Options).options
    expect(limiter.max).toBe(LIMITER_POOL_MAX)
    expect(limiter.connectionTimeoutMillis).toBe(LIMITER_ACQUIRE_TIMEOUT_MS)
  })

  it('keeps counting while every core client is held', async () => {
    const bucketKey = `core-saturation:${randomBytes(8).toString('hex')}`
    const nowMs = Math.floor(Date.now() / 60_000) * 60_000 + 1_000
    const warn = vi.spyOn(mod.rootLogger, 'warn').mockImplementation(() => {})
    const held = await holdEveryClient(corePool, PRODUCTION_POOL_MAX)
    try {
      const results = []
      for (let i = 0; i < 3; i += 1) {
        results.push(await mod.checkAndIncrement(bucketKey, LIMIT, nowMs))
      }
      // Witness: the limiter reached Postgres and counted every call.
      expect(results.map(result => result.count)).toEqual([1, 2, 3])
      expect(results.map(result => result.allowed)).toEqual([true, true, false])
      expect(results.every(result => result.backendAvailable)).toBe(true)
      expect(
        warn.mock.calls.filter(
          call => (call[0] as { event?: string }).event === 'rate_limit_db_error'
        )
      ).toHaveLength(0)
    } finally {
      for (const client of held) client.release()
      warn.mockRestore()
    }
  }, 15_000)

  it('reports the backend unavailable for every concurrent check while every limiter client is held, then recovers', async () => {
    const bucketKey = `saturation:${randomBytes(8).toString('hex')}`
    // One fixed window for both phases, so a minute boundary cannot split them.
    const nowMs = Math.floor(Date.now() / 60_000) * 60_000 + 1_000
    const warn = vi.spyOn(mod.rootLogger, 'warn').mockImplementation(() => {})
    const held = await holdEveryClient(limiterPool, LIMITER_POOL_MAX)
    let released = false
    try {
      const startedAt = performance.now()
      const results = await Promise.all(
        Array.from({ length: CONCURRENT_CHECKS }, () =>
          mod.checkAndIncrement(bucketKey, LIMIT, nowMs)
        )
      )
      const elapsedMs = performance.now() - startedAt

      expect(results).toHaveLength(CONCURRENT_CHECKS)
      // The service reports allowed:true; the admission decision belongs to
      // the caller, which must read backendAvailable.
      expect(results.every(result => result.allowed === true)).toBe(true)
      // The backend was unavailable and nothing was counted.
      expect(results.every(result => result.backendAvailable === false)).toBe(true)
      expect(results.every(result => result.count === 0)).toBe(true)

      const dbErrors = warn.mock.calls
        .map(call => call[0] as { event?: string; hashedKey?: string; err?: string })
        .filter(payload => payload.event === 'rate_limit_db_error')
      expect(dbErrors).toHaveLength(CONCURRENT_CHECKS)
      // Witness that the failure is the pool's acquire timeout and nothing else.
      for (const payload of dbErrors) {
        expect(payload.hashedKey).toBe(createHash('sha256').update(bucketKey).digest('hex'))
        expect(payload.err).toMatch(/timeout exceeded when trying to connect/)
      }

      // Every call waited for the acquire timeout, in parallel, not in series.
      expect(elapsedMs).toBeGreaterThanOrEqual(LIMITER_ACQUIRE_TIMEOUT_MS - 100)
      expect(elapsedMs).toBeLessThan(LIMITER_ACQUIRE_TIMEOUT_MS + 3_000)

      // Read through a held client: this also proves the database and the
      // table are reachable, so "no row" is not an absent table.
      const persisted = await held[0]!.query<{ rows: string }>(
        'SELECT count(*)::text AS rows FROM rate_limit_buckets WHERE bucket_key = $1',
        [bucketKey]
      )
      expect(persisted.rows[0]?.rows).toBe('0')

      for (const client of held) client.release()
      released = true

      // Recovery witness, same key and window: counting starts at 1, which also
      // proves the 25 unavailable calls persisted nothing.
      const recovered = []
      for (let i = 0; i < 3; i += 1) {
        recovered.push(await mod.checkAndIncrement(bucketKey, LIMIT, nowMs))
      }
      expect(recovered.map(result => result.count)).toEqual([1, 2, 3])
      expect(recovered.map(result => result.allowed)).toEqual([true, true, false])
      expect(recovered.every(result => result.backendAvailable)).toBe(true)
      expect(
        warn.mock.calls.filter(
          call => (call[0] as { event?: string }).event === 'rate_limit_db_error'
        )
      ).toHaveLength(CONCURRENT_CHECKS)
    } finally {
      if (!released) for (const client of held) client.release()
      warn.mockRestore()
    }
  }, 20_000)

  it('answers 503 at the route while the core pool is held, because session auth fails first', async () => {
    const internalToken = mod.config.internalServiceTokens['external-rest-api']
    if (!internalToken) throw new Error('config has no external-rest-api internal service token')
    mockVerifyExternalSessionToken.mockReset()
    mockVerifyExternalSessionToken.mockReturnValue({
      userId: '11111111-aaaa-4aaa-8aaa-111111111111',
      email: 'u@example.com',
      teamId: '33333333-cccc-4ccc-8ccc-333333333333',
      role: 'member',
      authGeneration: 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    const app = mod.createApp(new mod.MockGateway())
    const send = () =>
      request(app)
        .get('/api/v1/external/gfs/resources')
        .set('Authorization', `Bearer ${internalToken}`)
        .set('x-service-token', 'external-rest-api')
        .set('x-user-session-token', 'session')

    // Liveness witness with the pool free: the request passes internal auth,
    // reaches the session verifier, and is denied by the users-table lookup
    // (no such user), so the 503 below comes from that same lookup.
    const free = await send()
    expect(free.status).toBe(401)
    expect(mockVerifyExternalSessionToken).toHaveBeenCalledTimes(1)

    const held = await holdEveryClient(corePool, PRODUCTION_POOL_MAX)
    try {
      const saturated = await send()
      expect(saturated.status).toBe(503)
      expect(saturated.body).toEqual({
        error: 'session_backend_unavailable',
        retryAfterSeconds: 2,
      })
      expect(saturated.headers['retry-after']).toBe('2')
      expect(mockVerifyExternalSessionToken).toHaveBeenCalledTimes(2)
    } finally {
      for (const client of held) client.release()
    }
  }, 15_000)
})
