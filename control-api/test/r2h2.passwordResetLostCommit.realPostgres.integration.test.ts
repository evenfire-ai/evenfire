import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import { sendPasswordAdmissionError } from '../src/middleware/passwordLoginAdmission.js'
import { acquirePasswordWork } from '../src/services/auth/passwordWorkOwnership.js'
import {
  createSilentInvitationForTeams,
  setInvitationPasswordForEmail,
} from '../src/services/directory/membership.js'
import { createPostgresCommitReplyBlackhole } from './helpers/realPostgresCancellation.js'
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
    corePool: proxy,
    rateLimitPool: proxy,
    withTransaction: (
      fn: Parameters<typeof real.withTransaction>[0],
      _txPool?: Parameters<typeof real.withTransaction>[1],
      options?: Parameters<typeof real.withTransaction>[2]
    ) => real.withTransaction(fn, holder.pool, options),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip

realPg('R2-H2 lost password-reset COMMIT acknowledgement on PostgreSQL 16', () => {
  const database = `r2h2_reset_commit_${randomBytes(6).toString('hex')}`
  const oldPassword = 'Synthetic-R2-H2-Old-Password'
  const newPassword = 'Synthetic-R2-H2-New-Password'
  const email = `r2h2-${randomBytes(8).toString('hex')}@example.invalid`
  let admin: Pool
  let observer: Pool
  let normalPool: Pool
  let proxyPool: Pool | undefined
  let blackhole: Awaited<ReturnType<typeof createPostgresCommitReplyBlackhole>> | undefined
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
    databaseUrl.searchParams.set('options', '-c lock_timeout=1000ms')
    connectionString = databaseUrl.toString()
    normalPool = new Pool({ connectionString })
    observer = new Pool({ connectionString })
    holder.pool = normalPool
    await initDb(normalPool)

    originalHash = await bcrypt.hash(oldPassword, 12)
    const user = await normalPool.query(
      'INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, originalHash]
    )
    userId = user.rows[0].id as string

    const primary = await createSilentInvitationForTeams({
      inviteeName: 'Synthetic R2-H2 member',
      email,
      purpose: 'password_reset',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    const sibling = await createSilentInvitationForTeams({
      inviteeName: 'Synthetic R2-H2 member',
      email,
      purpose: 'password_reset',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    resetInvitationId = primary.id
    siblingInvitationId = sibling.id
  }, 60_000)

  afterAll(async () => {
    try {
      blackhole?.allowReplies()
      await blackhole?.close()
      if (proxyPool) await endPoolAndWaitForClients(proxyPool)
      if (normalPool) await endPoolAndWaitForClients(normalPool)
      if (observer) await endPoolAndWaitForClients(observer)
      if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin?.end()
    }
  })

  it('reports an unknown outcome without replay when reset committed but PostgreSQL reply was lost', async () => {
    const lease = await acquirePasswordWork()
    expect(lease).not.toBeNull()
    if (!lease) throw new Error('password-work owner was not acquired')

    blackhole = await createPostgresCommitReplyBlackhole(connectionString)
    proxyPool = new Pool({ connectionString: blackhole.connectionString, max: 4 })
    holder.pool = proxyPool

    const outcomePromise = setInvitationPasswordForEmail(
      email,
      resetInvitationId,
      newPassword,
      userId,
      lease
    ).then(
      value => ({ value }),
      error => ({ error })
    )

    await blackhole.commitForwarded
    const committed = await observer.query(
      `SELECT i.status AS reset_status,
              sibling.status AS sibling_status,
              u.password_hash,
              (SELECT COUNT(*)::int FROM password_verification_work) AS owners
         FROM invitations i
         JOIN invitations sibling ON sibling.id = $2
         JOIN users u ON u.id = $3
        WHERE i.id = $1`,
      [resetInvitationId, siblingInvitationId, userId]
    )
    expect(committed.rows[0]).toMatchObject({
      reset_status: 'accepted',
      sibling_status: 'revoked',
      owners: 0,
    })
    expect(await bcrypt.compare(newPassword, committed.rows[0].password_hash as string)).toBe(true)

    const replyDeadline = Date.now() + 2_000
    while (blackhole.discardedReplyBytes === 0 && Date.now() < replyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(blackhole.discardedReplyBytes).toBeGreaterThan(0)
    blackhole.failClientAfterCommitForwarded()

    const outcome = await outcomePromise
    expect(outcome).toMatchObject({
      error: {
        status: 503,
        reason: 'authority_failure',
        publicError: 'recovery_outcome_unknown',
      },
    })
    if ('error' in outcome) {
      expect(outcome.error.message).toBe('authority_unavailable')
      expect(outcome.error.message).not.toMatch(/password|sql|invitation|database/i)
    }
    expect(blackhole.commands.filter(command => command === 'COMMIT')).toHaveLength(1)

    const responseApp = express()
    responseApp.post('/password-reset', (_req, res) => {
      if ('error' in outcome) sendPasswordAdmissionError(outcome.error, res)
      else res.status(500).json({ error: 'unexpected successful response' })
    })
    const publicResponse = await request(responseApp).post('/password-reset').send({})
    expect(publicResponse.status).toBe(503)
    expect(publicResponse.body).toEqual({
      error: 'recovery_outcome_unknown',
      retryAfterSeconds: 2,
    })
    expect(publicResponse.headers['retry-after']).toBe('2')
    expect(publicResponse.headers['cache-control']).toBe('no-store')
    expect(publicResponse.headers['set-cookie']).toBeUndefined()
  }, 20_000)
})
