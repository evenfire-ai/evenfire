import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { type DbTransactionClient, type DbTransactionOptions, initDb } from '../src/db.js'
import {
  acceptInvitationForEmail,
  createInvitationForTeams,
  requestProfilePasswordReset,
  setInvitationPasswordForEmail,
  setInvitationPasswordForUser,
} from '../src/services/directory/membership.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const producerDatabase = vi.hoisted(() => ({ pool: undefined as Pool | undefined }))
const registration = vi.hoisted(() => ({ registerAndSendInvitation: vi.fn() }))
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  const pool = {
    query: (text: string, values?: unknown[]) => producerDatabase.pool!.query(text, values),
  }
  const withTransaction = <T>(
    work: (db: DbTransactionClient) => Promise<T>,
    _txPool?: Pool,
    options: DbTransactionOptions = {}
  ): Promise<T> => {
    return actual.withTransaction(work, producerDatabase.pool!, options)
  }
  return { ...actual, pool, withTransaction }
})

vi.mock('../src/services/invitationFlowRegistrationService.js', () => registration)

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('accepted onboarding expiry on real PostgreSQL', () => {
  const database = `control_api_accepted_onboarding_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool
  let teamId: string

  async function createPending(
    purpose: 'member_invitation' | 'admin_desktop_access' | 'password_reset',
    label: string
  ) {
    const email = `${label}-${randomUUID()}@example.test`
    const invitation = await createInvitationForTeams({
      inviteeName: label,
      email,
      purpose,
      teamAssignments:
        purpose === 'password_reset'
          ? []
          : [{ teamId, role: purpose === 'admin_desktop_access' ? 'admin' : 'member' }],
      fallbackRole: purpose === 'admin_desktop_access' ? 'admin' : 'member',
    })
    return {
      id: String(invitation.id),
      token: String(invitation.token),
      email,
    }
  }

  async function storedPasswordHash(userId: string): Promise<string | null> {
    const stored = await databasePool.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId]
    )
    const row = stored.rows[0]
    if (!row) throw new Error(`password hash read did not return user ${userId}`)
    return row.password_hash
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    producerDatabase.pool = databasePool
    registration.registerAndSendInvitation.mockResolvedValue(undefined)
    await initDb({ connect: () => databasePool.connect() })
    teamId = randomUUID()
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Onboarding Team')`, [teamId])
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

  it('keeps an expired pending onboarding capability unusable', async () => {
    const invitation = await createPending('member_invitation', 'expired-pending')
    await databasePool.query(
      `UPDATE invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [invitation.id]
    )

    await expect(
      acceptInvitationForEmail(invitation.email, invitation.token, invitation.id)
    ).resolves.toEqual({ error: 'expired' })
  })

  it.each(['member_invitation', 'admin_desktop_access'] as const)(
    'allows accepted %s onboarding to finish password setup after the original TTL',
    async purpose => {
      const invitation = await createPending(purpose, `accepted-${purpose}`)
      const accepted = await acceptInvitationForEmail(
        invitation.email,
        invitation.token,
        invitation.id
      )
      expect(accepted).toMatchObject({ data: { accepted: true, userId: expect.any(String) } })
      if (!('data' in accepted)) throw new Error('producer did not accept onboarding invitation')
      const userId = String(accepted.data.userId)

      await databasePool.query(
        `UPDATE invitations
            SET accepted_at = NOW() - INTERVAL '2 hours',
                expires_at = NOW() - INTERVAL '1 hour'
          WHERE id = $1`,
        [invitation.id]
      )

      await expect(
        setInvitationPasswordForUser(
          userId,
          invitation.email,
          invitation.id,
          'Accepted-Onboarding-Password-1!'
        )
      ).resolves.toMatchObject({ data: { passwordUpdated: true, status: 'accepted' } })

      await expect(
        acceptInvitationForEmail(invitation.email, invitation.token, invitation.id)
      ).resolves.toMatchObject({
        data: { accepted: true, userId, status: 'accepted', replay: true },
      })

      const passwordBeforeRejection = await storedPasswordHash(userId)
      expect(passwordBeforeRejection).toEqual(expect.any(String))

      // Same setter, real invitation id: a member invitation is not a
      // password-reset capability, so the reset path must refuse before it
      // writes anything for this user.
      await expect(
        setInvitationPasswordForEmail(invitation.email, invitation.id, 'Replay-Password-1!', userId)
      ).resolves.toEqual({ error: 'not_found' })
      await expect(storedPasswordHash(userId)).resolves.toBe(passwordBeforeRejection)

      // Positive witness for the same setter: a real password-reset invitation
      // for this user changes the hash, proving the refusal above is not an
      // unreachable path that can never write.
      await requestProfilePasswordReset(invitation.email)
      const resetInvitation = await databasePool.query<{ id: string }>(
        `SELECT id::text AS id
           FROM invitations
          WHERE email = $1 AND purpose = 'password_reset'
          ORDER BY created_at DESC
          LIMIT 1`,
        [invitation.email]
      )
      const resetInvitationId = resetInvitation.rows[0]?.id
      if (!resetInvitationId) throw new Error('password-reset witness invitation was not created')
      await expect(
        setInvitationPasswordForEmail(
          invitation.email,
          resetInvitationId,
          'Witness-Password-1!',
          userId
        )
      ).resolves.toMatchObject({ data: { passwordUpdated: true } })
      await expect(storedPasswordHash(userId)).resolves.not.toBe(passwordBeforeRejection)
    }
  )

  it('keeps expired password-reset capabilities unusable', async () => {
    const userId = randomUUID()
    const email = `expired-reset-${userId}@example.test`
    const originalHash = await bcrypt.hash('Original-Password-1!', 12)
    await databasePool.query(
      `INSERT INTO users(id, email, name, password_hash) VALUES ($1, $2, 'Reset User', $3)`,
      [userId, email, originalHash]
    )
    await requestProfilePasswordReset(email)
    const produced = await databasePool.query<{ id: string }>(
      `SELECT id::text AS id
         FROM invitations
        WHERE email = $1
          AND purpose = 'password_reset'
        ORDER BY created_at DESC
        LIMIT 1`,
      [email]
    )
    const invitationId = produced.rows[0]!.id
    await databasePool.query(
      `UPDATE invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [invitationId]
    )

    await expect(
      setInvitationPasswordForUser(userId, email, invitationId, 'Replacement-Password-1!')
    ).resolves.toEqual({ error: 'expired' })
    const stored = await databasePool.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId]
    )
    expect(stored.rows[0]?.password_hash).toBe(originalHash)
  })

  it('preserves normal within-TTL onboarding completion', async () => {
    const invitation = await createPending('member_invitation', 'within-ttl')
    const accepted = await acceptInvitationForEmail(
      invitation.email,
      invitation.token,
      invitation.id
    )
    if (!('data' in accepted)) throw new Error('producer did not accept onboarding invitation')

    await expect(
      setInvitationPasswordForUser(
        String(accepted.data.userId),
        invitation.email,
        invitation.id,
        'Within-Ttl-Password-1!'
      )
    ).resolves.toMatchObject({ data: { passwordUpdated: true, status: 'accepted' } })
  })
})
