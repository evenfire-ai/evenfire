import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { initDb } from '../src/db.js'
import {
  createUserSession,
  validateUserSessionClaims,
} from '../src/services/auth/userSessionService.js'
import { verifyUserSessionV2Token } from '../src/utils/auth/userSessionV2Token.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function waitForBlock(
  databasePool: Pool,
  blockedPid: number,
  blockerPid: number
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await databasePool.query<{ blocked: boolean }>(
      `SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked`,
      [blockedPid, blockerPid]
    )
    if (result.rows[0]?.blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('expected session validation to block on the session row')
}

describeRealPostgres('user-session database clock authority on real PostgreSQL', () => {
  const database = `control_api_session_clock_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const userId = randomUUID()
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Session Clock User')`,
      [userId, `${userId}@example.test`]
    )
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
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      await adminPool.end()
    }
  })

  it('captures expiry time after acquiring the locked session row', async () => {
    const issuer = await databasePool.connect()
    let sid = ''
    let claims: NonNullable<ReturnType<typeof verifyUserSessionV2Token>>
    try {
      await issuer.query('BEGIN')
      const issued = await createUserSession(
        {
          userId,
          email: `${userId}@example.test`,
          authenticationMethods: ['password'],
        },
        { db: issuer }
      )
      await issuer.query('COMMIT')
      sid = issued.identity.sid
      const verified = verifyUserSessionV2Token(issued.token)
      if (!verified) throw new Error('session producer did not issue a V2 token')
      claims = verified
    } catch (error) {
      await issuer.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      issuer.release()
    }

    await databasePool.query(
      `UPDATE external_user_sessions
          SET idle_expires_at = date_trunc('second', clock_timestamp()) + interval '1 second'
        WHERE sid = $1`,
      [sid]
    )

    const blocker = await databasePool.connect()
    const validator = await databasePool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query(`SELECT sid FROM external_user_sessions WHERE sid = $1 FOR UPDATE`, [sid])
      const blockerPid = Number(
        (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      )

      await validator.query('BEGIN')
      const validatorPid = Number(
        (await validator.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      )
      const validation = validateUserSessionClaims(claims, { db: validator })
      await waitForBlock(databasePool, validatorPid, blockerPid)
      await databasePool.query(
        `SELECT pg_sleep(
           GREATEST(
             0,
             EXTRACT(EPOCH FROM (
               (SELECT idle_expires_at FROM external_user_sessions WHERE sid = $1)
               - clock_timestamp()
             )) + 0.25
           )
         )`,
        [sid]
      )
      await blocker.query('COMMIT')

      await expect(validation).resolves.toEqual({ status: 'expired', reason: 'idle_expired' })
      await validator.query('COMMIT')

      const stored = await databasePool.query<{
        revoked_at: Date | null
        last_used_at: Date
        idle_expires_at: Date
      }>(
        `SELECT revoked_at, last_used_at, idle_expires_at
           FROM external_user_sessions
          WHERE sid = $1`,
        [sid]
      )
      expect(stored.rows[0]!.revoked_at).not.toBeNull()
      expect(stored.rows[0]!.revoked_at!.getTime()).toBeGreaterThanOrEqual(
        stored.rows[0]!.idle_expires_at.getTime()
      )
      expect(stored.rows[0]!.last_used_at.getTime()).toBeLessThan(
        stored.rows[0]!.revoked_at!.getTime()
      )
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      await validator.query('ROLLBACK').catch(() => undefined)
      blocker.release()
      validator.release()
    }
  })
})
