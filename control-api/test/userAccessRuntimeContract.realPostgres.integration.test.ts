import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import {
  createUserSession,
  renewUserSession,
  revokeUserSession,
} from '../src/services/auth/userSessionService.js'
import { verifyUserSessionV2Token } from '../src/utils/auth/userSessionV2Token.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

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

describeRealPostgres('user-access runtime role contract on real PostgreSQL', () => {
  const database = `control_api_user_access_runtime_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const userId = randomUUID()
  let adminPool: Pool
  let databasePool: Pool

  const runAsControlApiRuntime = async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
    const client = (await databasePool.connect()) as PoolClient
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE control_api_runtime')
      const value = await work(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Runtime Contract User')`,
      [userId, `${userId}@example.test`]
    )
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
        await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('creates, renews, reads, and revokes user sessions as the runtime role', async () => {
    const issued = await runAsControlApiRuntime(db =>
      createUserSession(
        {
          userId,
          email: `${userId}@example.test`,
          authenticationMethods: ['password'],
        },
        { db }
      )
    )
    const issuedClaims = verifyUserSessionV2Token(issued.token)
    expect(issuedClaims).not.toBeNull()

    const renewed = await runAsControlApiRuntime(db =>
      renewUserSession(issuedClaims!, {
        db,
      })
    )
    expect(renewed).toMatchObject({ expiresInSeconds: 60 * 60 })
    if (!('token' in renewed)) throw new Error('runtime renewal did not issue a token')
    const renewedClaims = verifyUserSessionV2Token(renewed.token)
    expect(renewedClaims?.jti).not.toBe(issuedClaims?.jti)

    await expect(
      runAsControlApiRuntime(db =>
        revokeUserSession(userId, renewed.identity.sid, 'runtime_contract', db)
      )
    ).resolves.toBe(true)
    const row = await databasePool.query<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked
         FROM external_user_sessions
        WHERE sid = $1`,
      [renewed.identity.sid]
    )
    expect(row.rows).toEqual([{ revoked: true }])
  })

  it('denies the session tables to unrelated roles and PUBLIC', async () => {
    const publicPrivilege = await databasePool.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_class relation
           CROSS JOIN LATERAL aclexplode(
             COALESCE(relation.relacl, acldefault('r', relation.relowner))
           ) privilege
          WHERE relation.oid = 'public.external_user_sessions'::regclass
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'SELECT'
       ) AS allowed`
    )
    expect(publicPrivilege.rows).toEqual([{ allowed: false }])

    const unrelated = await databasePool.connect()
    try {
      await unrelated.query('BEGIN')
      await unrelated.query('SET LOCAL ROLE workflow_recipes_runtime')
      await expect(unrelated.query('SELECT sid FROM external_user_sessions')).rejects.toMatchObject(
        { code: '42501' }
      )
    } finally {
      await unrelated.query('ROLLBACK')
      unrelated.release()
    }
  })
})
