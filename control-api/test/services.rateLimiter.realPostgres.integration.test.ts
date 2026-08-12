import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import {
  acquireRateLimitConcurrencyLease,
  checkAndIncrementWithQuery,
} from '../src/services/rateLimiterService.js'

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

  it('serializes the production bounded advisory lease across independent PostgreSQL sessions', async () => {
    const key = `gfs-upload-slot:${randomBytes(8).toString('hex')}`
    const first = await pool.connect()
    const second = await pool.connect()
    try {
      const firstLease = await acquireRateLimitConcurrencyLease(
        [{ bucketKey: key, maxConcurrent: 1 }],
        { client: first }
      )
      expect(firstLease).toMatchObject({ allowed: true, backendAvailable: true })

      const secondLease = await acquireRateLimitConcurrencyLease(
        [{ bucketKey: key, maxConcurrent: 1 }],
        { client: second }
      )
      expect(secondLease).toMatchObject({ allowed: false, backendAvailable: true })

      await firstLease.release()
      const acquiredAfterRelease = await acquireRateLimitConcurrencyLease(
        [{ bucketKey: key, maxConcurrent: 1 }],
        { client: second }
      )
      expect(acquiredAfterRelease).toMatchObject({ allowed: true, backendAvailable: true })
      await acquiredAfterRelease.release()
    } finally {
      first.release()
      second.release()
    }
  })

  it('uses distinct slots for capacity two and rolls back partial multi-bucket acquisition', async () => {
    const slotKey = `gfs-upload-slots:${randomBytes(8).toString('hex')}`
    const rollbackKey = `gfs-upload-rollback:${randomBytes(8).toString('hex')}`
    const freeKey = `gfs-upload-free:${randomBytes(8).toString('hex')}`
    const first = await pool.connect()
    const second = await pool.connect()
    try {
      const firstSlot = await acquireRateLimitConcurrencyLease(
        [{ bucketKey: slotKey, maxConcurrent: 2 }],
        { client: first }
      )
      const secondSlot = await acquireRateLimitConcurrencyLease(
        [{ bucketKey: slotKey, maxConcurrent: 2 }],
        { client: second }
      )
      expect(firstSlot.allowed).toBe(true)
      expect(secondSlot.allowed).toBe(true)
      const exhausted = await acquireRateLimitConcurrencyLease(
        [{ bucketKey: slotKey, maxConcurrent: 2 }],
        { client: first }
      )
      expect(exhausted.allowed).toBe(false)

      const held = await acquireRateLimitConcurrencyLease(
        [{ bucketKey: rollbackKey, maxConcurrent: 1 }],
        { client: first }
      )
      expect(held.allowed).toBe(true)
      const partial = await acquireRateLimitConcurrencyLease(
        [
          { bucketKey: freeKey, maxConcurrent: 1 },
          { bucketKey: rollbackKey, maxConcurrent: 1 },
        ],
        { client: second }
      )
      expect(partial.allowed).toBe(false)
      const afterRollback = await acquireRateLimitConcurrencyLease(
        [{ bucketKey: freeKey, maxConcurrent: 1 }],
        { client: second }
      )
      expect(afterRollback.allowed).toBe(true)

      await firstSlot.release()
      await secondSlot.release()
      await held.release()
      await afterRollback.release()
    } finally {
      first.release()
      second.release()
    }
  })
})
