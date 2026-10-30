import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import {
  acceptInvitation,
  acceptInvitationById,
  acceptInvitationForEmail,
} from '../src/services/directory/membership.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))

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

type InvitationPurpose = 'member_invitation' | 'password_reset' | 'admin_desktop_access'
type InvitationStatus = 'draft' | 'pending' | 'accepted' | 'revoked'

type InvitationFixture = {
  id: string
  email: string
  token: string
}

type InvitationStateRow = {
  status: InvitationStatus
  accepted_user_id: string | null
  accepted_at: Date | null
}

type MembershipRow = {
  team_id: string
  role: string
  status: string
}

describeRealPostgres('membership invitation acceptance idempotency on real PostgreSQL', () => {
  const database = `control_api_invitation_acceptance_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let teamId: string

  async function createInvitation(options: {
    label: string
    email?: string
    purpose?: InvitationPurpose
    status?: InvitationStatus
    expiresAt?: Date
  }): Promise<InvitationFixture> {
    const email = options.email ?? `${options.label}-${randomUUID()}@example.test`
    const token = `token-${randomUUID()}`
    const inserted = await holder.pool.query<{ id: string }>(
      `INSERT INTO invitations(email, role, token, status, purpose, expires_at)
       VALUES ($1, 'member', $2, $3, $4, $5)
       RETURNING id::text AS id`,
      [
        email,
        token,
        options.status ?? 'pending',
        options.purpose ?? 'member_invitation',
        options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      ]
    )
    const id = inserted.rows[0]!.id
    await holder.pool.query(
      `INSERT INTO invitation_teams(invitation_id, team_id, role)
       VALUES ($1, $2, 'member')`,
      [id, teamId]
    )
    return { id, email, token }
  }

  async function invitationState(invitationId: string): Promise<InvitationStateRow> {
    const result = await holder.pool.query<InvitationStateRow>(
      `SELECT status, accepted_user_id, accepted_at
         FROM invitations
        WHERE id = $1`,
      [invitationId]
    )
    return result.rows[0]!
  }

  async function memberships(userId: string): Promise<MembershipRow[]> {
    const result = await holder.pool.query<MembershipRow>(
      `SELECT team_id, role, status
         FROM team_members
        WHERE user_id = $1
        ORDER BY team_id`,
      [userId]
    )
    return result.rows
  }

  async function invitationUserCount(email: string): Promise<number> {
    const result = await holder.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM users WHERE email = $1`,
      [email]
    )
    return result.rows[0]!.count
  }

  async function membershipWriteCount(): Promise<number> {
    const result = await holder.pool.query<{ writes: number }>(
      `SELECT writes FROM team_membership_write_probe`
    )
    return result.rows[0]!.writes
  }

  async function resetMembershipWriteProbe(): Promise<void> {
    await holder.pool.query(`UPDATE team_membership_write_probe SET writes = 0`)
  }

  // Both concurrent acceptance statements execute the same locked invitation
  // SELECT. Counting them in pg_stat_activity proves they are queued on the
  // barrier's row lock before it is released, so this is a real overlap rather
  // than two calls that happened to run one after the other.
  async function waitForLockedAcceptances(expected: number): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const result = await holder.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE '%FOR UPDATE OF i%'`
      )
      if (result.rows[0]!.count >= expected) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(
      `expected ${expected} invitation acceptance statements waiting on the invitation row lock`
    )
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const connection = new URL(adminUrl!)
    connection.pathname = `/${database}`
    holder.pool = new Pool({ connectionString: connection.toString() })
    await initDb(holder.pool)
    teamId = randomUUID()
    await holder.pool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Idempotency Team')`, [teamId])
    // Test-only write observer on the scratch database: every membership
    // INSERT/UPDATE increments one counter, so a concurrent replay that
    // re-applies an identical UPSERT is visible even when the final row is
    // unchanged.
    await holder.pool.query(`
      CREATE TABLE team_membership_write_probe (writes integer NOT NULL)
    `)
    await holder.pool.query(`INSERT INTO team_membership_write_probe(writes) VALUES (0)`)
    await holder.pool.query(`
      CREATE FUNCTION record_team_membership_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE team_membership_write_probe SET writes = writes + 1;
        RETURN NULL;
      END;
      $$
    `)
    await holder.pool.query(`
      CREATE TRIGGER team_membership_write_probe_trigger
      AFTER INSERT OR UPDATE ON team_members
      FOR EACH ROW EXECUTE FUNCTION record_team_membership_write()
    `)
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

  it('accepts a pending member invitation and creates one membership', async () => {
    const invitation = await createInvitation({ label: 'first-accept' })

    const accepted = await acceptInvitationForEmail(
      invitation.email,
      invitation.token,
      invitation.id
    )

    expect(accepted).toMatchObject({
      data: {
        accepted: true,
        id: invitation.id,
        email: invitation.email,
        role: 'member',
        status: 'accepted',
      },
    })
    if (!('data' in accepted)) throw new Error('first acceptance did not return a result')
    const userId = String(accepted.data.userId)

    const state = await invitationState(invitation.id)
    expect(state.status).toBe('accepted')
    expect(state.accepted_user_id).toBe(userId)
    expect(state.accepted_at).toBeInstanceOf(Date)

    await expect(memberships(userId)).resolves.toEqual([
      { team_id: teamId, role: 'member', status: 'active' },
    ])
  })

  it('replays the same result for a repeated acceptance without a second membership', async () => {
    const invitation = await createInvitation({ label: 'replay' })
    const first = await acceptInvitationForEmail(invitation.email, invitation.token, invitation.id)
    if (!('data' in first)) throw new Error('first acceptance did not return a result')
    const userId = String(first.data.userId)
    const firstState = await invitationState(invitation.id)
    await expect(memberships(userId)).resolves.toEqual([
      { team_id: teamId, role: 'member', status: 'active' },
    ])
    // A later role change must survive the replay; re-applying the invitation
    // memberships would reset it to the invited role.
    await holder.pool.query(
      `UPDATE team_members SET role = 'inviter' WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId]
    )

    const replay = await acceptInvitationForEmail(invitation.email, invitation.token, invitation.id)

    expect(replay).toEqual({ data: { ...first.data, replay: true } })
    const replayState = await invitationState(invitation.id)
    expect(replayState.accepted_user_id).toBe(userId)
    const firstAcceptedAt = firstState.accepted_at
    if (!(firstAcceptedAt instanceof Date)) {
      throw new Error('first acceptance did not record an accepted_at timestamp')
    }
    expect(replayState.accepted_at?.toISOString()).toBe(firstAcceptedAt.toISOString())
    await expect(memberships(userId)).resolves.toEqual([
      { team_id: teamId, role: 'inviter', status: 'active' },
    ])
  })

  it('refuses to replay an accepted invitation for a different email', async () => {
    const invitation = await createInvitation({ label: 'accepted-other-email' })
    const accepted = await acceptInvitationForEmail(
      invitation.email,
      invitation.token,
      invitation.id
    )
    if (!('data' in accepted)) throw new Error('first acceptance did not return a result')
    const userId = String(accepted.data.userId)
    const acceptedState = await invitationState(invitation.id)

    await expect(
      acceptInvitationForEmail('intruder@example.test', invitation.token, invitation.id)
    ).resolves.toEqual({ error: 'forbidden' })

    await expect(memberships(userId)).resolves.toEqual([
      { team_id: teamId, role: 'member', status: 'active' },
    ])
    const rejectedState = await invitationState(invitation.id)
    expect(rejectedState.accepted_user_id).toBe(userId)
    const acceptedAt = acceptedState.accepted_at
    if (!(acceptedAt instanceof Date)) {
      throw new Error('acceptance did not record an accepted_at timestamp')
    }
    expect(rejectedState.accepted_at?.toISOString()).toBe(acceptedAt.toISOString())
  })

  it('refuses an explicit user id that does not own the invitation email', async () => {
    const invitation = await createInvitation({ label: 'explicit-user' })
    const owner = await holder.pool.query<{ id: string }>(
      `INSERT INTO users(email, name)
       VALUES ($1, 'Invitation Owner')
       RETURNING id::text AS id`,
      [invitation.email]
    )
    const ownerId = owner.rows[0]!.id

    await expect(
      acceptInvitation(randomUUID(), invitation.email, invitation.token, invitation.id)
    ).resolves.toEqual({ error: 'forbidden' })
    await expect(invitationState(invitation.id)).resolves.toMatchObject({
      status: 'pending',
      accepted_user_id: null,
    })

    await expect(
      acceptInvitation(ownerId, invitation.email, invitation.token, invitation.id)
    ).resolves.toMatchObject({ data: { accepted: true, userId: ownerId } })
    await expect(memberships(ownerId)).resolves.toEqual([
      { team_id: teamId, role: 'member', status: 'active' },
    ])
  })

  it('refuses an accepted invitation recorded against a different user id', async () => {
    const invitation = await createInvitation({ label: 'accepted-other-owner' })
    const other = await holder.pool.query<{ id: string }>(
      `INSERT INTO users(email, name)
       VALUES ($1, 'Previous Owner')
       RETURNING id::text AS id`,
      [`previous-${randomUUID()}@example.test`]
    )
    const previousOwnerId = other.rows[0]!.id
    const owner = await holder.pool.query<{ id: string }>(
      `INSERT INTO users(email, name)
       VALUES ($1, 'Current Owner')
       RETURNING id::text AS id`,
      [invitation.email]
    )
    const ownerId = owner.rows[0]!.id
    await holder.pool.query(
      `UPDATE invitations
          SET status = 'accepted',
              accepted_user_id = $2,
              accepted_at = NOW()
        WHERE id = $1`,
      [invitation.id, previousOwnerId]
    )

    await expect(
      acceptInvitation(ownerId, invitation.email, invitation.token, invitation.id)
    ).resolves.toEqual({ error: 'forbidden' })
    await expect(invitationState(invitation.id)).resolves.toMatchObject({
      status: 'accepted',
      accepted_user_id: previousOwnerId,
    })
    await expect(memberships(ownerId)).resolves.toEqual([])

    // Positive witness for the empty-membership assertion above: the same
    // membership observation path returns a row after a pending acceptance for
    // this user, so an empty read is not a query that can never see rows.
    const witnessInvitation = await createInvitation({
      label: 'owner-membership-witness',
      email: invitation.email,
    })
    await expect(
      acceptInvitation(ownerId, invitation.email, witnessInvitation.token, witnessInvitation.id)
    ).resolves.toMatchObject({ data: { accepted: true, userId: ownerId } })
    await expect(memberships(ownerId)).resolves.toEqual([
      { team_id: teamId, role: 'member', status: 'active' },
    ])

    await holder.pool.query(`DELETE FROM users WHERE id = $1`, [previousOwnerId])
    await expect(
      acceptInvitation(ownerId, invitation.email, invitation.token, invitation.id)
    ).resolves.toMatchObject({ data: { accepted: true, userId: ownerId } })
    await expect(invitationState(invitation.id)).resolves.toMatchObject({
      accepted_user_id: ownerId,
    })
  })

  it('refuses an expired pending invitation until it is no longer expired', async () => {
    const invitation = await createInvitation({
      label: 'expired',
      expiresAt: new Date(Date.now() - 60 * 1000),
    })

    await expect(
      acceptInvitationForEmail(invitation.email, invitation.token, invitation.id)
    ).resolves.toEqual({ error: 'expired' })
    await expect(invitationState(invitation.id)).resolves.toMatchObject({
      status: 'pending',
      accepted_user_id: null,
    })
    await expect(invitationUserCount(invitation.email)).resolves.toBe(0)

    await holder.pool.query(
      `UPDATE invitations SET expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1`,
      [invitation.id]
    )
    const accepted = await acceptInvitationForEmail(
      invitation.email,
      invitation.token,
      invitation.id
    )
    expect(accepted).toMatchObject({ data: { accepted: true } })
    if (!('data' in accepted)) throw new Error('witness acceptance did not return a result')
    await expect(memberships(String(accepted.data.userId))).resolves.toHaveLength(1)
  })

  it('refuses a revoked invitation until it is explicitly restored to pending', async () => {
    const invitation = await createInvitation({ label: 'revoked', status: 'revoked' })

    await expect(
      acceptInvitationForEmail(invitation.email, invitation.token, invitation.id)
    ).resolves.toEqual({ error: 'not_pending' })
    await expect(invitationState(invitation.id)).resolves.toMatchObject({
      status: 'revoked',
      accepted_user_id: null,
    })
    await expect(invitationUserCount(invitation.email)).resolves.toBe(0)

    await holder.pool.query(`UPDATE invitations SET status = 'pending' WHERE id = $1`, [
      invitation.id,
    ])
    const accepted = await acceptInvitationForEmail(
      invitation.email,
      invitation.token,
      invitation.id
    )
    expect(accepted).toMatchObject({ data: { accepted: true } })
    if (!('data' in accepted)) throw new Error('witness acceptance did not return a result')
    await expect(memberships(String(accepted.data.userId))).resolves.toHaveLength(1)
  })

  it('refuses a password-reset invitation until its purpose is a member invitation', async () => {
    const invitation = await createInvitation({
      label: 'password-reset-purpose',
      purpose: 'password_reset',
    })

    await expect(
      acceptInvitationForEmail(invitation.email, invitation.token, invitation.id)
    ).resolves.toEqual({ error: 'not_pending' })
    await expect(invitationState(invitation.id)).resolves.toMatchObject({
      status: 'pending',
      accepted_user_id: null,
    })
    await expect(invitationUserCount(invitation.email)).resolves.toBe(0)

    await holder.pool.query(`UPDATE invitations SET purpose = 'member_invitation' WHERE id = $1`, [
      invitation.id,
    ])
    const accepted = await acceptInvitationForEmail(
      invitation.email,
      invitation.token,
      invitation.id
    )
    expect(accepted).toMatchObject({ data: { accepted: true } })
    if (!('data' in accepted)) throw new Error('witness acceptance did not return a result')
    await expect(memberships(String(accepted.data.userId))).resolves.toHaveLength(1)
  })

  it('refuses a password-reset invitation addressed by id', async () => {
    const invitation = await createInvitation({
      label: 'by-id-password-reset',
      purpose: 'password_reset',
    })

    await expect(acceptInvitationById(invitation.email, invitation.id)).resolves.toEqual({
      error: 'not_pending',
    })
    await expect(invitationState(invitation.id)).resolves.toMatchObject({
      status: 'pending',
      accepted_user_id: null,
    })
    await expect(invitationUserCount(invitation.email)).resolves.toBe(0)

    await holder.pool.query(
      `UPDATE invitations SET purpose = 'admin_desktop_access' WHERE id = $1`,
      [invitation.id]
    )
    const accepted = await acceptInvitationById(invitation.email, invitation.id)
    expect(accepted).toMatchObject({ data: { accepted: true, status: 'accepted' } })
    if (!('data' in accepted)) throw new Error('witness acceptance did not return a result')
    await expect(memberships(String(accepted.data.userId))).resolves.toEqual([
      { team_id: teamId, role: 'member', status: 'active' },
    ])
  })

  it('refuses an unknown invitation and still accepts a real one', async () => {
    await expect(
      acceptInvitationForEmail('unknown@example.test', `missing-${randomUUID()}`, randomUUID())
    ).resolves.toEqual({ error: 'not_found' })

    const invitation = await createInvitation({ label: 'unknown-witness' })
    const accepted = await acceptInvitationForEmail(
      invitation.email,
      invitation.token,
      invitation.id
    )
    expect(accepted).toMatchObject({ data: { accepted: true } })
    if (!('data' in accepted)) throw new Error('witness acceptance did not return a result')
    await expect(memberships(String(accepted.data.userId))).resolves.toHaveLength(1)
  })

  it('writes one membership when two acceptances overlap on the invitation row lock', async () => {
    const invitation = await createInvitation({ label: 'concurrent' })
    await resetMembershipWriteProbe()

    // Hold the invitation row so both acceptances queue on the same lock before
    // either can consume the pending transition. Releasing it then lets exactly
    // one win and the other observe the accepted row.
    const barrier = await holder.pool.connect()
    let accepting: Array<ReturnType<typeof acceptInvitationForEmail>> = []
    let barrierCommitted = false
    try {
      await barrier.query('BEGIN')
      await barrier.query(`SELECT id FROM invitations WHERE id = $1 FOR UPDATE`, [invitation.id])
      // Start both acceptances only after the barrier owns the row, so both
      // necessarily queue behind it.
      accepting = [
        acceptInvitationForEmail(invitation.email, invitation.token, invitation.id),
        acceptInvitationForEmail(invitation.email, invitation.token, invitation.id),
      ]
      await waitForLockedAcceptances(2)
      await barrier.query('COMMIT')
      barrierCommitted = true

      const [left, right] = await Promise.all(accepting)

      expect(left).toMatchObject({ data: { accepted: true, status: 'accepted' } })
      expect(right).toMatchObject({ data: { accepted: true, status: 'accepted' } })
      if (!('data' in left) || !('data' in right)) {
        throw new Error('concurrent acceptance did not return results')
      }
      // Exactly one of the two acceptances consumed the pending row.
      const replays = [left.data.replay, right.data.replay].filter(Boolean)
      expect(replays).toHaveLength(1)
      expect(left.data.userId).toBe(right.data.userId)
      expect(left.data.acceptedAt).toBe(right.data.acceptedAt)
      const userId = String(left.data.userId)

      // The observer counts actual membership writes, so an identical UPSERT
      // applied by the replay would raise this above one even though the final
      // row, role and timestamps stay identical.
      await expect(membershipWriteCount()).resolves.toBe(1)

      await expect(memberships(userId)).resolves.toEqual([
        { team_id: teamId, role: 'member', status: 'active' },
      ])
      const state = await invitationState(invitation.id)
      expect(state.status).toBe('accepted')
      expect(state.accepted_user_id).toBe(userId)
      const acceptedAt = state.accepted_at
      if (!(acceptedAt instanceof Date)) {
        throw new Error('concurrent acceptance did not record an accepted_at timestamp')
      }
      expect(acceptedAt.toISOString()).toBe(left.data.acceptedAt)

      // Liveness witness: the probe observes a real membership update, so the
      // one-write assertion above is not a trigger that never fires.
      await holder.pool.query(`UPDATE team_members SET role = role WHERE user_id = $1`, [userId])
      await expect(membershipWriteCount()).resolves.toBe(2)
    } finally {
      if (!barrierCommitted) {
        await barrier.query('ROLLBACK')
        await Promise.allSettled(accepting)
      }
      barrier.release()
    }
  })
})
