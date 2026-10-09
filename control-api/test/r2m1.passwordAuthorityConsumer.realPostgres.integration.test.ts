import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { Pool } from 'pg'
import request from 'supertest'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip

realPg('R2-M1/R2-M2 public password authority contract on PostgreSQL 16', () => {
  const database = `r2m1_authority_${randomBytes(6).toString('hex')}`
  const serviceToken = `synthetic-external-rest-${randomBytes(20).toString('hex')}`
  const invitationPassword = 'Synthetic-Invitation-Password-123'
  const currentPassword = 'Synthetic-Current-Password-123'
  const replacementPassword = 'Synthetic-Replacement-Password-123'
  let admin: Pool
  let db: typeof import('../src/db.js')
  let controlApp: express.Express
  let controlServer: Server
  let publicApp: express.Express
  let bcrypt: typeof import('bcryptjs').default
  let externalConfig: (typeof import('../../external-rest-api/src/config.js'))['config']
  let previousBaseUrl: string
  let previousServiceToken: string
  let sourceCounter = 1

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const databaseUrl = new URL(adminUrl!)
    databaseUrl.pathname = `/${database}`
    vi.stubEnv('CONTROL_API_PG_CONNECTION_STRING', databaseUrl.toString())
    vi.stubEnv('CONTROL_API_INTERNAL_SERVICE_TOKENS', `external-rest-api=${serviceToken}`)
    vi.stubEnv('EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN', serviceToken)
    vi.stubEnv('EXTERNAL_REST_API_CONTROL_API_SERVICE_NAME', 'external-rest-api')
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    vi.stubEnv(
      'CONTROL_API_SESSION_JWT_PRIVATE_KEY',
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    )
    vi.stubEnv(
      'EXTERNAL_REST_API_JWT_PUBLIC_KEY',
      publicKey.export({ type: 'spki', format: 'pem' }).toString()
    )
    vi.resetModules()

    bcrypt = (await import('bcryptjs')).default
    db = await import('../src/db.js')
    await db.initDb()
    const { requireInternalService, requireInternalToken } =
      await import('../src/middleware/internalServiceAuth.js')
    const { createExternalInvitationsRouter } =
      await import('../src/routes/external/invitations.js')
    const { createExternalUsersRouter } = await import('../src/routes/external/users.js')

    controlApp = express()
    controlApp.use(express.json())
    controlApp.use(requireInternalToken)
    const controlApi = express.Router()
    controlApi.use('/external', requireInternalService('external-rest-api'))
    controlApi.use(createExternalInvitationsRouter())
    controlApi.use(createExternalUsersRouter({} as Parameters<typeof createExternalUsersRouter>[0]))
    controlApp.use('/api/v1', controlApi)
    controlServer = controlApp.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => controlServer.once('listening', resolve))

    externalConfig = (await import('../../external-rest-api/src/config.js')).config
    previousBaseUrl = externalConfig.controlApiBaseUrl
    previousServiceToken = externalConfig.controlApiServiceToken
    externalConfig.controlApiBaseUrl = `http://127.0.0.1:${(controlServer.address() as { port: number }).port}/api/v1`
    externalConfig.controlApiServiceToken = serviceToken
    const { createApp } = await import('../../external-rest-api/src/app.js')
    publicApp = createApp()
  }, 60_000)

  afterAll(async () => {
    try {
      if (externalConfig) {
        externalConfig.controlApiBaseUrl = previousBaseUrl
        externalConfig.controlApiServiceToken = previousServiceToken
      }
      if (controlServer) {
        await new Promise<void>((resolve, reject) =>
          controlServer.close(error => (error ? reject(error) : resolve()))
        )
      }
      if (db) {
        await endPoolAndWaitForClients(db.pool)
        await endPoolAndWaitForClients(db.rateLimitPool)
      }
      if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin?.end()
      vi.unstubAllEnvs()
    }
  })

  async function acceptedInvitationSession() {
    const { acceptInvitationForEmail, createSilentInvitationForTeams } =
      await import('../src/services/directory/membership.js')
    const { signExternalSessionToken } =
      await import('../src/utils/auth/externalSessionAuthToken.js')
    const { verifyToken } = await import('../../external-rest-api/src/authToken.js')
    const email = `r2m1-${randomBytes(8).toString('hex')}@example.invalid`
    const invitation = await createSilentInvitationForTeams({
      inviteeName: 'Synthetic invited member',
      email,
      purpose: 'member_invitation',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    const accepted = await acceptInvitationForEmail(email, invitation.token, invitation.id)
    expect(accepted).not.toHaveProperty('error')
    if (!('data' in accepted) || !accepted.data) throw new Error('invitation acceptance failed')
    const user = await db.pool.query('SELECT lifecycle_version FROM users WHERE id = $1', [
      accepted.data.userId,
    ])
    const token = signExternalSessionToken({
      userId: accepted.data.userId,
      email,
      teamId: null,
      role: 'member',
      authGeneration: Number(user.rows[0].lifecycle_version),
    })
    expect(verifyToken(token)).toMatchObject({ userId: accepted.data.userId, email })
    return {
      email,
      userId: accepted.data.userId,
      invitationId: invitation.id,
      token,
    }
  }

  function nextSourceIp() {
    return `198.51.100.${sourceCounter++}`
  }

  async function passwordOwner() {
    const { acquirePasswordWork } = await import('../src/services/auth/passwordWorkOwnership.js')
    const owner = await acquirePasswordWork()
    expect(owner).not.toBeNull()
    if (!owner) throw new Error('password work owner was not acquired')
    return owner
  }

  async function withPasswordAuthorityUnavailable<T>(work: () => Promise<T>): Promise<T> {
    await db.pool.query(
      'ALTER TABLE password_verification_work RENAME TO password_verification_work_unavailable'
    )
    try {
      return await work()
    } finally {
      await db.pool.query(
        'ALTER TABLE password_verification_work_unavailable RENAME TO password_verification_work'
      )
    }
  }

  async function invitationPasswordRequest(
    session: Awaited<ReturnType<typeof acceptedInvitationSession>>,
    sourceIp: string,
    password = invitationPassword
  ) {
    return request(publicApp)
      .post('/api/v1/invitations/password')
      .set('authorization', `Bearer ${session.token}`)
      .set('x-forwarded-for', sourceIp)
      .send({ invitationId: session.invitationId, password })
  }

  async function memberPasswordRequest(
    token: string,
    sourceIp: string,
    nextPassword = replacementPassword
  ) {
    return request(publicApp)
      .put('/api/v1/me/password')
      .set('authorization', `Bearer ${token}`)
      .set('x-forwarded-for', sourceIp)
      .send({ currentPassword, newPassword: nextPassword })
  }

  async function memberWithPassword() {
    const session = await acceptedInvitationSession()
    const setPassword = await invitationPasswordRequest(session, nextSourceIp(), currentPassword)
    expect(setPassword.status).toBe(200)
    const user = await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [
      session.userId,
    ])
    expect(user.rows[0].password_hash).toEqual(expect.any(String))
    return { ...session, passwordHash: user.rows[0].password_hash as string }
  }

  it('returns a sanitized busy response, preserves invitation state, and succeeds on retry', async () => {
    const session = await acceptedInvitationSession()
    const owner = await passwordOwner()
    const sourceIp = nextSourceIp()
    let denied: Awaited<ReturnType<typeof invitationPasswordRequest>>
    try {
      denied = await invitationPasswordRequest(session, sourceIp)
    } finally {
      await owner.release()
    }

    expect(denied.status).toBe(429)
    expect(denied.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 8 })
    expect(denied.headers['retry-after']).toBe('8')
    expect(denied.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(denied.body)).not.toMatch(/verification_busy|password_verification_work/i)
    expect(
      (await db.pool.query('SELECT status FROM invitations WHERE id = $1', [session.invitationId]))
        .rows[0].status
    ).toBe('accepted')
    expect(
      (await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [session.userId]))
        .rows[0].password_hash
    ).toBeNull()

    const retried = await invitationPasswordRequest(session, sourceIp)
    expect(retried.status).toBe(200)
    expect(String(retried.headers['set-cookie'])).toContain('profile_session=')
    expect(
      await bcrypt.compare(
        invitationPassword,
        (await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [session.userId]))
          .rows[0].password_hash
      )
    ).toBe(true)
  })

  it('returns sanitized authority unavailability without consuming invitation state', async () => {
    const session = await acceptedInvitationSession()
    const sourceIp = nextSourceIp()
    const denied = await withPasswordAuthorityUnavailable(() =>
      invitationPasswordRequest(session, sourceIp)
    )

    expect(denied.status).toBe(503)
    expect(denied.body).toEqual({ error: 'authority_unavailable', retryAfterSeconds: 2 })
    expect(denied.headers['retry-after']).toBe('2')
    expect(denied.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(denied.body)).not.toMatch(
      /authority_failure|password_verification_work|relation/i
    )
    expect(
      (await db.pool.query('SELECT status FROM invitations WHERE id = $1', [session.invitationId]))
        .rows[0].status
    ).toBe('accepted')
    expect(
      (await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [session.userId]))
        .rows[0].password_hash
    ).toBeNull()

    const retried = await invitationPasswordRequest(session, sourceIp)
    expect(retried.status).toBe(200)
    expect(String(retried.headers['set-cookie'])).toContain('profile_session=')
  })
})
