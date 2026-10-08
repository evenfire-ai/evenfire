import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import { passwordIdentifierKey } from '../src/services/auth/passwordAdmissionState.js'
import { createInvitationForTeams } from '../src/services/directory/membership.js'
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
    withTransaction: (fn: Parameters<typeof real.withTransaction>[0]) =>
      real.withTransaction(fn, holder.pool),
  }
})

vi.mock('../src/services/rateLimiterService.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/services/rateLimiterService.js')>()
  return {
    ...real,
    acquireRateLimitConcurrencyLease: (
      requirements: Parameters<typeof real.acquireRateLimitConcurrencyLease>[0]
    ) => real.acquireRateLimitConcurrencyLease(requirements, { client: holder.leaseClient }),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const memberRegistrationDbUrl = process.env.CONTROL_API_REAL_MEMBER_REGISTRATION_PG_URL
const realCrossService =
  adminUrl &&
  memberRegistrationDbUrl &&
  process.env.CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL &&
  process.env.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
    ? describe
    : describe.skip
const password = 'Synthetic-Issue1055-previous-password'

realCrossService(
  'BUG-192 recovery through the real Member Registration producer on PostgreSQL',
  () => {
    const database = `bug192_flow_${randomBytes(6).toString('hex')}`
    const email = `issue1055-${randomUUID()}@example.invalid`
    let admin: Pool
    let memberRegistrationDb: Pool
    let app: express.Express
    let userId: string
    let realHash: string

    beforeAll(async () => {
      admin = new Pool({ connectionString: adminUrl })
      await admin.query(`CREATE DATABASE "${database}"`)
      const url = new URL(adminUrl!)
      url.pathname = `/${database}`
      holder.pool = new Pool({ connectionString: url.toString() })
      await initDb(holder.pool)
      holder.leaseClient = await holder.pool.connect()
      memberRegistrationDb = new Pool({ connectionString: memberRegistrationDbUrl })
      realHash = await bcrypt.hash(password, 12)
      app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        req.internalService = { name: 'external-rest-api' }
        next()
      })
      app.use(createExternalInvitationsRouter())
      app.use(createExternalAuthRouter({} as Parameters<typeof createExternalAuthRouter>[0]))
      app.use(
        (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
          res.status(500).json({ error: 'unexpected_test_failure' })
      )
    }, 60_000)

    beforeEach(async () => {
      await holder.pool.query('DELETE FROM team_members')
      await holder.pool.query('DELETE FROM invitations')
      await holder.pool.query('DELETE FROM teams')
      await holder.pool.query('DELETE FROM users')
      await holder.pool.query('DELETE FROM rate_limit_buckets')
      await holder.pool.query('DELETE FROM password_identifier_state')
      await holder.pool.query('DELETE FROM password_verification_pace')
      userId = (
        await holder.pool.query(
          'INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id',
          [email, realHash]
        )
      ).rows[0].id
      await holder.pool.query(
        `INSERT INTO password_verification_pace(singleton, next_permit)
       VALUES (TRUE, clock_timestamp() + interval '1 minute')`
      )
    })

    afterAll(async () => {
      try {
        try {
          await memberRegistrationDb?.query(
            'DELETE FROM invitation_flow_registrations WHERE email = $1',
            [email]
          )
          holder.leaseClient?.release()
          await endPoolAndWaitForClients(holder.pool)
          if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
        } finally {
          await memberRegistrationDb?.end()
        }
      } finally {
        await admin?.end()
      }
    })

    it('recovers with the trusted signed proof while anonymous login pace is saturated', async () => {
      const deniedLogin = await request(app)
        .post('/external/auth/password-login')
        .set('x-external-client-ip', '192.0.2.155')
        .send({ email, password })
        .expect(429)
      expect(deniedLogin.body.error).toBe('rate_limited')

      const invitation = await createInvitationForTeams({
        inviteeName: 'Synthetic issue 1055 member',
        email,
        purpose: 'password_reset',
        teamAssignments: [],
        fallbackRole: 'member',
      })
      const flowRows = await memberRegistrationDb.query(
        `SELECT invitation_jwt
         FROM invitation_flow_registrations
        WHERE email = $1 AND invitation_uuid = $2::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
        [email, invitation.token]
      )
      const proof = flowRows.rows[0]?.invitation_jwt
      expect(proof).toEqual(expect.any(String))

      const preview = await request(app)
        .get(`/external/invitations/token/${encodeURIComponent(proof)}`)
        .expect(200)
      expect(preview.body).toMatchObject({
        id: invitation.id,
        purpose: 'password_reset',
        status: 'pending',
      })
      expect(preview.body).not.toHaveProperty('token')

      const wrongEmail = await request(app)
        .post('/external/invitations/password-token')
        .send({
          email: 'another-member@example.invalid',
          token: proof,
          invitationId: invitation.id,
          password: 'Synthetic-Issue1055-new-password',
        })
        .expect(400)
      expect(wrongEmail.body.error).toBe('invalid_invitation')

      const originalHash = (
        await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])
      ).rows[0].password_hash
      const wrongRow = await request(app)
        .post('/external/invitations/password-token')
        .send({
          email,
          token: proof,
          invitationId: randomUUID(),
          password: 'Synthetic-Issue1055-new-password',
        })
        .expect(403)
      expect(wrongRow.body.error).toBe('forbidden')
      expect(
        (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
          .password_hash
      ).toBe(originalHash)

      const attemptsBeforeRecovery = (
        await holder.pool.query(
          'SELECT attempts FROM password_identifier_state WHERE identifier_key = $1',
          [passwordIdentifierKey(email)]
        )
      ).rows[0].attempts
      const reset = await request(app)
        .post('/external/invitations/password-token')
        .send({
          email,
          token: proof,
          invitationId: invitation.id,
          password: 'Synthetic-Issue1055-new-password',
        })
        .expect(200)
      expect(reset.body.token).toEqual(expect.any(String))
      expect(reset.body).not.toHaveProperty('sessionContext')
      expect(
        (
          await holder.pool.query(
            'SELECT attempts FROM password_identifier_state WHERE identifier_key = $1',
            [passwordIdentifierKey(email)]
          )
        ).rows[0].attempts
      ).toEqual(attemptsBeforeRecovery)

      const authenticated = await request(app)
        .post('/external/auth/verify')
        .send({ token: reset.body.token })
        .expect(200)
      expect(authenticated.body.claims).toMatchObject({ userId, email })

      await holder.pool.query(
        "UPDATE password_verification_pace SET next_permit = clock_timestamp() - interval '1 second'"
      )
      const newPasswordLogin = await request(app)
        .post('/external/auth/password-login')
        .set('x-external-client-ip', '192.0.2.156')
        .send({ email, password: 'Synthetic-Issue1055-new-password' })
        .expect(200)
      expect(newPasswordLogin.body).toHaveProperty('token')
    }, 30_000)
  }
)
