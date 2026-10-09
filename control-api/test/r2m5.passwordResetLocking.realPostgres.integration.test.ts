import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { passwordLoginData } from '../src/services/directory/login.js'
import {
  acceptInvitationForEmail,
  createSilentInvitationForTeams,
  setInvitationPasswordForEmail,
} from '../src/services/directory/membership.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({
  pool: null as unknown as Pool,
  leaseClient: null as unknown as import('pg').PoolClient,
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
    withTransaction: (
      fn: Parameters<typeof real.withTransaction>[0],
      _txPool?: Parameters<typeof real.withTransaction>[1],
      options?: Parameters<typeof real.withTransaction>[2]
    ) => real.withTransaction(fn, holder.pool, options),
  }
})

vi.mock('../src/services/rateLimiterService.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/services/rateLimiterService.js')>()
  return {
    ...real,
    acquireRateLimitConcurrencyLease: (
      request: Parameters<typeof real.acquireRateLimitConcurrencyLease>[0]
    ) => real.acquireRateLimitConcurrencyLease(request, { client: holder.leaseClient }),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip

realPg('R2-M5 password-reset row-lock compatibility on PostgreSQL 16', () => {
  const database = `r2m5_locks_${randomBytes(6).toString('hex')}`
  const password = 'Synthetic-R2M5-Original-Password'
  const resetPassword = 'Synthetic-R2M5-Replacement-Password'
  let admin: Pool
  let observer: Pool
  let blocker: import('pg').PoolClient | null = null
  let hash: string
  let email: string
  let userId: string
  let teamId: string
  let recoveryInvitationId: string

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const databaseUrl = new URL(adminUrl!)
    databaseUrl.pathname = `/${database}`
    databaseUrl.searchParams.set('options', '-c lock_timeout=1000ms')
    const connectionString = databaseUrl.toString()
    holder.pool = new Pool({ connectionString })
    observer = new Pool({ connectionString })
    await initDb(holder.pool)
    holder.leaseClient = await holder.pool.connect()
    hash = await bcrypt.hash(password, 12)
  }, 60_000)

  beforeEach(async () => {
    email = `r2m5-${randomBytes(8).toString('hex')}@example.invalid`
    await holder.pool.query('DELETE FROM password_identifier_state')
    await holder.pool.query('DELETE FROM password_verification_pace')
    const user = await holder.pool.query(
      'INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, hash]
    )
    userId = user.rows[0].id
    teamId = (
      await holder.pool.query("INSERT INTO teams(name) VALUES ('Synthetic R2-M5') RETURNING id")
    ).rows[0].id

    const memberInvitation = await createSilentInvitationForTeams({
      inviteeName: 'Synthetic R2-M5 member',
      email,
      purpose: 'member_invitation',
      teamAssignments: [{ teamId, role: 'member' }],
      fallbackRole: 'member',
    })
    const accepted = await acceptInvitationForEmail(
      email,
      memberInvitation.token,
      memberInvitation.id
    )
    expect(accepted).not.toHaveProperty('error')
    await holder.pool.query('DELETE FROM team_members WHERE user_id = $1', [userId])

    const recoveryInvitation = await createSilentInvitationForTeams({
      inviteeName: 'Synthetic R2-M5 member',
      email,
      purpose: 'password_reset',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    recoveryInvitationId = recoveryInvitation.id
  })

  afterAll(async () => {
    try {
      blocker?.release()
      holder.leaseClient?.release()
      await endPoolAndWaitForClients(holder.pool)
      await endPoolAndWaitForClients(observer)
      if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin?.end()
    }
  })

  afterEach(async () => {
    if (!blocker) return
    try {
      await blocker.query('ROLLBACK')
    } finally {
      blocker.release()
      blocker = null
    }
  })

  it('allows recovery beside real login membership healing and a compatible FK key-share lock', async () => {
    blocker = await holder.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM users WHERE id = $1 FOR KEY SHARE', [userId])

    const login = await passwordLoginData({ email, password })
    expect(login?.membership.team_id).toBe(teamId)
    expect(
      (await holder.pool.query('SELECT user_id FROM team_members WHERE user_id = $1', [userId]))
        .rows
    ).toHaveLength(1)

    let settled = false
    const recoveryPromise = setInvitationPasswordForEmail(
      email,
      recoveryInvitationId,
      resetPassword
    )
      .then(value => ({ ok: true as const, value }))
      .catch(error => ({ ok: false as const, error }))
      .finally(() => {
        settled = true
      })

    let observedBlocker = false
    const deadline = Date.now() + 900
    while (!settled && Date.now() < deadline) {
      const blocking = await observer.query(
        `SELECT a.pid, pg_blocking_pids(a.pid) AS blockers
           FROM pg_stat_activity a
          WHERE a.datname = $1
            AND a.wait_event_type = 'Lock'
            AND a.query ILIKE '%FOR%UPDATE%'`,
        [database]
      )
      if (blocking.rows.some(row => row.blockers.length > 0)) {
        observedBlocker = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    const recovery = await recoveryPromise
    expect(observedBlocker).toBe(false)
    expect(recovery.ok).toBe(true)
    if (recovery.ok) expect(recovery.value).not.toHaveProperty('error')
    expect(
      (
        await holder.pool.query('SELECT status FROM invitations WHERE id = $1', [
          recoveryInvitationId,
        ])
      ).rows[0].status
    ).toBe('accepted')
    expect(
      await bcrypt.compare(
        resetPassword,
        (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
          .password_hash
      )
    ).toBe(true)
  })

  it('still serializes recovery behind a concurrent credential-lifecycle update', async () => {
    blocker = await holder.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query(
      'UPDATE users SET lifecycle_version = lifecycle_version + 1 WHERE id = $1',
      [userId]
    )

    await expect(
      setInvitationPasswordForEmail(email, recoveryInvitationId, resetPassword)
    ).rejects.toMatchObject({ status: 503, reason: 'authority_failure' })
    expect(
      (
        await holder.pool.query('SELECT status FROM invitations WHERE id = $1', [
          recoveryInvitationId,
        ])
      ).rows[0].status
    ).toBe('pending')
    expect(
      (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
        .password_hash
    ).toBe(hash)
  })
})
