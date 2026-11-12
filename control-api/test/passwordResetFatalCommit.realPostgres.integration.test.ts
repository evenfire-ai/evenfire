import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import { sendPasswordAdmissionError } from '../src/middleware/passwordLoginAdmission.js'
import { withPasswordWorkLease } from '../src/services/auth/passwordWorkOwnership.js'
import { setInvitationPasswordForEmail } from '../src/services/directory/membership.js'
import { createSilentPasswordResetInvitation } from '../src/services/directory/passwordResetInvitations.js'
import { createPostgresFatalCommitReplyInjector } from './helpers/realPostgresFatalCommit.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool, unknownCommitOutcomes: 0 }))

vi.mock('../src/db.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/db.js')>()
  const proxy = {
    query: (...args: unknown[]) => (holder.pool.query as Function)(...args),
    connect: () => holder.pool.connect(),
  }
  return {
    ...real,
    pool: proxy,
    corePool: proxy,
    rateLimitPool: proxy,
    withTransaction: (
      work: Parameters<typeof real.withTransaction>[0],
      _txPool?: Parameters<typeof real.withTransaction>[1],
      options?: Parameters<typeof real.withTransaction>[2]
    ) =>
      real.withTransaction(work, holder.pool, {
        ...options,
        onCommitOutcomeUnknown: () => {
          holder.unknownCommitOutcomes += 1
          options?.onCommitOutcomeUnknown?.()
        },
      }),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip

realPg('R4-M2 PostgreSQL session termination after COMMIT dispatch', () => {
  const database = `r4m2_fatal_commit_${randomBytes(6).toString('hex')}`
  const email = `r4m2-${randomBytes(8).toString('hex')}@example.invalid`
  const originalPassword = 'Synthetic-R4-M2-Original-Password'
  const newPassword = 'Synthetic-R4-M2-Replacement-Password'
  let admin: Pool
  let observer: Pool
  let normalPool: Pool
  let proxyPool: Pool | undefined
  let fault: Awaited<ReturnType<typeof createPostgresFatalCommitReplyInjector>> | undefined
  let connectionString: string
  let resetInvitationId: string
  let siblingInvitationId: string
  let userId: string
  let originalHash: string

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const databaseUrl = new URL(adminUrl!)
    databaseUrl.pathname = `/${database}`
    connectionString = databaseUrl.toString()
    normalPool = new Pool({ connectionString })
    observer = new Pool({ connectionString })
    holder.pool = normalPool
    await initDb(normalPool)

    originalHash = await bcrypt.hash(originalPassword, 12)
    const user = await normalPool.query(
      'INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, originalHash]
    )
    userId = user.rows[0].id as string
    const primary = await createSilentPasswordResetInvitation({
      inviteeName: 'Synthetic R4-M2 member',
      email,
    })
    const sibling = await createSilentPasswordResetInvitation({
      inviteeName: 'Synthetic R4-M2 member',
      email,
    })
    resetInvitationId = primary.id
    siblingInvitationId = sibling.id
  }, 60_000)

  afterAll(async () => {
    try {
      await fault?.close()
      if (proxyPool) await endPoolAndWaitForClients(proxyPool)
      if (normalPool) await endPoolAndWaitForClients(normalPool)
      if (observer) await endPoolAndWaitForClients(observer)
      if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin?.end()
    }
  })

  it('treats a post-COMMIT FATAL as unknown and does not issue a replay session', async () => {
    holder.unknownCommitOutcomes = 0
    fault = await createPostgresFatalCommitReplyInjector(connectionString)
    proxyPool = new Pool({ connectionString: fault.connectionString, max: 2 })

    const resetOutcome = withPasswordWorkLease(lease => {
      holder.pool = proxyPool
      return setInvitationPasswordForEmail(email, resetInvitationId, newPassword, userId, lease)
    }).then(
      value => ({ value }),
      error => ({ error })
    )

    const backendPid = await fault.backendReady
    await fault.commitAckWithheld
    const committed = await observer.query(
      `SELECT primary_invite.status AS reset_status,
              sibling.status AS sibling_status,
              member_user.password_hash,
              (SELECT COUNT(*)::int FROM password_verification_work) AS owners
         FROM invitations primary_invite
         JOIN invitations sibling ON sibling.id = $2
         JOIN users member_user ON member_user.id = $3
        WHERE primary_invite.id = $1`,
      [resetInvitationId, siblingInvitationId, userId]
    )
    expect(committed.rows[0]).toMatchObject({
      reset_status: 'accepted',
      sibling_status: 'revoked',
      owners: 0,
    })
    expect(await bcrypt.compare(newPassword, committed.rows[0].password_hash as string)).toBe(true)

    const terminated = await admin.query<{ terminated: boolean }>(
      'SELECT pg_terminate_backend($1) AS terminated',
      [backendPid]
    )
    expect(terminated.rows[0]?.terminated).toBe(true)
    expect(await fault.fatalResponse).toMatchObject({ code: '57P01', severity: 'FATAL' })

    const outcome = await resetOutcome
    expect(outcome).toMatchObject({
      error: {
        status: 503,
        reason: 'authority_failure',
        publicError: 'recovery_outcome_unknown',
      },
    })
    expect(holder.unknownCommitOutcomes).toBe(1)
    expect(fault.commands.filter(command => command === 'COMMIT')).toHaveLength(1)

    const publicApp = express()
    publicApp.post('/password-reset', (_req, res) => {
      if ('error' in outcome && sendPasswordAdmissionError(outcome.error, res)) return
      res.status(500).json({ error: 'unexpected test outcome' })
    })
    const publicResponse = await request(publicApp).post('/password-reset').send({})
    expect(publicResponse.status).toBe(503)
    expect(publicResponse.body).toEqual({
      error: 'recovery_outcome_unknown',
      retryAfterSeconds: 2,
    })
    expect(publicResponse.headers['retry-after']).toBe('2')
    expect(publicResponse.headers['cache-control']).toBe('no-store')
    expect(publicResponse.headers['set-cookie']).toBeUndefined()

    holder.pool = normalPool
    const replay = await setInvitationPasswordForEmail(
      email,
      resetInvitationId,
      newPassword,
      userId
    )
    expect(replay).toEqual({ error: 'not_pending' })
    expect(
      await observer.query('SELECT status FROM invitations WHERE id = $1', [resetInvitationId])
    ).toMatchObject({ rows: [{ status: 'accepted' }] })
    expect(
      await observer.query('SELECT COUNT(*)::int AS count FROM password_verification_work')
    ).toMatchObject({ rows: [{ count: 0 }] })
  }, 30_000)
})
