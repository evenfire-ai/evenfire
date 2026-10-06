import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { applyAdminSubscriptionRateLimitNamespace } from '../src/services/adminSubscriptionRateLimitMigration.js'
import { checkAndIncrementWithQuery } from '../src/services/rateLimiterService.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('administrative subscription counter namespace migration', () => {
  const database = `admin_quota_migration_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let pool: Pool
  let client: PoolClient
  const windowStart = 1_800_000_000_000
  const prefixes = [
    ['admin_codex_read:', 'admin_subscription_read:'],
    ['admin_codex_write:', 'admin_subscription_write:'],
    ['codex_oauth_callback:', 'subscription_oauth_callback:'],
  ] as const

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.toString() })
    client = await pool.connect()
  }, 60_000)

  beforeEach(async () => {
    await client.query('DROP TABLE IF EXISTS rate_limit_buckets CASCADE')
    await client.query(`CREATE TABLE rate_limit_buckets (
      bucket_key TEXT NOT NULL,
      window_start_ms BIGINT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket_key, window_start_ms)
    )`)
  })

  afterAll(async () => {
    try {
      client?.release()
      await pool?.end()
      if (!adminPool) return
      await adminPool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    } finally {
      await adminPool?.end()
    }
  })

  async function migrate() {
    await client.query('BEGIN')
    try {
      await applyAdminSubscriptionRateLimitNamespace(client)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }

  it.each(prefixes)(
    'merges existing %s accounting without a new allowance',
    async (legacy, current) => {
      // Synthetic suffixes model ledger identities, not authentication tokens.
      await client.query(
        `INSERT INTO rate_limit_buckets VALUES
      ($1, $3, 31), ($2, $3, 9), ('unrelated:fixture', $3, 7)`,
        [`${legacy}state:fixture`, `${current}state:fixture`, windowStart]
      )
      await migrate()
      const rows = await client.query(
        'SELECT bucket_key, count FROM rate_limit_buckets ORDER BY bucket_key'
      )
      expect(rows.rows).toEqual([
        { bucket_key: `${current}state:fixture`, count: 40 },
        { bucket_key: 'unrelated:fixture', count: 7 },
      ])
      await migrate()
      const repeated = await client.query(
        'SELECT count FROM rate_limit_buckets WHERE bucket_key = $1',
        [`${current}state:fixture`]
      )
      expect(repeated.rows[0].count).toBe(40)
    }
  )

  it.each(prefixes)('normalizes writes from an older %s binary', async (legacy, current) => {
    await client.query('INSERT INTO rate_limit_buckets VALUES ($1, $2, 31)', [
      `${legacy}fixture`,
      windowStart,
    ])
    await migrate()
    const check = await checkAndIncrementWithQuery(
      (sql, values) => client.query(sql, values),
      `${legacy}fixture`,
      150,
      windowStart
    )
    expect(check.count).toBe(32)
    const rows = await client.query('SELECT bucket_key, count FROM rate_limit_buckets')
    expect(rows.rows).toEqual([{ bucket_key: `${current}fixture`, count: 32 }])
  })

  it('keeps concurrent old and new writers on one physical counter', async () => {
    await migrate()
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        checkAndIncrementWithQuery(
          (sql, values) => pool.query(sql, values),
          `${index % 2 ? 'admin_codex_read:' : 'admin_subscription_read:'}fixture`,
          32,
          windowStart
        )
      )
    )
    expect(results.filter(result => result.allowed)).toHaveLength(32)
    expect(new Set(results.map(result => result.count)).size).toBe(40)
    const rows = await client.query('SELECT bucket_key, count FROM rate_limit_buckets')
    expect(rows.rows).toEqual([{ bucket_key: 'admin_subscription_read:fixture', count: 40 }])
  })

  it.each(prefixes)(
    'retains opaque long-key accounting for %s',
    async (legacyPrefix, currentPrefix) => {
      const suffix = `state:${'x'.repeat(600)}`
      const legacy = legacyPrefix + suffix
      const current = currentPrefix + suffix
      const digest = `sha256-long-key:${createHash('sha256').update(legacy).digest('hex')}`
      await client.query('INSERT INTO rate_limit_buckets VALUES ($1, $3, 31), ($2, $3, 9)', [
        digest,
        current,
        windowStart,
      ])
      await migrate()
      const renamed = await checkAndIncrementWithQuery(
        (sql, values) => client.query(sql, values),
        current,
        150,
        windowStart
      )
      expect(renamed.count).toBe(41)
      const older = await checkAndIncrementWithQuery(
        (sql, values) => client.query(sql, values),
        digest,
        150,
        windowStart
      )
      expect(older.count).toBe(42)
      const rows = await client.query('SELECT bucket_key, count FROM rate_limit_buckets')
      expect(rows.rows).toEqual([{ bucket_key: digest, count: 42 }])
    }
  )

  it('recovers at the next actual SQL window without deleting consumed counts', async () => {
    await client.query('INSERT INTO rate_limit_buckets VALUES ($1, $2, 150)', [
      'admin_codex_read:fixture',
      windowStart,
    ])
    await migrate()
    const run = (now: number) =>
      checkAndIncrementWithQuery(
        (sql, values) => client.query(sql, values),
        'admin_subscription_read:fixture',
        150,
        now
      )
    expect((await run(windowStart)).allowed).toBe(false)
    const next = await run(windowStart + 60_000)
    expect(next.allowed).toBe(true)
    expect(next.count).toBe(1)
    const previous = await client.query(
      'SELECT count FROM rate_limit_buckets WHERE window_start_ms = $1',
      [windowStart]
    )
    expect(previous.rows[0].count).toBe(151)
  })

  it('retains exact suffixes and independently counted windows', async () => {
    const suffix = 'state:fixture_%:admin_codex_read:embedded'
    await client.query('INSERT INTO rate_limit_buckets VALUES ($1, $2, 4), ($1, $3, 6)', [
      `admin_codex_read:${suffix}`,
      windowStart,
      windowStart + 60_000,
    ])
    await migrate()
    const rows = await client.query(
      'SELECT bucket_key, window_start_ms, count FROM rate_limit_buckets ORDER BY window_start_ms'
    )
    expect(rows.rows).toEqual([
      {
        bucket_key: `admin_subscription_read:${suffix}`,
        window_start_ms: String(windowStart),
        count: 4,
      },
      {
        bucket_key: `admin_subscription_read:${suffix}`,
        window_start_ms: String(windowStart + 60_000),
        count: 6,
      },
    ])
  })

  it('preserves accounting when the longer namespace crosses the 512-byte boundary', async () => {
    const suffix = 'x'.repeat(495)
    const legacy = 'admin_codex_read:' + suffix
    const current = 'admin_subscription_read:' + suffix
    expect(Buffer.byteLength(legacy)).toBe(512)
    expect(Buffer.byteLength(current)).toBeGreaterThan(512)
    await client.query('INSERT INTO rate_limit_buckets VALUES ($1, $3, 31), ($2, $3, 9)', [
      legacy,
      current,
      windowStart,
    ])
    await migrate()
    const expected = `sha256-long-key:${createHash('sha256').update(legacy).digest('hex')}`
    const result = await checkAndIncrementWithQuery(
      (sql, values) => client.query(sql, values),
      current,
      150,
      windowStart
    )
    expect(result.count).toBe(41)
    // An older binary's short raw input is canonicalized by the invoker trigger.
    await client.query(
      `INSERT INTO rate_limit_buckets VALUES ($1, $2, 1)
      ON CONFLICT (bucket_key, window_start_ms) DO UPDATE
      SET count = rate_limit_buckets.count + EXCLUDED.count`,
      [legacy, windowStart]
    )
    const rows = await client.query('SELECT bucket_key, count FROM rate_limit_buckets')
    expect(rows.rows).toEqual([{ bucket_key: expected, count: 42 }])
  })
})
