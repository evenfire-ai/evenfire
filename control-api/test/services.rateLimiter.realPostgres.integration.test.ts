import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import {
  admitHostMessage,
  hostMessageAdmissionBucketKey,
} from '../src/services/hostMessageAdmission.js'
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
  const preAdmissionKey = `host-artifact-pre-admission:user-${randomBytes(8).toString('hex')}`
  const sandboxUserA = `user-${randomBytes(8).toString('hex')}`
  const sandboxUserB = `user-${randomBytes(8).toString('hex')}`
  const sandboxTokenVendKey = `sandbox-oauth-token-vend:${sandboxUserA}`
  const sandboxDisconnectKey = `sandbox-oauth-grant-disconnect:${sandboxUserA}`
  const sandboxOtherUserKey = `sandbox-oauth-token-vend:${sandboxUserB}`
  const messageSubject = `user-${randomBytes(8).toString('hex')}`
  const messageAdmissionKey = hostMessageAdmissionBucketKey(messageSubject)
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
    await pool?.query('DELETE FROM rate_limit_buckets WHERE bucket_key = ANY($1)', [
      [
        bucketKey,
        preAdmissionKey,
        sandboxTokenVendKey,
        sandboxDisconnectKey,
        sandboxOtherUserKey,
        messageAdmissionKey,
      ],
    ])
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

  it('shares subject-only artifact admission atomically across independent PostgreSQL sessions', async () => {
    const clients = [await pool.connect(), await pool.connect()]
    try {
      const results = []
      for (let round = 0; round < 16; round += 1) {
        const concurrentResults = await Promise.all(
          clients.map(client =>
            checkAndIncrementWithQuery(
              (text, values) => client.query(text, values),
              preAdmissionKey,
              30,
              windowStartMs,
              1
            )
          )
        )
        results.push(...concurrentResults)
      }
      const counts = results.map(result => result.count).sort((a, b) => a - b)
      expect(counts).toEqual(Array.from({ length: 32 }, (_, index) => index + 1))
      expect(results.filter(result => result.allowed)).toHaveLength(30)

      const persisted = await pool.query<{ count: string }>(
        'SELECT count FROM rate_limit_buckets WHERE bucket_key = $1 AND window_start_ms = $2',
        [preAdmissionKey, windowStartMs]
      )
      expect(Number(persisted.rows[0]?.count)).toBe(32)
    } finally {
      clients.forEach(client => client.release())
    }
  })

  it('shares each Sandbox OAuth user-operation budget across independent sessions', async () => {
    const clients = [await pool.connect(), await pool.connect()]
    try {
      const tokenResults = []
      for (let requestIndex = 0; requestIndex < 11; requestIndex += 1) {
        const client = clients[requestIndex % clients.length]
        tokenResults.push(
          await checkAndIncrementWithQuery(
            (text, values) => client.query(text, values),
            sandboxTokenVendKey,
            10,
            windowStartMs,
            1
          )
        )
      }

      expect(tokenResults.slice(0, 10).every(result => result.allowed)).toBe(true)
      expect(tokenResults[10]).toMatchObject({ allowed: false, count: 11, remaining: 0 })

      const disconnect = await checkAndIncrementWithQuery(
        (text, values) => clients[0].query(text, values),
        sandboxDisconnectKey,
        10,
        windowStartMs,
        1
      )
      const otherUser = await checkAndIncrementWithQuery(
        (text, values) => clients[1].query(text, values),
        sandboxOtherUserKey,
        10,
        windowStartMs,
        1
      )
      expect(disconnect).toMatchObject({ allowed: true, count: 1, remaining: 9 })
      expect(otherUser).toMatchObject({ allowed: true, count: 1, remaining: 9 })

      const persisted = await pool.query<{ bucket_key: string; count: string }>(
        `SELECT bucket_key, count
           FROM rate_limit_buckets
          WHERE bucket_key = ANY($1)
          ORDER BY bucket_key`,
        [[sandboxTokenVendKey, sandboxDisconnectKey, sandboxOtherUserKey]]
      )
      expect(
        Object.fromEntries(persisted.rows.map(row => [row.bucket_key, Number(row.count)]))
      ).toEqual({
        [sandboxDisconnectKey]: 1,
        [sandboxOtherUserKey]: 1,
        [sandboxTokenVendKey]: 11,
      })
    } finally {
      clients.forEach(client => client.release())
    }
  })

  it('enforces Host-message admission atomically across independent PostgreSQL sessions', async () => {
    const clients = [await pool.connect(), await pool.connect()]
    try {
      const runs = await Promise.all(
        clients.map(async (client, clientIndex) => {
          const checks = []
          for (let index = clientIndex; index < 61; index += clients.length) {
            checks.push(
              await admitHostMessage(messageSubject, (key, max) =>
                checkAndIncrementWithQuery(
                  (text, values) => client.query(text, values),
                  key,
                  max,
                  windowStartMs,
                  1
                )
              )
            )
          }
          return checks
        })
      )
      const checks = runs.flat()
      expect(checks.filter(check => check.status === 'allowed')).toHaveLength(60)
      expect(checks.filter(check => check.status === 'limited')).toHaveLength(1)
      const persisted = await pool.query<{ count: string }>(
        'SELECT count FROM rate_limit_buckets WHERE bucket_key = $1 AND window_start_ms = $2',
        [messageAdmissionKey, windowStartMs]
      )
      expect(Number(persisted.rows[0]?.count)).toBe(61)
    } finally {
      clients.forEach(client => client.release())
    }
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
