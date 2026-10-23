import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { createUserSession } from '../src/services/auth/userSessionService.js'
import {
  acceptInvitationById,
  createSilentInvitationForTeams,
} from '../src/services/directory/index.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))
const accessPolicy = vi.hoisted(() => ({ resolveEffectiveUserAccessPolicy: vi.fn() }))

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

const FIRST_PASSWORD = 'First-Password-Identity-1!'

const policy = {
  policyVersion: '1',
  policyRevision: 'invitation-password-identity-test',
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

type IdentityState = {
  name: string | null
  user_updated_at: Date
  display_name: string | null
  profile_updated_at: Date
}

type AcceptedInvitation = {
  invitationId: string
  userId: string
}

function app(): express.Express {
  const a = express()
  a.set('trust proxy', 1)
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

describeRealPostgres('invitation first-password identity on real PostgreSQL', () => {
  const database = `control_api_invitation_first_password_identity_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let teamId: string

  async function identityState(userId: string): Promise<IdentityState> {
    const result = await holder.pool.query<IdentityState>(
      `SELECT u.name,
              u.updated_at AS user_updated_at,
              p.display_name,
              p.updated_at AS profile_updated_at
         FROM users u
         JOIN profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [userId]
    )
    const state = result.rows[0]
    if (!state) throw new Error(`identity for user ${userId} was not found`)
    return state
  }

  async function inviteAndAccept(email: string, inviteeName: string): Promise<AcceptedInvitation> {
    const invitation = await createSilentInvitationForTeams({
      inviteeName,
      email,
      teamAssignments: [{ teamId, role: 'member' }],
      fallbackRole: 'member',
    })
    const accepted = await acceptInvitationById(email, invitation.id)
    if ('error' in accepted) throw new Error(accepted.error)
    return { invitationId: invitation.id, userId: accepted.data.userId }
  }

  async function setFirstPassword(userId: string, email: string, invitationId: string) {
    const session = await createUserSession({
      userId,
      email,
      authenticationMethods: ['password'],
    })
    return request(app())
      .post('/external/invitations/password')
      .set('x-user-session-token', session.token)
      .send({ userId, email, invitationId, password: FIRST_PASSWORD })
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const connection = new URL(adminUrl!)
    connection.pathname = `/${database}`
    holder.pool = new Pool({ connectionString: connection.toString() })
    await initDb(holder.pool)
    teamId = randomUUID()
    await holder.pool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Identity Team')`, [teamId])
    accessPolicy.resolveEffectiveUserAccessPolicy.mockResolvedValue(policy)
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

  it('keeps an existing users.name and profiles.display_name when setting the first password', async () => {
    const email = `existing-${randomUUID()}@example.test`
    const existingName = 'Existing User Name'
    const existingDisplayName = 'Existing Profile Name'
    const inviteeName = 'Different Invitee Name'

    const inserted = await holder.pool.query<{ id: string }>(
      `INSERT INTO users(email, name) VALUES ($1, $2) RETURNING id`,
      [email, existingName]
    )
    const userId = inserted.rows[0]!.id
    await holder.pool.query(`INSERT INTO profiles(user_id, display_name) VALUES ($1, $2)`, [
      userId,
      existingDisplayName,
    ])

    const { invitationId } = await inviteAndAccept(email, inviteeName)

    // Invitation acceptance resolves the same user through the invitation user
    // helper. Re-pin both identity rows after that setup so the assertion below
    // measures exactly what the first-password call writes (or leaves alone).
    await holder.pool.query(
      `UPDATE users
          SET name = $2,
              updated_at = '2001-01-01T00:00:00Z'
        WHERE id = $1`,
      [userId, existingName]
    )
    await holder.pool.query(
      `UPDATE profiles
          SET display_name = $2,
              updated_at = '2001-01-01T00:00:00Z'
        WHERE user_id = $1`,
      [userId, existingDisplayName]
    )
    const before = await identityState(userId)
    expect(before).toMatchObject({
      name: existingName,
      display_name: existingDisplayName,
    })

    const response = await setFirstPassword(userId, email, invitationId)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ passwordUpdated: true })
    // The owner-decided rule: resolving an existing invitee never renames the
    // user or the profile. The credential write updates users.updated_at by
    // design, so the identity columns and the whole profile row are what must
    // survive unchanged.
    const after = await identityState(userId)
    expect(after.name).toBe(existingName)
    expect(after.display_name).toBe(existingDisplayName)
    expect(after.profile_updated_at).toEqual(before.profile_updated_at)

    const credential = await holder.pool.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId]
    )
    const passwordHash = credential.rows[0]?.password_hash
    if (!passwordHash) throw new Error('first password setup did not store a hash')
    await expect(bcrypt.compare(FIRST_PASSWORD, passwordHash)).resolves.toBe(true)
  })

  it('names a brand-new invitee from invitee_name through the same first-password flow', async () => {
    const email = `new-${randomUUID()}@example.test`
    const inviteeName = 'Brand New Invitee'
    const { invitationId, userId } = await inviteAndAccept(email, inviteeName)

    expect(await identityState(userId)).toMatchObject({
      name: inviteeName,
      display_name: inviteeName,
    })

    const response = await setFirstPassword(userId, email, invitationId)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ passwordUpdated: true })
    expect(await identityState(userId)).toMatchObject({
      name: inviteeName,
      display_name: inviteeName,
    })
  })
})
