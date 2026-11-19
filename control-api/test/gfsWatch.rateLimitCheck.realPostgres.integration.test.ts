import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// The pure limiter half against the real Postgres limiter: decisions come
// from checkAndIncrement on the real rate-limit pool, and the response is
// written only by the handler after the decision.

const LIMITER_POOL_MAX = 1
const LIMITER_ACQUIRE_TIMEOUT_MS = 200
const EXTERNAL_PER_MIN = 2

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

describeRealPostgres('pure rate limit check on the real Postgres limiter', () => {
  const database = `control_api_gfs_watch_rl_${randomBytes(6).toString('hex')}`
  const envKeys = [
    'CONTROL_API_PG_CONNECTION_STRING',
    'RATE_LIMIT_POOL_MAX',
    'RATE_LIMIT_POOL_CONNECTION_TIMEOUT_MS',
    'APPROVAL_RL_EXTERNAL_PER_MIN',
  ] as const
  const previousEnv = new Map<string, string | undefined>()
  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  let limits: typeof import('../src/middleware/rateLimitMiddleware.js')
  let watchLimits: typeof import('../src/middleware/externalWatchRateLimit.js')

  beforeAll(async () => {
    const connectionString = databaseUrl(adminUrl!, database)
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
    await endPoolAndWaitForClients(migratePool)
    limits = await import('../src/middleware/rateLimitMiddleware.js')
    watchLimits = await import('../src/middleware/externalWatchRateLimit.js')
  }, 60_000)

  afterAll(async () => {
    try {
      for (const key of envKeys) {
        const value = previousEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await endPoolAndWaitForClients(corePool).catch(() => {})
      await endPoolAndWaitForClients(limiterPool).catch(() => {})
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  // The Postgres window is floor(Date.now() / 60 s). Pin the wall clock to the
  // middle of a minute so a case's hits never straddle a window boundary;
  // timers stay real for the pool and the HTTP server.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 30_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * A handler that has already sent its response before it asks the limiter:
   * any write by the check would raise ERR_HTTP_HEADERS_SENT. The decision is
   * returned as JSON by a second, explicit writer pass on a fresh response.
   */
  function appCheckingAfterResponse(
    check: import('../src/middleware/rateLimitMiddleware.js').RateLimitCheck,
    key: string
  ) {
    const decisions: unknown[] = []
    const errors: unknown[] = []
    const app = express()
    app.get('/after-response', (_req, res) => {
      res.status(204).end()
      check(key).then(
        decision => decisions.push(decision),
        error => errors.push(error)
      )
    })
    app.get('/write', (_req, res) => {
      void (async () => {
        const decision = await check(key)
        limits.writeRateLimitDecisionHeaders(res, decision)
        if (decision.outcome === 'allowed') res.status(204).end()
        else if (decision.outcome === 'denied') res.status(429).json({ error: 'rate_limited' })
        else res.status(503).json({ error: 'rate_limit_unavailable' })
      })().catch(error => errors.push(error))
    })
    return { app, decisions, errors }
  }

  async function settle(decisions: unknown[], errors: unknown[], count: number) {
    for (let i = 0; i < 100 && decisions.length + errors.length < count; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }

  it('decides allowed then denied without writing to a response that is already sent', async () => {
    const userId = randomUUID()
    const check = watchLimits.createGfsWatchOpenRateLimitCheck()
    const { app, decisions, errors } = appCheckingAfterResponse(
      check,
      watchLimits.gfsWatchOpenBucketKey(userId)
    )
    for (let n = 0; n <= EXTERNAL_PER_MIN; n += 1) {
      await request(app).get('/after-response').expect(204)
    }
    await settle(decisions, errors, EXTERNAL_PER_MIN + 1)
    expect(errors).toEqual([])
    expect(decisions.map(d => (d as { outcome: string }).outcome)).toEqual([
      'allowed',
      'allowed',
      'denied',
    ])
    expect(decisions[2]).toMatchObject({
      limit: EXTERNAL_PER_MIN,
      retryAfterSeconds: expect.any(Number),
    })
  })

  it('writes the denied headers once, from the handler', async () => {
    const userId = randomUUID()
    const { app, errors } = appCheckingAfterResponse(
      watchLimits.createGfsWatchOpenRateLimitCheck(),
      watchLimits.gfsWatchOpenBucketKey(userId)
    )
    const allowed = await request(app).get('/write')
    expect(allowed.status).toBe(204)
    expect(allowed.headers['ratelimit-limit']).toBe(String(EXTERNAL_PER_MIN))
    expect(allowed.headers['ratelimit-remaining']).toBe(String(EXTERNAL_PER_MIN - 1))
    await request(app).get('/write').expect(204)
    const denied = await request(app).get('/write')
    expect(denied.status).toBe(429)
    expect(Number(denied.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    expect(denied.headers['ratelimit-remaining']).toBe('0')
    expect(errors).toEqual([])
  })

  it('decides unavailable with every limiter connection held, and the handler answers 503 once', async () => {
    const userId = randomUUID()
    const { app, decisions, errors } = appCheckingAfterResponse(
      watchLimits.createGfsWatchPutRateLimitCheck(),
      watchLimits.gfsWatchPutBucketKey(userId)
    )
    const held: PoolClient[] = []
    try {
      for (let index = 0; index < LIMITER_POOL_MAX; index += 1)
        held.push(await limiterPool.connect())
      await request(app).get('/after-response').expect(204)
      await settle(decisions, errors, 1)
      expect(decisions).toEqual([{ outcome: 'unavailable', retryAfterSeconds: expect.any(Number) }])
      const response = await request(app).get('/write')
      expect(response.status).toBe(503)
      expect(response.body).toEqual({ error: 'rate_limit_unavailable' })
      expect(response.headers['retry-after']).toMatch(/^\d+$/)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['ratelimit-limit']).toBeUndefined()
    } finally {
      for (const client of held) client.release()
    }
    expect(errors).toEqual([])
  })

  it('counts the PUT bucket at 120 per minute, apart from the open bucket', async () => {
    const userId = randomUUID()
    const put = watchLimits.createGfsWatchPutRateLimitCheck()
    const open = watchLimits.createGfsWatchOpenRateLimitCheck()
    const outcomes: string[] = []
    for (let n = 0; n <= watchLimits.GFS_WATCH_PUT_RL_PER_MIN; n += 1) {
      outcomes.push((await put(watchLimits.gfsWatchPutBucketKey(userId))).outcome)
    }
    expect(outcomes.filter(o => o === 'allowed')).toHaveLength(120)
    expect(outcomes.at(-1)).toBe('denied')
    expect((await open(watchLimits.gfsWatchOpenBucketKey(userId))).outcome).toBe('allowed')
    const buckets = await corePool.query<{ bucket_key: string; count: number }>(
      `SELECT bucket_key, count FROM rate_limit_buckets WHERE bucket_key LIKE $1 ORDER BY bucket_key`,
      [`user:${userId}:%`]
    )
    expect(buckets.rows.map(row => [row.bucket_key, Number(row.count)])).toEqual([
      [`user:${userId}:gfs-watch-open`, 1],
      [`user:${userId}:gfs-watch-put`, 121],
    ])
  })
})
