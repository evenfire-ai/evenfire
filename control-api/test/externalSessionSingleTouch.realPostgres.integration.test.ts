import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Request } from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb, pool } from '../src/db.js'
import { workflowTriggerRateLimitCredential } from '../src/routes/workflows/shared/rateLimit.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import {
  authenticateExternalUserSession,
  renewExternalUserSession,
} from '../src/services/auth/externalSessionAuthentication.js'
import { createUserSession } from '../src/services/auth/userSessionService.js'
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

describeRealPostgres('external-session touch ownership on real PostgreSQL', () => {
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
    try {
      corePoolConnectSpy?.mockRestore()
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

  it('touches a V2 session once per authenticated request', async () => {
    const issued = await createUserSession({
      userId,
      email: `${userId}@example.test`,
      authenticationMethods: ['password'],
    })
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
    }

    const authentication = await authenticateExternalUserSession(issued.token, {
      purpose: 'protected',
      policy,
    })
    expect(authentication).toMatchObject({ status: 'authenticated', contract: 'v2' })
    if (authentication.status !== 'authenticated')
      throw new Error('the issued session was rejected')
    expect(
      workflowTriggerRateLimitCredential({
        externalAuth: authentication.claims,
        ip: '203.0.113.10',
        header(name: string) {
          if (name.toLowerCase() === 'authorization') return 'Bearer workflow-service-token'
          if (name.toLowerCase() === 'x-user-session-token') return issued.token
          return undefined
        },
      } as Request)
    ).toBe(`user:${userId}`)

    const touches = await databasePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM session_touch_audit WHERE sid = $1`,
      [issued.identity.sid]
    )
    expect(touches.rows).toEqual([{ count: '1' }])
  })

  it('touches a V2 session once when the request renews it', async () => {
    const issued = await createUserSession({
      userId,
      email: `${userId}@example.test`,
      authenticationMethods: ['password'],
    })
    const policy: EffectiveUserAccessPolicy = {
      policyVersion: '1',
      policyRevision: 'r24-single-touch-renew',
      acceptV1: true,
      issueV1: true,
      acceptV2: true,
      issueV2: true,
      renewV2: true,
      switchCompatibility: true,
      minimumClientVersion: null,
      enforceMinimumClient: false,
    }

    // The renewal route authenticates with purpose 'renew' and then renews.
    const authentication = await authenticateExternalUserSession(issued.token, {
      purpose: 'renew',
      policy,
    })
    expect(authentication).toMatchObject({ status: 'authenticated', contract: 'v2' })
    const renewal = await renewExternalUserSession(issued.token, { policy })
    expect(renewal.status).toBe('renewed')

    const touches = await databasePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM session_touch_audit WHERE sid = $1`,
      [issued.identity.sid]
    )
    expect(touches.rows).toEqual([{ count: '1' }])
  })
})
