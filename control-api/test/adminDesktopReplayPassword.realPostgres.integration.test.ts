import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import { createAdminAuthRouter } from '../src/routes/admin/auth.js'
import { createControlAdminInvitation } from '../src/services/adminAuthService.js'
import {
  acceptInvitationById,
  createSilentInvitationForTeams,
  setInvitationPasswordForUser,
} from '../src/services/directory/index.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))
const registration = vi.hoisted(() => ({
  validateControlAdminInvitationToken: vi.fn(),
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
      work: Parameters<typeof real.withTransaction>[0],
      _txPool?: Parameters<typeof real.withTransaction>[1],
      options?: Parameters<typeof real.withTransaction>[2]
    ) => real.withTransaction(work, holder.pool, options),
  }
})

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

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

type Deferred = { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(settle => {
    resolve = settle
  })
  return { promise, resolve }
}

type InvitationPair = {
  email: string
  adminInvitationId: string
  desktopInvitationId: string
}

type StoredUser = { id: string; password_hash: string | null }

function app(): express.Express {
  const a = express()
  a.set('trust proxy', 1)
  a.use(express.json())
  a.use(createAdminAuthRouter())
  a.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = err instanceof Error ? err.message : 'unknown route failure'
      res.status(500).json({ error: 'Internal Server Error', message })
    }
  )
  return a
}

describeRealPostgres('control admin completion desktop password on real PostgreSQL', () => {
  const database = `control_api_admin_desktop_replay_${randomBytes(6).toString('hex')}`
  let adminPool: Pool

  async function seedAdmin(label: string): Promise<string> {
    const id = randomUUID()
    const username = `${label}-${id.slice(0, 8)}`
    const email = `${username}@example.test`
    await holder.pool.query(
      `INSERT INTO control_admin_users (id, username, email, password_hash, role, status, session_version)
       VALUES ($1, $2, $3, 'real-pg-inviter-hash', 'admin', 'active', 1)`,
      [id, username, email]
    )
    return id
  }

  async function createPair(label: string): Promise<InvitationPair> {
    const email = `${label}-${randomUUID()}@example.test`
    const inviterId = await seedAdmin(`${label}-inviter`)
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

  async function storedUser(email: string): Promise<StoredUser> {
    const result = await holder.pool.query<StoredUser>(
      `SELECT id, password_hash FROM users WHERE email = $1`,
      [email]
    )
    const user = result.rows[0]
    if (!user) throw new Error(`user ${email} was not created`)
    return user
  }

  function completeRequest(pair: InvitationPair, body: Record<string, unknown>) {
    return request(app())
      .post('/admin/auth/control-admin-invitations/complete')
      .send({
        token: 'synthetic-control-admin-flow-token',
        email: pair.email,
        username: `invitee-${randomUUID().slice(0, 8)}`,
        ...body,
      })
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const connection = new URL(adminUrl!)
    connection.pathname = `/${database}`
    holder.pool = new Pool({ connectionString: connection.toString() })
    await initDb(holder.pool)
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

  it('sets the Desktop password on the first acceptance', async () => {
    const pair = await createPair('first-accept')
    const adminPassword = 'Admin-Completion-1!'
    const memberPassword = 'Desktop-Completion-1!'
    registration.validateControlAdminInvitationToken.mockResolvedValueOnce({
      email: pair.email,
      invitationUuid: pair.adminInvitationId,
    })

    const response = await completeRequest(pair, {
      password: adminPassword,
      useSameMemberPassword: false,
      memberPassword,
    }).expect(200)

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
    const desktop = await holder.pool.query<{ status: string; accepted_user_id: string | null }>(
      `SELECT status, accepted_user_id FROM invitations WHERE id = $1`,
      [pair.desktopInvitationId]
    )
    expect(desktop.rows[0]).toEqual({ status: 'accepted', accepted_user_id: user.id })
  })

  it('does not overwrite a concurrently established password on a Desktop replay', async () => {
    const pair = await createPair('replay')
    const adminPassword = 'Admin-Completion-2!'
    const memberPassword = 'Desktop-Completion-2!'
    const concurrentPassword = 'Concurrent-Device-2!'

    const validationStarted = deferred()
    const validationGate = deferred()
    registration.validateControlAdminInvitationToken.mockImplementationOnce(async () => {
      // The route has already read the pending Desktop invitation and now
      // waits in the external validator. This is the exact window in which
      // another device can accept it and set its own password.
      validationStarted.resolve()
      await validationGate.promise
      return { email: pair.email, invitationUuid: pair.adminInvitationId }
    })

    // A supertest Test starts when it is awaited or chained; start it before
    // waiting for the route to reach the validator gate.
    const responsePromise = completeRequest(pair, {
      password: adminPassword,
      useSameMemberPassword: false,
      memberPassword,
    }).then(response => response)
    await validationStarted.promise

    const concurrent = await acceptInvitationById(pair.email, pair.desktopInvitationId)
    if ('error' in concurrent) throw new Error(concurrent.error)
    const userId = concurrent.data.userId
    await expect(
      setInvitationPasswordForUser(userId, pair.email, pair.desktopInvitationId, concurrentPassword)
    ).resolves.toMatchObject({ data: { passwordUpdated: true } })

    const before = await storedUser(pair.email)
    const beforeHash = before.password_hash
    if (!beforeHash) throw new Error('concurrent acceptance did not store a password')
    await expect(bcrypt.compare(concurrentPassword, beforeHash)).resolves.toBe(true)

    validationGate.resolve()
    const response = await responsePromise

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      completed: true,
      desktopAccessCompleted: false,
      desktopAccessReason: 'desktop_invitation_already_accepted',
      login: { username: pair.email },
    })

    // The control-admin completion still committed its own invitation.
    const admin = await holder.pool.query<{ email: string }>(
      `SELECT email FROM control_admin_users WHERE lower(email) = lower($1)`,
      [pair.email]
    )
    expect(admin.rows).toHaveLength(1)
    const acceptedAdminInvitation = await holder.pool.query<{ status: string }>(
      `SELECT status FROM control_admin_invitations WHERE id = $1`,
      [pair.adminInvitationId]
    )
    expect(acceptedAdminInvitation.rows[0]?.status).toBe('accepted')

    // The replay wrote no password: the concurrently established hash is
    // byte-identical and still verifies the concurrent password, not either
    // password from this completion.
    const after = await storedUser(pair.email)
    expect(after.id).toBe(userId)
    expect(after.password_hash).toBe(beforeHash)
    await expect(bcrypt.compare(concurrentPassword, after.password_hash!)).resolves.toBe(true)
    await expect(bcrypt.compare(memberPassword, after.password_hash!)).resolves.toBe(false)
    await expect(bcrypt.compare(adminPassword, after.password_hash!)).resolves.toBe(false)

    const desktop = await holder.pool.query<{ status: string; accepted_user_id: string | null }>(
      `SELECT status, accepted_user_id FROM invitations WHERE id = $1`,
      [pair.desktopInvitationId]
    )
    expect(desktop.rows[0]).toEqual({ status: 'accepted', accepted_user_id: userId })
  })
})
