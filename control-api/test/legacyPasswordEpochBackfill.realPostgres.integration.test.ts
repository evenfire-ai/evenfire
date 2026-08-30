import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { validateLegacyUserSession } from '../src/services/auth/userSessionService.js'
import {
  signExternalSessionToken,
  verifyExternalSessionToken,
} from '../src/utils/auth/externalSessionAuthToken.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function legacyToken(input: { userId: string; email: string; teamId: string; issuedAt: Date }) {
  vi.useFakeTimers()
  vi.setSystemTime(input.issuedAt)
  try {
    const token = signExternalSessionToken({
      userId: input.userId,
      email: input.email,
      teamId: input.teamId,
      role: 'admin',
      authGeneration: 1,
    })
    const claims = verifyExternalSessionToken(token)
    if (!claims) throw new Error('legacy token producer did not verify its token')
    return { token, claims }
  } finally {
    vi.useRealTimers()
  }
}

describeRealPostgres('legacy password epoch backfill on real PostgreSQL', () => {
  const database = `control_api_epoch_backfill_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    await databasePool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      await adminPool.end()
    }
  })

  it('fixes forward historical password epochs for already-migrated databases', async () => {
    const userId = randomUUID()
    const teamId = randomUUID()
    const cutoff = new Date('2026-08-27T12:00:00Z')
    const beforeCutoff = new Date('2026-08-27T11:59:30Z')
    const afterCutoff = new Date('2026-08-27T12:00:30Z')
    await databasePool.query(
      `INSERT INTO users(id, email, name, password_set_at, lifecycle_state, lifecycle_version)
       VALUES ($1, $2, 'Epoch User', $3, 'active', 1)`,
      [userId, `${userId}@example.test`, cutoff]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Epoch Team')`, [teamId])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'admin', 'active')`,
      [teamId, userId]
    )
    await databasePool.query(
      `DELETE FROM external_user_session_security_epochs WHERE user_id = $1`,
      [userId]
    )

    const old = legacyToken({
      userId,
      email: `${userId}@example.test`,
      teamId,
      issuedAt: beforeCutoff,
    })
    await expect(
      validateLegacyUserSession(old.token, old.claims, { db: databasePool })
    ).resolves.toMatchObject({ status: 'valid' })

    await databasePool.query(
      `DELETE FROM schema_migrations
        WHERE version = '010c_legacy_password_security_epoch_backfill'`
    )
    await initDb({ connect: () => databasePool.connect() })

    await expect(
      validateLegacyUserSession(old.token, old.claims, { db: databasePool })
    ).resolves.toMatchObject({ status: 'revoked', reason: 'security_event' })
    const next = legacyToken({
      userId,
      email: `${userId}@example.test`,
      teamId,
      issuedAt: afterCutoff,
    })
    await expect(
      validateLegacyUserSession(next.token, next.claims, { db: databasePool })
    ).resolves.toMatchObject({ status: 'valid' })

    const recorded = await databasePool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM schema_migrations
        WHERE version = '010c_legacy_password_security_epoch_backfill'`
    )
    expect(recorded.rows[0]?.count).toBe('1')
  })

  it('is monotonic, null-safe, and idempotent', async () => {
    const nullUser = randomUUID()
    const olderUser = randomUUID()
    const newerUser = randomUUID()
    const passwordSetAt = new Date('2026-08-27T10:00:00Z')
    await databasePool.query(
      `INSERT INTO users(id, email, name, password_set_at)
       VALUES ($1, $2, 'Null Password', NULL),
              ($3, $4, 'Older Epoch', $5),
              ($6, $7, 'Newer Epoch', $5)`,
      [
        nullUser,
        `${nullUser}@example.test`,
        olderUser,
        `${olderUser}@example.test`,
        passwordSetAt,
        newerUser,
        `${newerUser}@example.test`,
      ]
    )
    await databasePool.query(
      `INSERT INTO external_user_session_security_epochs(user_id, valid_after, reason)
       VALUES ($1, $2, 'older'),
              ($3, $4, 'newer')`,
      [olderUser, new Date('2026-08-27T09:00:00Z'), newerUser, new Date('2026-08-27T11:00:00Z')]
    )
    await databasePool.query(
      `DELETE FROM schema_migrations
        WHERE version = '010c_legacy_password_security_epoch_backfill'`
    )
    await initDb({ connect: () => databasePool.connect() })
    await databasePool.query(
      `DELETE FROM schema_migrations
        WHERE version = '010c_legacy_password_security_epoch_backfill'`
    )
    await initDb({ connect: () => databasePool.connect() })

    const rows = await databasePool.query<{
      user_id: string
      valid_after: Date
      reason: string
    }>(
      `SELECT user_id::text, valid_after, reason
         FROM external_user_session_security_epochs
        WHERE user_id = ANY($1::uuid[])
        ORDER BY user_id::text`,
      [[nullUser, olderUser, newerUser]]
    )
    const byUser = new Map(rows.rows.map(row => [row.user_id, row]))
    expect(byUser.has(nullUser)).toBe(false)
    expect(byUser.get(olderUser)?.valid_after.toISOString()).toBe(passwordSetAt.toISOString())
    expect(byUser.get(olderUser)?.reason).toBe('historical_password_event')
    expect(byUser.get(newerUser)?.valid_after.toISOString()).toBe(
      new Date('2026-08-27T11:00:00Z').toISOString()
    )
    expect(byUser.get(newerUser)?.reason).toBe('newer')
  })
})
