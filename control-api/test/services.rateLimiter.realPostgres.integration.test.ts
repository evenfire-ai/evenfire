import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { checkAndIncrementWithQuery } from '../src/services/rateLimiterService.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('rate limiter atomicity on real PostgreSQL', () => {
  const database = `rate_limiter_${randomBytes(6).toString('hex')}`
  const bucketKey = `real-pg:${randomBytes(8).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const windowStartMs = Math.floor(Date.now() / 60_000) * 60_000
  let adminPool: Pool
  let pool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
  }, 60_000)

  afterAll(async () => {
    await pool?.query('DELETE FROM rate_limit_buckets WHERE bucket_key = $1', [bucketKey])
    await pool?.end()
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  it('returns distinct post-increment counts under concurrent requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        checkAndIncrementWithQuery(
          (text, values) => pool.query(text, values),
          bucketKey,
          32,
          windowStartMs,
          1
        )
      )
    )
    const counts = results.map(result => result.count).sort((a, b) => a - b)
    expect(counts).toEqual(Array.from({ length: 32 }, (_, index) => index + 1))
    const persisted = await pool.query<{ count: string }>(
      'SELECT count FROM rate_limit_buckets WHERE bucket_key = $1 AND window_start_ms = $2',
      [bucketKey, windowStartMs]
    )
    expect(Number(persisted.rows[0]?.count)).toBe(32)
  })

  it('serializes a bounded advisory slot across independent PostgreSQL sessions', async () => {
    const key = `gfs-upload-slot:${randomBytes(8).toString('hex')}`
    const first = await pool.connect()
    const second = await pool.connect()
    try {
      const acquiredFirst = await first.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1), 0) AS acquired`,
        [key]
      )
      const acquiredSecond = await second.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1), 0) AS acquired`,
        [key]
      )
      expect(acquiredFirst.rows[0]?.acquired).toBe(true)
      expect(acquiredSecond.rows[0]?.acquired).toBe(false)

      await first.query(`SELECT pg_advisory_unlock(hashtext($1), 0)`, [key])
      const acquiredAfterRelease = await second.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1), 0) AS acquired`,
        [key]
      )
      expect(acquiredAfterRelease.rows[0]?.acquired).toBe(true)
      await second.query(`SELECT pg_advisory_unlock(hashtext($1), 0)`, [key])
    } finally {
      first.release()
      second.release()
    }
  })
})
