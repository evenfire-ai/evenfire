import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import {
  LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE,
  legacySessionAdmissionBucketKey,
} from '../src/services/legacySessionAdmission.js'
import { checkAndIncrementWithQuery } from '../src/services/rateLimiterService.js'
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

describeRealPostgres('legacy session admission on real PostgreSQL', () => {
  const database = `legacy_session_${randomBytes(6).toString('hex')}`
  const subjectA = `user-${randomBytes(8).toString('hex')}`
  const subjectB = `user-${randomBytes(8).toString('hex')}`
  const bucketA = legacySessionAdmissionBucketKey(subjectA)
  const bucketB = legacySessionAdmissionBucketKey(subjectB)
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
        [bucketA, bucketB],
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

  it('shares the verified-subject budget across independent sessions and routes', async () => {
    const clients = [await pool.connect(), await pool.connect()]
    try {
      const claims = await Promise.all(
        Array.from({ length: LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE + 1 }, (_, index) => {
          const client = clients[index % clients.length]
          return checkAndIncrementWithQuery(
            (text, values) => client.query(text, values),
            bucketA,
            LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE,
            windowStartMs,
            1
          )
        })
      )

      expect(claims.filter(result => result.allowed)).toHaveLength(60)
      expect(claims.filter(result => !result.allowed)).toHaveLength(1)
      expect(claims.map(result => result.count).sort((left, right) => left - right)).toEqual(
        Array.from({ length: 61 }, (_, index) => index + 1)
      )
      expect(bucketA).toBe(`legacy-session:${subjectA}`)
      expect(bucketB).not.toBe(bucketA)

      const otherSubject = await checkAndIncrementWithQuery(
        (text, values) => clients[1].query(text, values),
        bucketB,
        LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE,
        windowStartMs,
        1
      )
      expect(otherSubject).toMatchObject({ allowed: true, count: 1, remaining: 59 })

      const persisted = await pool.query<{ bucket_key: string; count: string }>(
        `SELECT bucket_key, count
           FROM rate_limit_buckets
          WHERE bucket_key = ANY($1)
          ORDER BY bucket_key`,
        [[bucketA, bucketB]]
      )
      expect(
        Object.fromEntries(persisted.rows.map(row => [row.bucket_key, Number(row.count)]))
      ).toEqual({ [bucketA]: 61, [bucketB]: 1 })
    } finally {
      clients.forEach(client => client.release())
    }
  })
})
