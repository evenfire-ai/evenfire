import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import { isEntityChangeExternalSessionCurrent } from '../src/routes/external/entityChanges.routes.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { authenticateExternalUserSession } from '../src/services/auth/externalSessionAuthentication.js'
import { issueExternalUserSession } from '../src/services/auth/externalSessionIssuance.js'
import {
  createUserSession,
  renewUserSession,
  revokeAllUserSessions,
  revokeLegacyUserSession,
  revokeUserSession,
} from '../src/services/auth/userSessionService.js'
import type { UserSessionV2Claims } from '../src/utils/auth/userSessionV2Token.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const producerDatabase = vi.hoisted(() => ({
  pool: undefined as Pool | undefined,
  transaction: undefined as (<T>(work: (db: DbClient) => Promise<T>) => Promise<T>) | undefined,
}))

vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  return {
    ...actual,
    pool: {
      query: (text: string, values?: unknown[]) => producerDatabase.pool!.query(text, values),
    },
    withTransaction: <T>(work: (db: DbClient) => Promise<T>) => producerDatabase.transaction!(work),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const
const policy = {
  policyVersion: '1',
  policyRevision: 'currentness-test',
  acceptV1: true,
  issueV1: true,
  acceptV2: true,
  issueV2: true,
  renewV2: true,
  switchCompatibility: true,
  computeCatalogShadow: false,
  serveCatalog: false,
  actionContextV2: false,
  rpcDelegationV2: false,
  desktopAllTeamMode: false,
  profileV2Mode: false,
  minimumClientVersion: null,
  enforceMinimumClient: false,
  advertisedCatalogFamilies: [],
} as EffectiveUserAccessPolicy

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('external stream session currentness on real PostgreSQL', () => {
  const database = `control_api_stream_currentness_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool

  async function createPrincipal(label: string) {
    const userId = randomUUID()
    const teamId = randomUUID()
    const email = `${label}-${userId}@example.test`
    await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, $3)`, [
      userId,
      email,
      label,
    ])
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [teamId, label])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [teamId, userId]
    )
    return { userId, teamId, email }
  }

  async function authenticate(token: string) {
    const result = await authenticateExternalUserSession(token, {
      purpose: 'protected',
      policy,
    })
    if (result.status !== 'authenticated') {
      throw new Error(`test producer failed to authenticate: ${result.status}`)
    }
    return result
  }

  async function transaction<T>(work: (db: DbClient) => Promise<T>): Promise<T> {
    const client = await databasePool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client as unknown as DbClient)
      await client.query('COMMIT')
      return result
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
    producerDatabase.pool = databasePool
    producerDatabase.transaction = transaction
    await initDb({ connect: () => databasePool.connect() })
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

  it('keeps an authenticated V2 stream current above lifecycle generation one', async () => {
    const principal = await createPrincipal('v2-stream-generation')
    await transaction(db => revokeAllUserSessions(principal.userId, 'generation-advance', db))
    const sessionA = await transaction(db =>
      createUserSession(
        {
          userId: principal.userId,
          email: principal.email,
          authenticationMethods: ['pwd'],
        },
        { db }
      )
    )
    const sessionB = await transaction(db =>
      createUserSession(
        {
          userId: principal.userId,
          email: principal.email,
          authenticationMethods: ['pwd'],
        },
        { db }
      )
    )
    const authenticationA = await authenticate(sessionA.token)
    const authenticationB = await authenticate(sessionB.token)
    const generation = await databasePool.query<{ lifecycle_version: number | string }>(
      `SELECT lifecycle_version FROM users WHERE id = $1`,
      [principal.userId]
    )
    expect(Number(generation.rows[0]?.lifecycle_version)).toBeGreaterThan(1)
    expect(authenticationB.contract).toBe('v2')

    const beforeObserve = await databasePool.query<{
      last_used_at: Date
      idle_expires_at: Date
      current_jti: string
      session_version: number
      revoked_at: Date | null
    }>(
      `SELECT last_used_at, idle_expires_at, current_jti, session_version, revoked_at
         FROM external_user_sessions WHERE sid = $1`,
      [sessionB.identity.sid]
    )
    await expect(
      isEntityChangeExternalSessionCurrent(authenticationB as never, { db: databasePool } as never)
    ).resolves.toMatchObject({ status: 'current' })
    const afterObserve = await databasePool.query(
      `SELECT last_used_at, idle_expires_at, current_jti, session_version, revoked_at
         FROM external_user_sessions WHERE sid = $1`,
      [sessionB.identity.sid]
    )
    expect(afterObserve.rows[0]).toEqual(beforeObserve.rows[0])

    await transaction(db =>
      revokeUserSession(principal.userId, sessionA.identity.sid, 'individual_logout', db)
    )
    await expect(
      isEntityChangeExternalSessionCurrent(authenticationA as never, { db: databasePool } as never)
    ).resolves.toMatchObject({ status: 'denied' })
    await expect(
      isEntityChangeExternalSessionCurrent(authenticationB as never, { db: databasePool } as never)
    ).resolves.toMatchObject({ status: 'current' })

    const renewed = await transaction(db =>
      renewUserSession(authenticationB.tokenClaims as UserSessionV2Claims, { db })
    )
    if (!('token' in renewed)) throw new Error('real producer did not renew the V2 session')
    const successor = await authenticate(renewed.token)
    await expect(
      isEntityChangeExternalSessionCurrent(authenticationB as never, { db: databasePool } as never)
    ).resolves.toMatchObject({ status: 'current' })

    await databasePool.query(
      `UPDATE external_user_sessions
          SET prior_jti_expires_at = clock_timestamp() - interval '1 second'
        WHERE sid = $1`,
      [sessionB.identity.sid]
    )
    await expect(
      isEntityChangeExternalSessionCurrent(authenticationB as never, { db: databasePool } as never)
    ).resolves.toMatchObject({ status: 'denied', reason: 'v2_representation_superseded' })
    await expect(
      isEntityChangeExternalSessionCurrent(successor as never, { db: databasePool } as never)
    ).resolves.toMatchObject({ status: 'current' })

    await transaction(db => revokeAllUserSessions(principal.userId, 'revoke_all', db))
    await expect(
      isEntityChangeExternalSessionCurrent(successor as never, { db: databasePool } as never)
    ).resolves.toMatchObject({ status: 'denied' })
  })

  it('keeps a current V1 stream at the new generation and observes fingerprint logout', async () => {
    const principal = await createPrincipal('v1-stream-generation')
    await transaction(db => revokeAllUserSessions(principal.userId, 'generation-advance', db))
    const representation = await transaction(db =>
      issueExternalUserSession(
        {
          contract: 'v1',
          userId: principal.userId,
          email: principal.email,
          teamId: principal.teamId,
          role: 'member',
          authenticationMethods: ['pwd'],
        },
        { db, policy }
      )
    )
    const authentication = await authenticate(representation.token)
    expect(authentication.contract).toBe('v1')
    await expect(
      isEntityChangeExternalSessionCurrent(authentication as never, { db: databasePool } as never)
    ).resolves.toMatchObject({ status: 'current' })
    await transaction(db =>
      revokeLegacyUserSession(
        representation.token,
        authentication.tokenClaims as never,
        'individual_logout',
        db
      )
    )
    await expect(
      isEntityChangeExternalSessionCurrent(authentication as never, { db: databasePool } as never)
    ).resolves.toMatchObject({ status: 'denied', reason: 'legacy_representation_revoked' })
  })

  it('classifies only a database transport failure as unavailable', async () => {
    const principal = await createPrincipal('v2-stream-outage')
    const session = await transaction(db =>
      createUserSession(
        {
          userId: principal.userId,
          email: principal.email,
          authenticationMethods: ['pwd'],
        },
        { db }
      )
    )
    const authentication = await authenticate(session.token)
    const unavailableDb = {
      query: async () => {
        const error = new Error('connection refused') as Error & { code: string }
        error.code = 'ECONNREFUSED'
        throw error
      },
    }
    await expect(
      isEntityChangeExternalSessionCurrent(authentication as never, { db: unavailableDb } as never)
    ).resolves.toMatchObject({ status: 'unavailable' })
  })
})
