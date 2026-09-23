import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'

// The external GFS limiter's Postgres backend, against real PostgreSQL at the
// production pool bounds: the CORE_POOL_* and RATE_LIMIT_POOL_* variables are
// deleted before db.js is imported. Skipped without
// CONTROL_API_REAL_PG_ADMIN_URL.

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
})
