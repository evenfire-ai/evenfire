import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import { createAdminAuthRouter } from '../src/routes/admin/auth.js'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { createControlAdminInvitation } from '../src/services/adminAuthService.js'
import { authenticateExternalUserSession } from '../src/services/auth/externalSessionAuthentication.js'
import { createUserSession } from '../src/services/auth/userSessionService.js'
import {
  acceptInvitationById,
  createSilentInvitationForTeams,
  createSilentPasswordResetInvitation,
  setInvitationPasswordForUser,
} from '../src/services/directory/index.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))
const accessPolicy = vi.hoisted(() => ({ resolveEffectiveUserAccessPolicy: vi.fn() }))
const registration = vi.hoisted(() => ({
  validateControlAdminInvitationToken: vi.fn(),
}))

vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => accessPolicy)

vi.mock('../src/services/controlAdminInvitationRegistrationService.js', async importOriginal => {
  const real =
    await importOriginal<
      typeof import('../src/services/controlAdminInvitationRegistrationService.js')
    >()
  return {
    ...real,
    validateControlAdminInvitationToken: registration.validateControlAdminInvitationToken,
  }
})

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
  policyRevision: 'invitation-password-first-set-test',
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

type StoredUser = {
  id: string
  password_hash: string | null
  lifecycle_version: string | number
  password_set_at: Date | null
}

type InvitationState = {
  status: string
  accepted_user_id: string | null
  accepted_at: Date | null
}

type MemberFixture = {
  email: string
  invitationId: string
  userId: string
}

type ControlAdminPair = {
  email: string
  adminInvitationId: string
  desktopInvitationId: string
}

function app(): express.Express {
  const a = express()
  a.set('trust proxy', 1)
  a.use(express.json())
  a.use(createExternalInvitationsRouter())
  a.use(createAdminAuthRouter())
  a.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = err instanceof Error ? err.message : 'unknown route failure'
      res.status(500).json({ error: 'Internal Server Error', message })
    }
  )
  return a
}

describeRealPostgres('external invitation password setup on real PostgreSQL', () => {
  const database = `control_api_invitation_password_first_set_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let teamId: string

  async function storedUser(email: string): Promise<StoredUser> {
    const result = await holder.pool.query<StoredUser>(
      `SELECT id, password_hash, lifecycle_version, password_set_at
         FROM users
        WHERE email = $1`,
      [email]
    )
    const user = result.rows[0]
    if (!user) throw new Error(`user ${email} was not created`)
    return user
  }

  async function invitationState(invitationId: string): Promise<InvitationState> {
    const result = await holder.pool.query<InvitationState>(
      `SELECT status, accepted_user_id, accepted_at
         FROM invitations
        WHERE id = $1`,
      [invitationId]
    )
    const state = result.rows[0]
    if (!state) throw new Error(`invitation ${invitationId} was not found`)
    return state
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

  async function profileState(userId: string): Promise<{
    name: string | null
    user_updated_at: Date
    display_name: string | null
    profile_updated_at: Date
  }> {
    const result = await holder.pool.query<{
      name: string | null
      user_updated_at: Date
      display_name: string | null
      profile_updated_at: Date
    }>(
      `SELECT u.name,
              u.updated_at AS user_updated_at,
              p.display_name,
              p.updated_at AS profile_updated_at
         FROM users u
         JOIN profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [userId]
    )
    const snapshot = result.rows[0]
    if (!snapshot) throw new Error(`profile for user ${userId} was not found`)
    return snapshot
  }

  async function acceptedMember(label: string): Promise<MemberFixture> {
    const email = `${label}-${randomUUID()}@example.test`
    const invitation = await createSilentInvitationForTeams({
      inviteeName: email,
      email,
      teamAssignments: [{ teamId, role: 'member' }],
      fallbackRole: 'member',
    })
    const accepted = await acceptInvitationById(email, invitation.id)
    if ('error' in accepted) throw new Error(accepted.error)
    return { email, invitationId: invitation.id, userId: accepted.data.userId }
  }

  async function seedControlAdmin(label: string): Promise<string> {
    const id = randomUUID()
    const username = `${label}-${id.slice(0, 8)}`
    await holder.pool.query(
      `INSERT INTO control_admin_users (id, username, email, password_hash, role, status, session_version)
       VALUES ($1, $2, $3, 'real-pg-inviter-hash', 'admin', 'active', 1)`,
      [id, username, `${username}@example.test`]
    )
    return id
  }

  async function controlAdminPair(label: string): Promise<ControlAdminPair> {
    const email = `${label}-${randomUUID()}@example.test`
    const inviterId = await seedControlAdmin(`${label}-inviter`)
    const adminInvitation = await createControlAdminInvitation(email, inviterId)
    if ('error' in adminInvitation) throw new Error(adminInvitation.error)
    const desktopInvitation = await createSilentInvitationForTeams({
      inviteeName: email,
      email,
      teamAssignments: [],
      fallbackRole: 'member',
      purpose: 'admin_desktop_access',
    })
    return {
      email,
      adminInvitationId: adminInvitation.id,
      desktopInvitationId: desktopInvitation.id,
    }
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const connection = new URL(adminUrl!)
    connection.pathname = `/${database}`
    holder.pool = new Pool({ connectionString: connection.toString() })
    await initDb(holder.pool)
    teamId = randomUUID()
    await holder.pool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Password Setup Team')`, [
      teamId,
    ])
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

  it('sets the first password and refuses the second without any credential or profile write', async () => {
    const member = await acceptedMember('first-password')
    const firstPassword = 'First-Member-Password-1!'
    const secondPassword = 'Second-Member-Password-2!'

    const firstSession = await createUserSession({
      userId: member.userId,
      email: member.email,
      authenticationMethods: ['password'],
    })
    const first = await request(app())
      .post('/external/invitations/password')
      .set('x-user-session-token', firstSession.token)
      .send({
        userId: member.userId,
        email: member.email,
        invitationId: member.invitationId,
        password: firstPassword,
      })

    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ passwordUpdated: true })

    // Liveness witness for the refusal below: this route can write a verifiable
    // bcrypt hash for a passwordless invited user.
    const afterFirst = await storedUser(member.email)
    const firstHash = afterFirst.password_hash
    if (!firstHash) throw new Error('first password setup did not store a hash')
    await expect(bcrypt.compare(firstPassword, firstHash)).resolves.toBe(true)

    // The successful first set revokes the session it was called with. An
    // existing session created afterwards is the credential the refusal must
    // leave untouched.
    const existingSession = await createUserSession({
      userId: member.userId,
      email: member.email,
      authenticationMethods: ['password'],
    })
    // A refused call must not overwrite user-chosen identity fields either.
    // The first-password path resolves the invitee through the invitation user
    // helper, which must leave an existing users.name and profiles.display_name
    // untouched; pin both rows to recognizable values before the refusal and
    // require them to survive it byte-identically.
    await holder.pool.query(
      `UPDATE users
          SET name = 'User selected name',
              updated_at = '2001-01-01T00:00:00Z'
        WHERE id = $1`,
      [member.userId]
    )
    await holder.pool.query(
      `UPDATE profiles
          SET display_name = 'User selected profile',
              updated_at = '2001-01-01T00:00:00Z'
        WHERE user_id = $1`,
      [member.userId]
    )
    const profileBeforeRefusal = await profileState(member.userId)
    expect(profileBeforeRefusal).toMatchObject({
      name: 'User selected name',
      display_name: 'User selected profile',
    })

    const beforeRefusal = await storedUser(member.email)
    const invitationBefore = await invitationState(member.invitationId)
    const sessionsBefore = await activeSessionCount(member.userId)
    expect(sessionsBefore).toBe(1)
    await expect(
      authenticateExternalUserSession(existingSession.token, {
        purpose: 'protected',
        policy,
      })
    ).resolves.toMatchObject({ status: 'authenticated' })

    const second = await request(app())
      .post('/external/invitations/password')
      .set('x-user-session-token', existingSession.token)
      .send({
        userId: member.userId,
        email: member.email,
        invitationId: member.invitationId,
        password: secondPassword,
      })

    expect(second.status).toBe(409)
    expect(second.body).toEqual({ error: 'password_already_set' })
    expect(second.headers['set-cookie']).toBeUndefined()

    // users.name, users.updated_at, profiles.display_name and
    // profiles.updated_at all survive the refusal unchanged.
    expect(await profileState(member.userId)).toEqual(profileBeforeRefusal)

    const afterRefusal = await storedUser(member.email)
    expect(afterRefusal.id).toBe(beforeRefusal.id)
    expect(afterRefusal.password_hash).toBe(beforeRefusal.password_hash)
    expect(String(afterRefusal.lifecycle_version)).toBe(String(beforeRefusal.lifecycle_version))
    expect(afterRefusal.password_set_at?.toISOString()).toBe(
      beforeRefusal.password_set_at?.toISOString()
    )
    await expect(bcrypt.compare(firstPassword, afterRefusal.password_hash!)).resolves.toBe(true)
    await expect(bcrypt.compare(secondPassword, afterRefusal.password_hash!)).resolves.toBe(false)

    // No invitation change and no session revocation on the refused call.
    expect(await invitationState(member.invitationId)).toEqual(invitationBefore)
    expect(await activeSessionCount(member.userId)).toBe(sessionsBefore)
    const sessionRow = await holder.pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM external_user_sessions WHERE sid = $1`,
      [existingSession.identity.sid]
    )
    expect(sessionRow.rows[0]?.revoked_at).toBeNull()
    await expect(
      authenticateExternalUserSession(existingSession.token, {
        purpose: 'protected',
        policy,
      })
    ).resolves.toMatchObject({
      status: 'authenticated',
      claims: { userId: member.userId },
    })
  })

  it('sets the Desktop password on the admin finalization first acceptance', async () => {
    const pair = await controlAdminPair('admin-first-accept')
    const adminPassword = 'Admin-Completion-1!'
    const memberPassword = 'Desktop-Completion-1!'
    registration.validateControlAdminInvitationToken.mockResolvedValueOnce({
      email: pair.email,
      invitationUuid: pair.adminInvitationId,
    })

    const response = await request(app())
      .post('/admin/auth/control-admin-invitations/complete')
      .send({
        token: 'synthetic-control-admin-flow-token',
        email: pair.email,
        username: `invitee-${randomUUID().slice(0, 8)}`,
        password: adminPassword,
        useSameMemberPassword: false,
        memberPassword,
      })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      completed: true,
      desktopAccessCompleted: true,
      login: { username: pair.email },
    })
    const user = await storedUser(pair.email)
    const hash = user.password_hash
    if (!hash) throw new Error('first acceptance did not store a Desktop password')
    await expect(bcrypt.compare(memberPassword, hash)).resolves.toBe(true)
    await expect(bcrypt.compare(adminPassword, hash)).resolves.toBe(false)
    expect(await invitationState(pair.desktopInvitationId)).toMatchObject({
      status: 'accepted',
      accepted_user_id: user.id,
    })
  })

  it('keeps the password-reset branch writable when the external option is set', async () => {
    const email = `reset-branch-${randomUUID()}@example.test`
    const previousPassword = 'Previous-Reset-Password-1!'
    const nextPassword = 'Next-Reset-Password-2!'
    const inserted = await holder.pool.query<{ id: string }>(
      `INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id`,
      [email, await bcrypt.hash(previousPassword, 12)]
    )
    const userId = inserted.rows[0]!.id
    const invitation = await createSilentPasswordResetInvitation({ email, inviteeName: email })

    const result = await setInvitationPasswordForUser(
      userId,
      email,
      invitation.id,
      nextPassword,
      undefined,
      { rejectIfPasswordAlreadySet: true }
    )

    expect(result).toMatchObject({ data: { passwordUpdated: true } })
    const stored = await storedUser(email)
    await expect(bcrypt.compare(nextPassword, stored.password_hash!)).resolves.toBe(true)
    await expect(bcrypt.compare(previousPassword, stored.password_hash!)).resolves.toBe(false)
    expect(await invitationState(invitation.id)).toMatchObject({
      status: 'accepted',
      accepted_user_id: userId,
    })
  })
})
