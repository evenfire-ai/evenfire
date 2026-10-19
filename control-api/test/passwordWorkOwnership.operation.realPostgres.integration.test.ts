import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { acquirePasswordWork } from '../src/services/auth/passwordWorkOwnership.js'
import {
  type PasswordMutationLease,
  runPasswordMutation,
  withPasswordWorkLease,
} from '../src/services/auth/passwordWorkOwnership.js'
import {
  acceptInvitationForEmail,
  createSilentInvitationForTeams,
  setInvitationPasswordForEmail,
  setInvitationPasswordForUser,
  withMemberPasswordWorkLease,
} from '../src/services/directory/membership.js'
import { createSilentPasswordResetInvitation } from '../src/services/directory/passwordResetInvitations.js'
import { createPostgresCommitReplyBlackhole } from './helpers/realPostgresCancellation.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))
vi.mock('../src/db.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/db.js')>()
  return {
    ...real,
    pool: { query: (...args: unknown[]) => (holder.pool.query as Function)(...args) },
    withTransaction: (
      work: Parameters<typeof real.withTransaction>[0],
      _pool?: Parameters<typeof real.withTransaction>[1],
      options?: Parameters<typeof real.withTransaction>[2]
    ) => real.withTransaction(work, holder.pool, options),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip
realPg('password-work operation preservation on PostgreSQL 16', () => {
  const database = `password_operation_${randomBytes(6).toString('hex')}`
  let admin: Pool
  let local: Pool
  let connectionString: string
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    connectionString = url.toString()
    local = new Pool({ connectionString: url.toString(), max: 1 })
    holder.pool = local
    await initDb(local)
  }, 60_000)
  beforeEach(async () => {
    vi.restoreAllMocks()
    await local.query('DELETE FROM password_verification_work')
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

  async function ownerCount() {
    return (await local.query('SELECT COUNT(*)::int AS count FROM password_verification_work'))
      .rows[0].count
  }
  async function resetFixture() {
    const email = `${randomBytes(8).toString('hex')}@example.invalid`
    const user = (await local.query('INSERT INTO users(email) VALUES ($1) RETURNING id', [email]))
      .rows[0]
    const invitation = await createSilentPasswordResetInvitation({
      inviteeName: 'Synthetic preservation member',
      email,
    })
    return { email, userId: user.id as string, invitation }
  }

  it('releases an unused reservation and retains an original outer work failure', async () => {
    const failure = new Error('preservation work failure')
    await expect(
      withMemberPasswordWorkLease(async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(await ownerCount()).toBe(0)
  })

  it('keeps storage release failure above the outer work failure', async () => {
    try {
      await expect(
        withMemberPasswordWorkLease(async () => {
          await local.query('ALTER TABLE password_verification_work RENAME TO preservation_work')
          throw new Error('private work failure')
        })
      ).rejects.toMatchObject({ status: 503, message: 'authority_unavailable' })
    } finally {
      await local.query('ALTER TABLE preservation_work RENAME TO password_verification_work')
    }
    // Unconfirmed release remains occupied; only this disposable fixture is reset by beforeEach.
    expect(await ownerCount()).toBe(1)
  })

  it('composes an accepted admin/member operation with its existing reservation and one pool', async () => {
    const email = `${randomBytes(8).toString('hex')}@example.invalid`
    const invitation = await createSilentInvitationForTeams({
      email,
      inviteeName: 'Synthetic admin member',
      purpose: 'admin_desktop_access',
    })
    const result = await withMemberPasswordWorkLease(async lease => {
      const accepted = await acceptInvitationForEmail(email, invitation.token, invitation.id)
      if (!('data' in accepted)) throw new Error('fixture acceptance failed')
      expect(await ownerCount()).toBe(1)
      return setInvitationPasswordForUser(
        accepted.data.userId!,
        email,
        invitation.id,
        'Synthetic-preservation-password',
        lease
      )
    })
    expect(result).toMatchObject({
      data: { passwordUpdated: true, purpose: 'admin_desktop_access' },
    })
    expect(await ownerCount()).toBe(0)
    const row = (await local.query('SELECT password_hash FROM users WHERE email = $1', [email]))
      .rows[0]
    expect(await bcrypt.compare('Synthetic-preservation-password', row.password_hash)).toBe(true)
  })

  it('retains a committed mutation lease and does not release a successor owner', async () => {
    const fixture = await resetFixture()
    let lease: PasswordMutationLease | undefined
    const result = await withPasswordWorkLease(mutationLease => {
      lease = mutationLease
      return setInvitationPasswordForEmail(
        fixture.email,
        fixture.invitation.id,
        'Synthetic-preservation-password',
        fixture.userId,
        mutationLease
      )
    })
    expect(result).toMatchObject({ data: { passwordUpdated: true, status: 'accepted' } })
    const successor = await acquirePasswordWork()
    expect(successor).not.toBeNull()
    try {
      await expect(
        runPasswordMutation(async () => 'must not run', {
          mode: 'standard',
          lease: lease!,
        })
      ).rejects.toMatchObject({ status: 503, message: 'authority_unavailable' })
      expect(await ownerCount()).toBe(1)
    } finally {
      await successor?.release()
    }
  })

  it('rolls back a credential mutation when its transactional owner DELETE fails', async () => {
    const fixture = await resetFixture()
    await local.query(`CREATE FUNCTION preservation_delete_failure() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'private fixture release detail'; END $$`)
    await local.query(`CREATE TRIGGER preservation_delete_failure BEFORE DELETE
      ON password_verification_work FOR EACH ROW EXECUTE FUNCTION preservation_delete_failure()`)
    try {
      await expect(
        setInvitationPasswordForEmail(
          fixture.email,
          fixture.invitation.id,
          'Synthetic-preservation-password',
          fixture.userId
        )
      ).rejects.toMatchObject({ status: 503, message: 'authority_unavailable' })
      const row = (
        await local.query(
          `SELECT i.status, u.password_hash FROM invitations i
        JOIN users u ON u.id = $2 WHERE i.id = $1`,
          [fixture.invitation.id, fixture.userId]
        )
      ).rows[0]
      expect(row).toMatchObject({ status: 'pending', password_hash: null })
      expect(await ownerCount()).toBe(1)
    } finally {
      await local.query('DROP TRIGGER preservation_delete_failure ON password_verification_work')
      await local.query('DROP FUNCTION preservation_delete_failure()')
    }
  })

  it('rolls back a prior database write when the mutation callback throws a TypeError', async () => {
    const fixture = await resetFixture()
    const callbackFailure = new TypeError('private callback diagnostic')
    const originalName = (
      await local.query('SELECT name FROM users WHERE id = $1', [fixture.userId])
    ).rows[0].name

    const failure = await runPasswordMutation(
      async transaction => {
        await transaction.query('UPDATE users SET name = $2 WHERE id = $1', [
          fixture.userId,
          'Must be rolled back',
        ])
        throw callbackFailure
      },
      { mode: 'standard' }
    ).catch(error => error)

    expect(failure).toMatchObject({
      name: 'PasswordMutationInternalError',
      code: 'internal_error',
      message: 'internal_error',
    })
    const causeDescriptor = Object.getOwnPropertyDescriptor(failure, 'cause')
    expect(causeDescriptor?.value).toBe(callbackFailure)
    expect(causeDescriptor?.enumerable).toBe(false)
    expect(JSON.stringify(failure)).not.toContain(callbackFailure.message)

    const persistedName = (
      await local.query('SELECT name FROM users WHERE id = $1', [fixture.userId])
    ).rows[0].name
    expect(persistedName).toBe(originalName)
    expect(await ownerCount()).toBe(0)
  })

  it('keeps a real lost-COMMIT outcome above failed owner cleanup in an outer reservation', async () => {
    const fixture = await resetFixture()
    const sibling = await createSilentPasswordResetInvitation({
      email: fixture.email,
      inviteeName: 'Synthetic sibling',
    })
    const blackhole = await createPostgresCommitReplyBlackhole(connectionString)
    const proxyPool = new Pool({ connectionString: blackhole.connectionString, max: 1 })
    const outcome = withMemberPasswordWorkLease(async lease => {
      // Acquisition is acknowledged on the ordinary pool; only the credential COMMIT is lost.
      holder.pool = proxyPool
      return setInvitationPasswordForEmail(
        fixture.email,
        fixture.invitation.id,
        'Synthetic-preservation-password',
        fixture.userId,
        lease
      )
    }).then(
      value => ({ value }),
      error => ({ error })
    )
    try {
      await blackhole.commitForwarded
      const deadline = Date.now() + 2_000
      while (blackhole.discardedReplyBytes === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(blackhole.discardedReplyBytes).toBeGreaterThan(0)
      const row = (
        await local.query(
          `SELECT u.password_hash, i.status, s.status AS sibling_status
        FROM users u JOIN invitations i ON i.id = $2 JOIN invitations s ON s.id = $3
        WHERE u.id = $1`,
          [fixture.userId, fixture.invitation.id, sibling.id]
        )
      ).rows[0]
      expect(row).toMatchObject({ status: 'accepted', sibling_status: 'revoked' })
      expect(await bcrypt.compare('Synthetic-preservation-password', row.password_hash)).toBe(true)
      expect(await ownerCount()).toBe(0)
      // A successor exists before fallback cleanup. The old owner must neither delete it
      // nor replace the chosen unknown outcome with its failed owned DELETE.
      holder.pool = local
      const successor = await acquirePasswordWork()
      holder.pool = proxyPool
      blackhole.failClientAfterCommitForwarded()
      const result = await outcome
      expect(result).toMatchObject({
        error: { status: 503, publicError: 'recovery_outcome_unknown' },
      })
      expect(blackhole.commands.filter(command => command === 'COMMIT')).toHaveLength(1)
      expect(await ownerCount()).toBe(1)
      holder.pool = local
      await successor!.release()
      expect(
        await setInvitationPasswordForEmail(
          fixture.email,
          fixture.invitation.id,
          'Synthetic-replay-password',
          fixture.userId
        )
      ).toEqual({ error: 'not_pending' })
    } finally {
      holder.pool = local
      blackhole.allowReplies()
      await blackhole.close()
      await endPoolAndWaitForClients(proxyPool)
      await outcome
    }
  })

  it('allows only one concurrent callback and rejects terminal reuse without touching a successor', async () => {
    await withPasswordWorkLease(async lease => {
      let resume!: () => void
      const gate = new Promise<void>(resolve => {
        resume = resolve
      })
      const work = vi.fn(async () => {
        await gate
        return 'committed'
      })
      const first = lease.commitWith(work, { mode: 'standard' })
      try {
        await expect(lease.commitWith(work, { mode: 'standard' })).rejects.toMatchObject({
          status: 503,
        })
      } finally {
        resume()
      }
      expect(await first).toBe('committed')
      expect(work).toHaveBeenCalledTimes(1)
      const successor = await acquirePasswordWork()
      try {
        await expect(runPasswordMutation(work, { mode: 'standard', lease })).rejects.toMatchObject({
          status: 503,
        })
        expect(work).toHaveBeenCalledTimes(1)
        expect(await ownerCount()).toBe(1)
      } finally {
        await successor!.release()
      }
    })
    expect(await ownerCount()).toBe(0)
  })

  it('keeps concurrent supplied domain operations at one committed reset', async () => {
    const fixture = await resetFixture()
    const sibling = await createSilentPasswordResetInvitation({
      email: fixture.email,
      inviteeName: 'Synthetic sibling',
    })
    const hash = vi.spyOn(bcrypt, 'hash')
    const outcomes = await withMemberPasswordWorkLease(lease =>
      Promise.allSettled(
        [fixture.invitation.id, sibling.id].map(id =>
          setInvitationPasswordForEmail(
            fixture.email,
            id,
            'Synthetic-preservation-password',
            fixture.userId,
            lease
          )
        )
      )
    )
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    expect(hash).toHaveBeenCalledTimes(1)
    const rows = (
      await local.query('SELECT status FROM invitations WHERE id = ANY($1::uuid[])', [
        [fixture.invitation.id, sibling.id],
      ])
    ).rows
    expect(rows.map(row => row.status).sort()).toEqual(['accepted', 'revoked'])
    expect(await ownerCount()).toBe(0)
  })
})
