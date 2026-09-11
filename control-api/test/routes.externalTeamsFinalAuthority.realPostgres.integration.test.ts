import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { type DbClient, initDb } from '../src/db.js'
import { createExternalMembersRouter } from '../src/routes/external/members.js'
import { createExternalTeamsRouter } from '../src/routes/external/teams.js'
import { issueExternalUserSession } from '../src/services/auth/externalSessionIssuance.js'
import { revokeAllUserSessions } from '../src/services/auth/userSessionService.js'
import {
  acceptInvitationForEmail,
  createManagedInvitationForUser,
} from '../src/services/directory/index.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const producerDatabase = vi.hoisted(() => ({ pool: undefined as Pool | undefined }))
const rateLimit = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
const invitationDelivery = vi.hoisted(() => ({ registerAndSendInvitation: vi.fn() }))
const runtimePolicy = vi.hoisted(() => ({
  policyVersion: '1',
  policyRevision: 'r9-final-team-authority',
  acceptV1: true,
  issueV1: true,
  acceptV2: false,
  issueV2: false,
  renewV2: false,
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
}))

vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  const pool = {
    query: (text: string, values?: unknown[]) => producerDatabase.pool!.query(text, values),
    connect: () => producerDatabase.pool!.connect(),
  }
  const withTransaction = async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
    const client = await producerDatabase.pool!.connect()
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
  return { ...actual, pool, withTransaction }
})
vi.mock('../src/services/rateLimiterService.js', () => rateLimit)
vi.mock('../src/services/invitationFlowRegistrationService.js', () => invitationDelivery)
vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => ({
  resolveEffectiveUserAccessPolicy: vi.fn().mockResolvedValue(runtimePolicy),
}))

type AdminMutation = Readonly<{
  name: string
  expectedStatus?: number
  prepare?: () => Promise<void>
  invoke: (server: express.Express) => request.Test
  assertMutation: () => Promise<void>
  assertNoMutation: () => Promise<void>
}>

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  return result.rows[0]!.pid
}

async function waitForBlockedBy(pool: Pool, blockerPid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity activity
          WHERE activity.datname = current_database()
            AND $1::int = ANY(pg_blocking_pids(activity.pid))
       ) AS blocked`,
      [blockerPid]
    )
    if (result.rows[0]?.blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('expected final team mutation authority to block on user lock')
}

async function retireAdmin(
  db: Pick<Pool | PoolClient, 'query'>,
  userId: string,
  actorId: string
): Promise<void> {
  const operation = await db.query<{ id: string }>(
    `INSERT INTO desktop_user_retirement_operations(
       actor_type,
       actor_control_admin_id,
       target_user_id,
       idempotency_key_hash,
       request_fingerprint,
       reason,
       request_id
     )
     VALUES (
       'control_admin',
       $1::uuid,
       $2::uuid,
       repeat('a', 64),
       repeat('b', 64),
       'final authority race test',
       'r9-h2-final-authority'
     )
     RETURNING id::text AS id`,
    [actorId, userId]
  )
  const operationId = operation.rows[0]!.id
  await db.query(
    `UPDATE users
        SET lifecycle_state = 'retired',
            retired_at = NOW(),
            retirement_reason = 'final authority race test',
            retired_by_type = 'control_admin',
            retired_by_control_admin_id = $3::uuid,
            retirement_request_id = 'r9-h2-final-authority',
            retirement_operation_id = $2::uuid,
            lifecycle_version = lifecycle_version + 1,
            updated_at = NOW()
      WHERE id = $1::uuid`,
    [userId, operationId, actorId]
  )
  await db.query(
    `UPDATE desktop_user_retirement_operations
        SET status = 'completed',
            outcome = 'retired',
            lifecycle_version = 2,
            lifecycle_operation_id = id,
            completed_at = NOW()
      WHERE id = $1::uuid`,
    [operationId]
  )
}

describeRealPostgres('external team mutations final source authority on real PostgreSQL', () => {
  const database = `control_api_team_final_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool
  let retirementActorId: string
  let adminUserId: string
  let targetUserId: string
  let teamId: string
  let token: string
  let invitationId: string
  let invitationEmail: string

  function app() {
    const server = express()
    server.use(express.json())
    server.use(createExternalTeamsRouter({} as never))
    server.use(createExternalMembersRouter())
    return server
  }

  async function resetPrincipal(label: string) {
    adminUserId = randomUUID()
    targetUserId = randomUUID()
    teamId = randomUUID()
    invitationId = ''
    invitationEmail = `${label}-invitee-${randomUUID()}@example.test`
    await databasePool.query(
      `INSERT INTO users(id, email, name, lifecycle_state, lifecycle_version)
       VALUES ($1, $2, 'Admin', 'active', 1),
              ($3, $4, 'Target', 'active', 1)`,
      [
        adminUserId,
        `${label}-${adminUserId}@example.test`,
        targetUserId,
        `${label}-target@example.test`,
      ]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Original')`, [teamId])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'admin', 'active'),
              ($1, $3, 'member', 'active')`,
      [teamId, adminUserId, targetUserId]
    )
    const issued = await issueExternalUserSession(
      {
        contract: 'v1',
        userId: adminUserId,
        email: `${label}-${adminUserId}@example.test`,
        teamId,
        role: 'admin',
        authGeneration: 1,
        authenticationMethods: ['password'],
      },
      { policy: runtimePolicy }
    )
    token = issued.token
  }

  async function prepareInvitation() {
    const result = await createManagedInvitationForUser(
      adminUserId,
      invitationEmail,
      [{ teamId, role: 'member' }],
      'Invitee'
    )
    if ('error' in result) throw new Error(`invitation preparation failed: ${result.error}`)
    invitationId = String(result.invitation.id)
  }

  function mutations(): readonly AdminMutation[] {
    return [
      {
        name: 'team rename',
        invoke: server =>
          request(server).put(`/external/teams/${teamId}/name`).send({ name: 'Renamed' }),
        assertMutation: async () => {
          const result = await databasePool.query<{ name: string }>(
            `SELECT name FROM teams WHERE id = $1`,
            [teamId]
          )
          expect(result.rows[0]?.name).toBe('Renamed')
        },
        assertNoMutation: async () => {
          const result = await databasePool.query<{ name: string }>(
            `SELECT name FROM teams WHERE id = $1`,
            [teamId]
          )
          expect(result.rows[0]?.name).toBe('Original')
        },
      },
      {
        name: 'member role change',
        invoke: server =>
          request(server)
            .patch(`/external/teams/${teamId}/members/${targetUserId}/role`)
            .send({ role: 'inviter' }),
        assertMutation: async () => {
          const result = await databasePool.query<{ role: string }>(
            `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
            [teamId, targetUserId]
          )
          expect(result.rows[0]?.role).toBe('inviter')
        },
        assertNoMutation: async () => {
          const result = await databasePool.query<{ role: string }>(
            `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
            [teamId, targetUserId]
          )
          expect(result.rows[0]?.role).toBe('member')
        },
      },
      {
        name: 'member removal',
        invoke: server =>
          request(server).delete(`/external/teams/${teamId}/members/${targetUserId}`),
        assertMutation: async () => {
          const result = await databasePool.query<{ status: string }>(
            `SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2`,
            [teamId, targetUserId]
          )
          expect(result.rows[0]?.status).toBe('deleted')
        },
        assertNoMutation: async () => {
          const result = await databasePool.query<{ status: string }>(
            `SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2`,
            [teamId, targetUserId]
          )
          expect(result.rows[0]?.status).toBe('active')
        },
      },
      {
        name: 'managed invitation creation',
        expectedStatus: 201,
        invoke: server =>
          request(server)
            .post('/external/members/invitations')
            .send({
              email: invitationEmail,
              name: 'Invitee',
              teams: [{ teamId, role: 'member' }],
            }),
        assertMutation: async () => {
          const result = await databasePool.query<{ status: string }>(
            `SELECT status FROM invitations WHERE email = $1`,
            [invitationEmail]
          )
          expect(result.rows[0]?.status).toBe('pending')
        },
        assertNoMutation: async () => {
          const result = await databasePool.query(`SELECT 1 FROM invitations WHERE email = $1`, [
            invitationEmail,
          ])
          expect(result.rowCount).toBe(0)
        },
      },
      {
        name: 'legacy team invitation creation',
        invoke: server =>
          request(server).post(`/external/teams/${teamId}/invitations`).send({
            email: invitationEmail,
            name: 'Invitee',
            role: 'member',
          }),
        assertMutation: async () => {
          const result = await databasePool.query<{ status: string }>(
            `SELECT status FROM invitations WHERE email = $1`,
            [invitationEmail]
          )
          expect(result.rows[0]?.status).toBe('pending')
        },
        assertNoMutation: async () => {
          const result = await databasePool.query(`SELECT 1 FROM invitations WHERE email = $1`, [
            invitationEmail,
          ])
          expect(result.rowCount).toBe(0)
        },
      },
      {
        name: 'managed invitation resend',
        prepare: prepareInvitation,
        invoke: server =>
          request(server).post(`/external/members/invitations/${invitationId}/resend`),
        assertMutation: async () => {
          const result = await databasePool.query(
            `SELECT 1
               FROM invitation_delivery_commands
              WHERE invitation_id = $1
                AND delivery_kind = 'resend'
                AND status = 'delivered'`,
            [invitationId]
          )
          expect(result.rowCount).toBe(1)
        },
        assertNoMutation: async () => {
          const result = await databasePool.query(
            `SELECT 1
               FROM invitation_delivery_commands
              WHERE invitation_id = $1
                AND delivery_kind = 'resend'`,
            [invitationId]
          )
          expect(result.rowCount).toBe(0)
        },
      },
      {
        name: 'managed invitation revoke',
        prepare: prepareInvitation,
        invoke: server => request(server).delete(`/external/members/invitations/${invitationId}`),
        assertMutation: async () => {
          const result = await databasePool.query<{ status: string }>(
            `SELECT status FROM invitations WHERE id = $1`,
            [invitationId]
          )
          expect(result.rows[0]?.status).toBe('revoked')
        },
        assertNoMutation: async () => {
          const result = await databasePool.query<{ status: string }>(
            `SELECT status FROM invitations WHERE id = $1`,
            [invitationId]
          )
          expect(result.rows[0]?.status).toBe('pending')
        },
      },
      {
        name: 'managed user retirement',
        invoke: server =>
          request(server)
            .delete(`/external/members/${targetUserId}`)
            .set('Idempotency-Key', `retire-${targetUserId}`)
            .send({ reason: 'managed retirement test' }),
        assertMutation: async () => {
          const result = await databasePool.query<{ lifecycle_state: string }>(
            `SELECT lifecycle_state FROM users WHERE id = $1`,
            [targetUserId]
          )
          expect(result.rowCount === 0 || result.rows[0]?.lifecycle_state === 'retired').toBe(true)
        },
        assertNoMutation: async () => {
          const result = await databasePool.query<{ lifecycle_state: string }>(
            `SELECT lifecycle_state FROM users WHERE id = $1`,
            [targetUserId]
          )
          expect(result.rows[0]?.lifecycle_state).toBe('active')
        },
      },
    ]
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    producerDatabase.pool = databasePool
    await initDb({ connect: () => databasePool.connect() })
    retirementActorId = randomUUID()
    await databasePool.query(
      `INSERT INTO control_admin_users(id, username, email, password_hash)
       VALUES ($1, 'r9-h2-retirement-actor', 'r9-h2-retirement-actor@example.test', 'hash')`,
      [retirementActorId]
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
      await adminPool.end()
    }
  })

  beforeEach(() => {
    invitationDelivery.registerAndSendInvitation.mockReset()
    invitationDelivery.registerAndSendInvitation.mockResolvedValue(undefined)
    rateLimit.checkAndIncrement.mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })
  })

  it('denies managed invitation activation when source-session invalidation wins during delivery', async () => {
    await resetPrincipal('managed-invitation-post-delivery-revoke')

    let markDeliveryStarted!: () => void
    const deliveryStarted = new Promise<void>(resolve => {
      markDeliveryStarted = resolve
    })
    let releaseDelivery!: () => void
    const deliveryGate = new Promise<void>(resolve => {
      releaseDelivery = resolve
    })
    invitationDelivery.registerAndSendInvitation.mockImplementationOnce(async () => {
      markDeliveryStarted()
      await deliveryGate
    })

    const pending = request(app())
      .post('/external/members/invitations')
      .set('x-user-session-token', token)
      .send({
        email: invitationEmail,
        name: 'Invitee',
        teams: [{ teamId, role: 'member' }],
      })
      .then(response => response)

    await deliveryStarted
    const draft = await databasePool.query<{ id: string; status: string; token: string }>(
      `SELECT id::text AS id, status, token
         FROM invitations
        WHERE email = $1`,
      [invitationEmail]
    )
    expect(draft.rows[0]?.status).toBe('draft')

    await revokeAllUserSessions(adminUserId, 'test')
    releaseDelivery()

    const response = await pending
    expect(response.status).toBe(403)
    const finalState = await databasePool.query<{ status: string; command_status: string }>(
      `SELECT i.status, c.status AS command_status
         FROM invitations i
         JOIN invitation_delivery_commands c ON c.invitation_id = i.id
        WHERE i.id = $1`,
      [draft.rows[0]!.id]
    )
    expect(finalState.rows[0]).toEqual({ status: 'revoked', command_status: 'cancelled' })
    await expect(
      acceptInvitationForEmail(invitationEmail, draft.rows[0]!.token, draft.rows[0]!.id)
    ).resolves.toEqual({ error: 'not_pending' })
  })

  for (const mutation of mutations()) {
    it(`allows ${mutation.name} before later retirement or revoke-all`, async () => {
      await resetPrincipal(`wins-${mutation.name.replaceAll(' ', '-')}`)
      await mutation.prepare?.()
      const response = await mutation.invoke(app()).set('x-user-session-token', token)
      expect(response.status).toBe(mutation.expectedStatus ?? 200)
      await mutation.assertMutation()
      await retireAdmin(databasePool, adminUserId, retirementActorId)
      await databasePool.query(
        `INSERT INTO external_user_session_security_epochs(user_id, valid_after, reason)
         VALUES ($1, NOW() + INTERVAL '1 second', 'test')
         ON CONFLICT (user_id) DO UPDATE
           SET valid_after = EXCLUDED.valid_after, reason = EXCLUDED.reason`,
        [adminUserId]
      )
    })

    it(`denies ${mutation.name} when retirement wins after admission`, async () => {
      await resetPrincipal(`retire-${mutation.name.replaceAll(' ', '-')}`)
      await mutation.prepare?.()
      const gate = await databasePool.connect()
      try {
        await gate.query('BEGIN')
        await gate.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [adminUserId])
        const gatePid = await backendPid(gate)
        const pending = mutation
          .invoke(app())
          .set('x-user-session-token', token)
          .then(response => response)
        await waitForBlockedBy(databasePool, gatePid)
        await retireAdmin(gate, adminUserId, retirementActorId)
        await gate.query('COMMIT')
        const response = await pending
        expect(response.status).toBe(403)
        await mutation.assertNoMutation()
      } finally {
        await gate.query('ROLLBACK').catch(() => undefined)
        gate.release()
      }
    })

    it(`denies ${mutation.name} when source-session invalidation wins after admission`, async () => {
      await resetPrincipal(`revoke-${mutation.name.replaceAll(' ', '-')}`)
      await mutation.prepare?.()
      const gate = await databasePool.connect()
      try {
        await gate.query('BEGIN')
        await gate.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [adminUserId])
        const gatePid = await backendPid(gate)
        const pending = mutation
          .invoke(app())
          .set('x-user-session-token', token)
          .then(response => response)
        await waitForBlockedBy(databasePool, gatePid)
        await gate.query(
          `INSERT INTO external_user_session_security_epochs(user_id, valid_after, reason)
           VALUES ($1, NOW() + INTERVAL '1 second', 'test')
           ON CONFLICT (user_id) DO UPDATE
             SET valid_after = EXCLUDED.valid_after, reason = EXCLUDED.reason`,
          [adminUserId]
        )
        await gate.query('COMMIT')
        const response = await pending
        expect(response.status).toBe(403)
        await mutation.assertNoMutation()
      } finally {
        await gate.query('ROLLBACK').catch(() => undefined)
        gate.release()
      }
    })
  }
})
