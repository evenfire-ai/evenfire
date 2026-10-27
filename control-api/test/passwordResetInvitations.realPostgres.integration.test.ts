import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import {
  createInvitationForTeams,
  createPasswordSetupInvitationForUser,
  createSilentInvitationForTeams,
} from '../src/services/directory/membership.js'
import {
  createPasswordResetInvitation,
  createSilentPasswordResetInvitation,
  requestProfilePasswordReset,
} from '../src/services/directory/passwordResetInvitations.js'
import { retireDesktopUser } from '../src/services/directory/users.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))
const sender = vi.hoisted(() => vi.fn())
vi.mock('../src/services/invitationFlowRegistrationService.js', () => ({
  registerAndSendInvitation: sender,
}))
vi.mock('../src/db.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/db.js')>()
  return {
    ...real,
    pool: { query: (...args: unknown[]) => (holder.pool.query as Function)(...args) },
    withTransaction: (
      work: Parameters<typeof real.withTransaction>[0],
      _pool?: unknown,
      options?: Parameters<typeof real.withTransaction>[2]
    ) => real.withTransaction(work, holder.pool, options),
  }
})
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip
realPg('password reset issuance ownership on PostgreSQL 16', () => {
  const database = `reset_issuance_${randomBytes(6).toString('hex')}`
  let admin: Pool
  let local: Pool
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    local = new Pool({ connectionString: url.toString() })
    holder.pool = local
    await initDb(local)
  }, 60_000)
  beforeEach(() => {
    vi.restoreAllMocks()
    sender.mockReset().mockResolvedValue(undefined)
  })
  afterAll(async () => {
    try {
      vi.restoreAllMocks()
      await endPoolAndWaitForClients(local)
      if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin?.end()
    }
  })
  async function principal() {
    const email = `${randomBytes(8).toString('hex')}@example.invalid`
    const row = (
      await local.query('INSERT INTO users(email,name) VALUES ($1,$2) RETURNING id', [
        email,
        'Captured display name',
      ])
    ).rows[0]
    return { email, id: row.id as string }
  }
  async function rows(email: string) {
    return (
      await local.query('SELECT * FROM invitations WHERE email = $1 ORDER BY created_at', [email])
    ).rows
  }
  async function retire(userId: string) {
    const actor = await principal()
    await retireDesktopUser(
      { kind: 'platform_user', desktopUserId: actor.id },
      userId,
      'Synthetic reset issuance retirement',
      `issuance-${randomBytes(12).toString('hex')}`,
      null,
      { retainWithoutLinkHistory: true }
    )
  }

  it('does not enumerate empty, unknown or retired principals or send mail', async () => {
    const user = await principal()
    await retire(user.id)
    for (const email of ['', `${randomBytes(8).toString('hex')}@example.invalid`, user.email]) {
      expect(await requestProfilePasswordReset(email)).toEqual({ requested: true })
      expect(await rows(email)).toHaveLength(0)
    }
    expect(sender).not.toHaveBeenCalled()
  })

  it('commits the draft before dispatch then activates the exact token with unchanged TTL', async () => {
    const user = await principal()
    sender.mockImplementation(async (email: string, token: string) => {
      const before = await rows(email)
      expect(before).toHaveLength(1)
      expect(before[0]).toMatchObject({
        token,
        status: 'draft',
        purpose: 'password_reset',
        team_id: null,
      })
    })
    expect(await requestProfilePasswordReset(` ${user.email.toUpperCase()} `)).toEqual({
      requested: true,
    })
    const row = (await rows(user.email))[0]
    expect(row).toMatchObject({
      status: 'pending',
      invitee_name: 'Captured display name',
      role: 'member',
    })
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(48 * 60 * 60 * 1000)
    expect(sender).toHaveBeenCalledWith(
      user.email,
      row.token,
      null,
      row.created_at.toISOString(),
      row.expires_at.toISOString(),
      { purpose: 'password_reset', teamNames: [] }
    )
    expect(sender).toHaveBeenCalledTimes(1)
  })

  it('resends password setup as a seven-day member invitation without changing the accepted row', async () => {
    const user = await principal()
    const acceptedExpiry = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000)
    const accepted = await local.query(
      `INSERT INTO invitations
         (email, invitee_name, role, token, status, purpose, accepted_at, accepted_user_id, expires_at)
       VALUES ($1, 'Captured display name', 'member', $2, 'accepted', 'member_invitation', NOW(), $3, $4)
       RETURNING id, expires_at`,
      [user.email, randomBytes(12).toString('hex'), user.id, acceptedExpiry]
    )
    const acceptedRow = accepted.rows[0] as { id: string; expires_at: Date }

    await expect(createPasswordSetupInvitationForUser(user.id)).resolves.toMatchObject({
      sent: true,
      email: user.email,
    })

    const invitationRows = await rows(user.email)
    const resent = invitationRows.find(row => row.id !== acceptedRow.id)
    expect(resent).toMatchObject({ purpose: 'member_invitation', status: 'pending' })
    expect(resent.expires_at.getTime() - resent.created_at.getTime()).toBe(168 * 60 * 60 * 1000)
    expect(invitationRows.find(row => row.id === acceptedRow.id)?.expires_at.getTime()).toBe(
      acceptedRow.expires_at.getTime()
    )
    expect(sender).toHaveBeenCalledWith(
      user.email,
      resent.token,
      null,
      resent.created_at.toISOString(),
      resent.expires_at.toISOString(),
      { purpose: 'member_invitation', teamNames: [] }
    )
  })

  it('uses the same real lock/insert in silent mode without dispatch', async () => {
    const user = await principal()
    const row = await createSilentPasswordResetInvitation({
      email: user.email,
      inviteeName: 'Silent member',
    })
    expect(row).toMatchObject({
      status: 'pending',
      purpose: 'password_reset',
      team_id: null,
      teams: [],
    })
    expect(await rows(user.email)).toHaveLength(1)
    expect(sender).not.toHaveBeenCalled()
  })

  it('propagates send failure and retains only the committed draft', async () => {
    const user = await principal()
    const failure = new Error('synthetic dispatch failure')
    sender.mockRejectedValue(failure)
    await expect(requestProfilePasswordReset(user.email)).rejects.toBe(failure)
    expect((await rows(user.email)).map(row => row.status)).toEqual(['draft'])
    expect(sender).toHaveBeenCalledTimes(1)
  })

  it.each(['delete', 'retire', 'rename'] as const)(
    'preserves the screen-to-lock %s race',
    async transition => {
      const user = await principal()
      const query = local.query.bind(local)
      let changed = false
      vi.spyOn(local, 'query').mockImplementation((async (sql: string, values: unknown[]) => {
        const result = await query(sql, values)
        if (
          !changed &&
          sql.includes('SELECT id, email, name') &&
          sql.includes("lifecycle_state = 'active'")
        ) {
          changed = true
          if (transition === 'delete') await query('DELETE FROM users WHERE id=$1', [user.id])
          if (transition === 'retire') await retire(user.id)
          if (transition === 'rename')
            await query('UPDATE users SET name=$2 WHERE id=$1', [user.id, 'Later display name'])
        }
        return result
      }) as typeof local.query)
      expect(await requestProfilePasswordReset(user.email)).toEqual({ requested: true })
      expect(changed).toBe(true)
      if (transition === 'rename') {
        expect((await rows(user.email))[0]).toMatchObject({
          invitee_name: 'Captured display name',
          status: 'pending',
        })
        expect(sender).toHaveBeenCalledTimes(1)
      } else {
        expect(await rows(user.email)).toHaveLength(0)
        expect(sender).not.toHaveBeenCalled()
      }
    }
  )

  it('does not resurrect a reset draft revoked while dispatch completes', async () => {
    const user = await principal()
    sender.mockImplementation(async (_email: string, token: string) => {
      await local.query("UPDATE invitations SET status='revoked' WHERE token=$1", [token])
    })
    const result = await createPasswordResetInvitation({
      email: user.email,
      inviteeName: 'Synthetic member',
    })
    expect(result.status).toBe('revoked')
    expect((await rows(user.email))[0].status).toBe('revoked')
  })

  it('reports missing activation state rather than swallowing it as unavailable principal', async () => {
    const user = await principal()
    sender.mockImplementation(async (_email: string, token: string) => {
      await local.query('DELETE FROM invitations WHERE token=$1', [token])
    })
    await expect(requestProfilePasswordReset(user.email)).rejects.toThrow(
      'Failed to activate invitation after registration'
    )
  })

  it('does not swallow a real storage failure at the eligibility screen', async () => {
    const user = await principal()
    await local.query('ALTER TABLE users RENAME TO issuance_unavailable_users')
    try {
      await expect(requestProfilePasswordReset(user.email)).rejects.toMatchObject({ code: '42P01' })
    } finally {
      await local.query('ALTER TABLE issuance_unavailable_users RENAME TO users')
    }
    expect(sender).not.toHaveBeenCalled()
  })

  it.each(['member_invitation', 'admin_desktop_access'] as const)(
    'retains generic %s positive controls',
    async purpose => {
      const email = `${randomBytes(8).toString('hex')}@example.invalid`
      const silent = await createSilentInvitationForTeams({
        email,
        inviteeName: 'Generic member',
        purpose,
      })
      expect(silent).toMatchObject({ purpose, status: 'pending' })
      const dispatched = await createInvitationForTeams({
        email,
        inviteeName: 'Generic member',
        purpose,
      })
      expect(dispatched).toMatchObject({ purpose, status: 'pending' })
      expect(sender).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps revoked generic activation a failure while reset owns the special case', async () => {
    const email = `${randomBytes(8).toString('hex')}@example.invalid`
    sender.mockImplementation(async (_email: string, token: string) => {
      await local.query("UPDATE invitations SET status='revoked' WHERE token=$1", [token])
    })
    await expect(
      createInvitationForTeams({ email, inviteeName: 'Generic member' })
    ).rejects.toThrow('Failed to activate invitation after registration')
  })
})
