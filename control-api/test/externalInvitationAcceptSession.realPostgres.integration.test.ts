import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { setInvitationPasswordForUser } from '../src/services/directory/membership.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))
const flow = vi.hoisted(() => ({
  validateInvitationFlowToken: vi.fn(),
  storeDesktopAuthorizationToken: vi.fn(),
}))
const accessPolicy = vi.hoisted(() => ({ resolveEffectiveUserAccessPolicy: vi.fn() }))

vi.mock('../src/services/invitationFlowRegistrationService.js', () => flow)
vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => accessPolicy)

vi.mock('../src/db.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/db.js')>()
  const proxy = {
    query: (...args: unknown[]) => (holder.pool.query as Function)(...args),
    connect: () => holder.pool.connect(),
  }
  return {
    ...real,
    pool: proxy,
    rateLimitPool: proxy,
    withTransaction: (
      work: Parameters<typeof real.withTransaction>[0],
      _txPool?: Parameters<typeof real.withTransaction>[1],
      options?: Parameters<typeof real.withTransaction>[2]
    ) => real.withTransaction(work, holder.pool, options),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const policy = {
  policyVersion: '1',
  policyRevision: 'invitation-accept-session-test',
  acceptV1: false,
  issueV1: false,
  acceptV2: true,
  issueV2: true,
  renewV2: true,
  switchCompatibility: false,
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

type InvitationFixture = {
  id: string
  email: string
  flowToken: string
}

type InvitationStateRow = {
  status: string
  accepted_user_id: string | null
  accepted_at: Date | null
}

function app(): express.Express {
  const a = express()
  a.use(express.json())
  a.use(createExternalInvitationsRouter())
  a.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = err instanceof Error ? err.message : 'unknown route failure'
      res.status(500).json({ error: 'Internal Server Error', message })
    }
  )
  return a
}

describeRealPostgres('external invitation acceptance session issuance on real PostgreSQL', () => {
  const database = `control_api_invitation_session_${randomBytes(6).toString('hex')}`
  const flowTokens = new Map<string, { capability: string; email: string }>()
  let adminPool: Pool
  let teamId: string

  async function createInvitation(label: string): Promise<InvitationFixture> {
    const email = `${label}-${randomUUID()}@example.test`
    const capability = `db-token-${randomUUID()}`
    const inserted = await holder.pool.query<{ id: string }>(
      `INSERT INTO invitations(email, role, token, status, purpose, expires_at)
       VALUES ($1, 'member', $2, 'pending', 'member_invitation', NOW() + INTERVAL '1 hour')
       RETURNING id::text AS id`,
      [email, capability]
    )
    const id = inserted.rows[0]!.id
    await holder.pool.query(
      `INSERT INTO invitation_teams(invitation_id, team_id, role)
       VALUES ($1, $2, 'member')`,
      [id, teamId]
    )
    const flowToken = `flow-${randomUUID()}`
    flowTokens.set(flowToken, { capability, email })
    return { id, email, flowToken }
  }

  async function invitationState(invitationId: string): Promise<InvitationStateRow> {
    const result = await holder.pool.query<InvitationStateRow>(
      `SELECT status, accepted_user_id, accepted_at
         FROM invitations
        WHERE id = $1`,
      [invitationId]
    )
    const row = result.rows[0]
    if (!row) throw new Error(`invitation ${invitationId} was not found`)
    return row
  }

  async function activeSessionCount(userId: string): Promise<number> {
    const result = await holder.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM external_user_sessions
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    )
    return result.rows[0]!.count
  }

  async function accept(token: string, email: string) {
    return request(app())
      .post('/external/invitations/accept')
      .send({ email, token, sessionContract: 'v2' })
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const connection = new URL(adminUrl!)
    connection.pathname = `/${database}`
    holder.pool = new Pool({ connectionString: connection.toString() })
    await initDb(holder.pool)
    teamId = randomUUID()
    await holder.pool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Invitation Session Team')`, [
      teamId,
    ])
    accessPolicy.resolveEffectiveUserAccessPolicy.mockResolvedValue(policy)
    flow.validateInvitationFlowToken.mockImplementation(async (token: string) => {
      const fixture = flowTokens.get(token)
      if (!fixture) throw new Error(`invalid invitation flow token ${token}`)
      return { email: fixture.email, invitationUuid: fixture.capability }
    })
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(holder.pool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('issues a session on the first acceptance and none on a replay', async () => {
    const invitation = await createInvitation('replay-session')

    const first = await accept(invitation.flowToken, invitation.email)
    expect(first.status).toBe(200)
    expect(first.body.token).toEqual(expect.any(String))
    expect(first.body.sessionContract).toBe('v2')
    expect(first.body).not.toHaveProperty('replay')
    const userId = String(first.body.userId)
    expect(await activeSessionCount(userId)).toBe(1)

    const firstState = await invitationState(invitation.id)
    expect(firstState.status).toBe('accepted')
    expect(firstState.accepted_user_id).toBe(userId)
    const firstAcceptedAt = firstState.accepted_at
    if (!(firstAcceptedAt instanceof Date)) {
      throw new Error('first acceptance did not record an accepted_at timestamp')
    }

    const replay = await accept(invitation.flowToken, invitation.email)
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ accepted: true, userId, replay: true })
    expect(replay.body).not.toHaveProperty('token')
    expect(replay.body).not.toHaveProperty('sessionContract')
    // The replay proves it read the same accepted row and issued nothing.
    expect(replay.body.acceptedAt).toBe(firstAcceptedAt.toISOString())
    expect(await activeSessionCount(userId)).toBe(1)

    const replayState = await invitationState(invitation.id)
    expect(replayState.accepted_user_id).toBe(userId)
    const replayAcceptedAt = replayState.accepted_at
    if (!(replayAcceptedAt instanceof Date)) {
      throw new Error('replay cleared the accepted_at timestamp')
    }
    expect(replayAcceptedAt.toISOString()).toBe(firstAcceptedAt.toISOString())
  })

  it('does not issue a session on a replay after the owner set a password', async () => {
    const invitation = await createInvitation('replay-after-password')
    const password = 'synthetic-Replay-After-Password-1!'

    const first = await accept(invitation.flowToken, invitation.email)
    expect(first.status).toBe(200)
    expect(first.body.token).toEqual(expect.any(String))
    const userId = String(first.body.userId)
    expect(await activeSessionCount(userId)).toBe(1)

    await expect(
      setInvitationPasswordForUser(userId, invitation.email, invitation.id, password)
    ).resolves.toMatchObject({ data: { passwordUpdated: true } })
    const stored = await holder.pool.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId]
    )
    const passwordHash = stored.rows[0]?.password_hash
    expect(passwordHash).toEqual(expect.any(String))
    await expect(bcrypt.compare(password, passwordHash!)).resolves.toBe(true)
    // Liveness for the replay assertion: the password change revoked the
    // session the first acceptance issued.
    expect(await activeSessionCount(userId)).toBe(0)

    const replay = await accept(invitation.flowToken, invitation.email)
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ accepted: true, userId, replay: true })
    expect(replay.body).not.toHaveProperty('token')
    expect(await activeSessionCount(userId)).toBe(0)
  })
})
