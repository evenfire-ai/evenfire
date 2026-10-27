import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import {
  acceptInvitation,
  createInvitation,
  createManagedInvitationForUser,
  createPasswordSetupInvitationForUser,
  findMemberRole,
  googleLoginData,
} from '../src/services/directory/index.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({
  pool: null as unknown as Pool,
}))
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
    withTransaction: (fn: Parameters<typeof real.withTransaction>[0]) =>
      real.withTransaction(fn, holder.pool),
  }
})

vi.mock('../src/services/invitationFlowRegistrationService.js', () => ({
  registerAndSendInvitation: vi.fn(async () => undefined),
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip

realPg('team role authority on real PostgreSQL', () => {
  const database = `team_role_${randomBytes(6).toString('hex')}`
  const email = 'member@example.invalid'
  let admin: Pool
  let teamId: string
  let otherTeamId: string
  let userId: string

  async function memberRole(team: string) {
    const result = await holder.pool.query(
      'SELECT role, status FROM team_members WHERE team_id = $1 AND user_id = $2',
      [team, userId]
    )
    return result.rows[0] as { role: string; status: string } | undefined
  }

  async function acceptedInvitation(team: string, role: string) {
    await holder.pool.query(
      `INSERT INTO invitations(team_id, email, role, status, accepted_user_id, accepted_at)
       VALUES ($1, $2, $3, 'accepted', $4, NOW())`,
      [team, email, role, userId]
    )
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    holder.pool = new Pool({ connectionString: url.toString() })
    await initDb(holder.pool)
  }, 60_000)

  beforeEach(async () => {
    await holder.pool.query('DELETE FROM team_members')
    await holder.pool.query('DELETE FROM invitations')
    await holder.pool.query('DELETE FROM teams')
    await holder.pool.query('DELETE FROM profiles')
    await holder.pool.query('DELETE FROM users')
    userId = (await holder.pool.query('INSERT INTO users(email) VALUES ($1) RETURNING id', [email]))
      .rows[0].id
    teamId = (await holder.pool.query("INSERT INTO teams(name) VALUES ('Core') RETURNING id"))
      .rows[0].id
    otherTeamId = (await holder.pool.query("INSERT INTO teams(name) VALUES ('Ops') RETURNING id"))
      .rows[0].id
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(holder.pool)
      if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin?.end()
    }
  })

  describe('login membership repair', () => {
    it('keeps a role changed after the invitation was accepted', async () => {
      await acceptedInvitation(teamId, 'admin')
      await holder.pool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'inviter', 'active')`,
        [teamId, userId]
      )

      await googleLoginData({ email })

      expect(await memberRole(teamId)).toEqual({ role: 'inviter', status: 'active' })
    })

    it('restores a missing membership from an accepted invitation', async () => {
      await acceptedInvitation(teamId, 'member')

      await googleLoginData({ email })

      expect(await memberRole(teamId)).toEqual({ role: 'member', status: 'active' })
    })

    it('does not restore a removed membership', async () => {
      await acceptedInvitation(teamId, 'admin')
      await holder.pool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'admin', 'deleted')`,
        [teamId, userId]
      )

      await googleLoginData({ email })

      expect(await memberRole(teamId)).toEqual({ role: 'admin', status: 'deleted' })
    })
  })

  describe('findMemberRole', () => {
    it('returns the role of an active membership', async () => {
      await holder.pool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'inviter', 'active')`,
        [teamId, userId]
      )

      await expect(findMemberRole(teamId, userId)).resolves.toEqual({ role: 'inviter' })
    })

    it('returns null for a removed membership', async () => {
      await holder.pool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'admin', 'deleted')`,
        [teamId, userId]
      )

      await expect(findMemberRole(teamId, userId)).resolves.toBeNull()
    })

    it('does not use a membership on another team', async () => {
      await holder.pool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`,
        [otherTeamId, userId]
      )

      await expect(findMemberRole(teamId, userId)).resolves.toBeNull()
    })
  })

  describe('password setup invitation', () => {
    async function acceptPasswordSetup() {
      const created = await createPasswordSetupInvitationForUser(userId)
      if (!('id' in created)) throw new Error(`password setup failed: ${created.error}`)
      const accepted = await acceptInvitation(userId, email, '', created.id)
      expect(accepted).not.toHaveProperty('error')
    }

    it('keeps a role changed after the original invitation was accepted', async () => {
      await acceptedInvitation(teamId, 'admin')
      await holder.pool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'inviter', 'active')`,
        [teamId, userId]
      )

      await acceptPasswordSetup()

      expect(await memberRole(teamId)).toEqual({ role: 'inviter', status: 'active' })
    })

    it('reissues the invitation without a team or the original role', async () => {
      await acceptedInvitation(teamId, 'admin')

      const created = await createPasswordSetupInvitationForUser(userId)
      if (!('id' in created)) throw new Error(`password setup failed: ${created.error}`)

      const invitation = await holder.pool.query(
        'SELECT team_id, role FROM invitations WHERE id = $1',
        [created.id]
      )
      const teams = await holder.pool.query(
        'SELECT team_id FROM invitation_teams WHERE invitation_id = $1',
        [created.id]
      )
      expect(invitation.rows[0]).toEqual({ team_id: null, role: 'member' })
      expect(teams.rows).toEqual([])
    })

    it('does not restore a removed membership', async () => {
      await acceptedInvitation(teamId, 'admin')
      await holder.pool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'admin', 'deleted')`,
        [teamId, userId]
      )

      await acceptPasswordSetup()

      expect(await memberRole(teamId)).toEqual({ role: 'admin', status: 'deleted' })
    })
  })

  describe('managed invitation name', () => {
    const inviteeEmail = 'invitee@example.invalid'

    async function seedInvitee(name: string | null) {
      const inviteeId = (
        await holder.pool.query('INSERT INTO users(email, name) VALUES ($1, $2) RETURNING id', [
          inviteeEmail,
          name,
        ])
      ).rows[0].id as string
      await holder.pool.query('INSERT INTO profiles(user_id, display_name) VALUES ($1, $2)', [
        inviteeId,
        name,
      ])
      return inviteeId
    }

    async function inviteeName() {
      const result = await holder.pool.query(
        `SELECT u.name, p.display_name
           FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
          WHERE u.email = $1`,
        [inviteeEmail]
      )
      return result.rows[0] as { name: string | null; display_name: string | null } | undefined
    }

    async function invite(name: string) {
      await holder.pool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'inviter', 'active')`,
        [teamId, userId]
      )
      const created = await createManagedInvitationForUser(
        userId,
        inviteeEmail,
        [{ teamId, role: 'member' }],
        name
      )
      if (!('invitation' in created)) throw new Error(`invitation failed: ${created.error}`)
      return created.invitation
    }

    it('does not change an existing account name when the invitation is created', async () => {
      await seedInvitee('Original Name')

      await invite('Chosen By Inviter')

      expect(await inviteeName()).toEqual({
        name: 'Original Name',
        display_name: 'Original Name',
      })
    })

    it('does not change an existing account name when the invitation is accepted', async () => {
      const inviteeId = await seedInvitee('Original Name')
      const invitation = await invite('Chosen By Inviter')

      const accepted = await acceptInvitation(inviteeId, inviteeEmail, '', invitation.id)

      expect(accepted).not.toHaveProperty('error')
      expect(await inviteeName()).toEqual({
        name: 'Original Name',
        display_name: 'Original Name',
      })
    })

    it('fills in a missing account name when the invitation is accepted', async () => {
      const inviteeId = await seedInvitee(null)
      const invitation = await invite('Chosen By Inviter')

      await acceptInvitation(inviteeId, inviteeEmail, '', invitation.id)

      expect(await inviteeName()).toEqual({
        name: 'Chosen By Inviter',
        display_name: 'Chosen By Inviter',
      })
    })

    it('names a new account from the invitation', async () => {
      const invitation = await invite('Chosen By Inviter')
      const inviteeId = (
        await holder.pool.query('INSERT INTO users(email) VALUES ($1) RETURNING id', [inviteeEmail])
      ).rows[0].id as string

      await acceptInvitation(inviteeId, inviteeEmail, '', invitation.id)

      expect(await inviteeName()).toEqual({
        name: 'Chosen By Inviter',
        display_name: 'Chosen By Inviter',
      })
    })
  })

  describe('invitation acceptance', () => {
    async function inviteAndAccept(role: 'admin' | 'inviter' | 'member') {
      const invitation = await createInvitation(teamId, 'Member', email, role)
      const accepted = await acceptInvitation(userId, email, '', invitation.id)
      expect(accepted).not.toHaveProperty('error')
    }

    it('does not lower the role of an active member', async () => {
      await holder.pool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`,
        [teamId, userId]
      )

      await inviteAndAccept('member')

      expect(await memberRole(teamId)).toEqual({ role: 'admin', status: 'active' })
    })

    it('does not lower an active inviter to member', async () => {
      await holder.pool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'inviter', 'active')`,
        [teamId, userId]
      )

      await inviteAndAccept('member')

      expect(await memberRole(teamId)).toEqual({ role: 'inviter', status: 'active' })
    })

    it('raises an active member to a higher invited role', async () => {
      await holder.pool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`,
        [teamId, userId]
      )

      await inviteAndAccept('inviter')

      expect(await memberRole(teamId)).toEqual({ role: 'inviter', status: 'active' })
    })

    it('re-adds a removed member with the invited role', async () => {
      await holder.pool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'admin', 'deleted')`,
        [teamId, userId]
      )

      await inviteAndAccept('inviter')

      expect(await memberRole(teamId)).toEqual({ role: 'inviter', status: 'active' })
    })

    it('adds a new member with the invited role', async () => {
      await inviteAndAccept('inviter')

      expect(await memberRole(teamId)).toEqual({ role: 'inviter', status: 'active' })
    })
  })
})
