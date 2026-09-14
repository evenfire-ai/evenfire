import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb, pool } from '../src/db.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import {
  authenticateExternalUserSession,
  authenticateExternalUserSessionIdentity,
} from '../src/services/auth/externalSessionAuthentication.js'
import { createUserSession } from '../src/services/auth/userSessionService.js'

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

describeRealPostgres('external-session staged touch ownership on real PostgreSQL', () => {
  const database = `control_api_session_touch_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const userId = randomUUID()
  let adminPool: Pool
  let databasePool: Pool
  let corePoolConnectSpy: ReturnType<typeof vi.spyOn>

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    corePoolConnectSpy = vi
      .spyOn(pool, 'connect')
      .mockImplementation((() => databasePool.connect()) as typeof pool.connect)
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Session Touch User')`,
      [userId, `${userId}@example.test`]
    )
    await databasePool.query(`CREATE TABLE session_touch_audit(sid uuid NOT NULL)`)
    await databasePool.query(`
      CREATE FUNCTION record_session_touch()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        INSERT INTO session_touch_audit(sid) VALUES (NEW.sid);
        RETURN NEW;
      END
      $$
    `)
    await databasePool.query(`
      CREATE TRIGGER session_touch_audit_trigger
      AFTER UPDATE OF last_used_at, idle_expires_at ON external_user_sessions
      FOR EACH ROW EXECUTE FUNCTION record_session_touch()
    `)
  })

  afterAll(async () => {
    corePoolConnectSpy?.mockRestore()
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

  it('touches a V2 session once after authenticated limiter identity is established', async () => {
    const issued = await createUserSession({
      userId,
      email: `${userId}@example.test`,
      authenticationMethods: ['password'],
    })

    const identity = await authenticateExternalUserSessionIdentity(issued.token)
    expect(identity.status).toBe('authenticated')
    if (identity.status !== 'authenticated') throw new Error('Stage A rejected the issued session')

    const policy: EffectiveUserAccessPolicy = {
      policyVersion: '1',
      policyRevision: 'r24-single-touch',
      acceptV1: true,
      issueV1: true,
      acceptV2: true,
      issueV2: true,
      renewV2: true,
      switchCompatibility: true,
      minimumClientVersion: null,
      enforceMinimumClient: false,
      catalogMode: 'off',
      serveCatalog: false,
      shadowCatalog: false,
      actionContextV2: true,
    }
    await expect(
      authenticateExternalUserSession(issued.token, {
        purpose: 'protected',
        policy,
        identity,
      })
    ).resolves.toMatchObject({ status: 'authenticated' })

    const touches = await databasePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM session_touch_audit WHERE sid = $1`,
      [issued.identity.sid]
    )
    expect(touches.rows).toEqual([{ count: '1' }])
  })
})
