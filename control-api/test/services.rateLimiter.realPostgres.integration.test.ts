import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import { initDb } from '../src/db.js'
import {
  admitHostMessage,
  hostMessageAdmissionBucketKey,
} from '../src/services/hostMessageAdmission.js'
import { admitHostRpc, hostRpcAdmissionBucketKey } from '../src/services/hostRpcAdmission.js'
import {
  acquireRateLimitConcurrencyLease,
  checkAndIncrementStrictWithQuery,
  checkAndIncrementWithQuery,
} from '../src/services/rateLimiterService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

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
  const messageSubject = `user-${randomBytes(8).toString('hex')}`
  const messageAdmissionKey = hostMessageAdmissionBucketKey(messageSubject)
  const hostRpcSubject = `user-${randomBytes(8).toString('hex')}`
  const hostRpcOtherSubject = `user-${randomBytes(8).toString('hex')}`
  const hostRpcKey = hostRpcAdmissionBucketKey(hostRpcSubject)
  const hostRpcOtherKey = hostRpcAdmissionBucketKey(hostRpcOtherSubject)
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
    try {
      await pool?.query('DELETE FROM rate_limit_buckets WHERE bucket_key = ANY($1)', [
        [bucketKey, messageAdmissionKey, hostRpcKey, hostRpcOtherKey],
      ])
      await endPoolAndWaitForClients(pool)
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

  it('enforces one strict Host-RPC subject budget across sessions and fixed windows', async () => {
    const clients = [await pool.connect(), await pool.connect()]
    const mutableConfig = config as typeof config & { hostRpcAdmissionRlPerMin: number }
    const originalLimit = mutableConfig.hostRpcAdmissionRlPerMin
    mutableConfig.hostRpcAdmissionRlPerMin = 3
    const admitOn = (client: (typeof clients)[number], at = windowStartMs) =>
      admitHostRpc(hostRpcSubject, (key, limit) =>
        checkAndIncrementStrictWithQuery(
          (text, values) => client.query(text, values),
          key,
          limit,
          at,
          1
        )
      )
    try {
      const results = []
      for (let index = 0; index < 4; index += 1) {
        results.push(await admitOn(clients[index % clients.length]))
      }
      expect(results.map(result => result.status)).toEqual([
        'allowed',
        'allowed',
        'allowed',
        'limited',
      ])
      expect(results.filter(result => result.status === 'allowed')).toHaveLength(3)
      expect(results.filter(result => result.status === 'limited')).toHaveLength(1)

      const persisted = await pool.query<{ count: string }>(
        'SELECT count FROM rate_limit_buckets WHERE bucket_key = $1 AND window_start_ms = $2',
        [hostRpcKey, windowStartMs]
      )
      expect(Number(persisted.rows[0]?.count)).toBe(4)

      const otherSubject = await admitHostRpc(hostRpcOtherSubject, (key, limit) =>
        checkAndIncrementStrictWithQuery(
          (text, values) => clients[1].query(text, values),
          key,
          limit,
          windowStartMs,
          1
        )
      )
      expect(otherSubject.status).toBe('allowed')

      const nextWindow = await admitOn(clients[0], windowStartMs + 60_000)
      expect(nextWindow).toMatchObject({ status: 'allowed', check: { count: 1 } })

      const failedStore = await admitHostRpc(hostRpcSubject, async () => {
        throw new Error('store unavailable')
      })
      expect(failedStore).toEqual({ status: 'unavailable' })
    } finally {
      mutableConfig.hostRpcAdmissionRlPerMin = originalLimit
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
