import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { Pool } from 'pg'
import {
  type ExternalRestHttpProcess,
  boundedRequest as request,
  startExternalRestHttpProcess,
} from './helpers/externalRestHttpProcess.js'
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
  let publicApp: string
  let publicProcess: ExternalRestHttpProcess
  let bcrypt: typeof import('bcryptjs').default
  let sourceCounter = 1
  let oneUseResetMutationPosts = 0
  const invitationFlowFixtures = new Map<string, { email: string; invitationUuid: string }>()

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
    vi.doMock('../src/services/invitationFlowRegistrationService.js', () => ({
      validateInvitationFlowToken: vi.fn(async (token: string, email?: string) => {
        const flow = invitationFlowFixtures.get(token)
        if (!flow || (email && flow.email !== email.toLowerCase())) {
          throw new Error('invalid synthetic invitation flow')
        }
        return flow
      }),
      storeDesktopAuthorizationToken: vi.fn(),
    }))

    bcrypt = (await import('bcryptjs')).default
    db = await import('../src/db.js')
    await db.initDb()
    const { requireInternalService, requireInternalToken } =
      await import('../src/middleware/internalServiceAuth.js')
    const { clerumErrorHandler } = await import('../src/http/errorHandler.js')
    const { createExternalInvitationsRouter } =
      await import('../src/routes/external/invitations.js')
    const { createExternalAuthRouter } = await import('../src/routes/external/auth.js')
    const { createExternalUsersRouter } = await import('../src/routes/external/users.js')

    controlApp = express()
    controlApp.use(express.json())
    controlApp.use((req, _res, next) => {
      if (req.method === 'POST' && req.path === '/api/v1/external/invitations/password-token') {
        oneUseResetMutationPosts++
      }
      next()
    })
    controlApp.use(requireInternalToken)
    const controlApi = express.Router()
    controlApi.use('/external', requireInternalService('external-rest-api'))
    controlApi.use(createExternalInvitationsRouter())
    controlApi.use(createExternalAuthRouter({} as Parameters<typeof createExternalAuthRouter>[0]))
    controlApi.use(createExternalUsersRouter({} as Parameters<typeof createExternalUsersRouter>[0]))
    controlApp.use('/api/v1', controlApi)
    controlApp.use(clerumErrorHandler)
    controlServer = controlApp.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => controlServer.once('listening', resolve))

    publicProcess = await startExternalRestHttpProcess({
      controlApiBaseUrl: `http://127.0.0.1:${(controlServer.address() as { port: number }).port}/api/v1`,
      controlApiServiceToken: serviceToken,
      jwtPublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    })
    publicApp = publicProcess.baseUrl
  }, 60_000)

  afterAll(async () => {
    let childCleanup: PromiseSettledResult<void | undefined> | undefined
    try {
      ;[childCleanup] = await Promise.allSettled([publicProcess?.stop()])
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
    if (childCleanup?.status === 'rejected') throw childCleanup.reason
  })

  async function acceptedInvitationSession() {
    const { acceptInvitationForEmail, createSilentInvitationForTeams } =
      await import('../src/services/directory/membership.js')
    const { signExternalSessionToken } =
      await import('../src/utils/auth/externalSessionAuthToken.js')
    const { verifyExternalSessionToken: verifyToken } =
      await import('../src/utils/auth/externalSessionAuthToken.js')
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

  async function invitationPasswordRequestWithoutSession(
    invitation: { id: string; token: string },
    email: string,
    sourceIp: string,
    password = invitationPassword
  ) {
    return request(publicApp)
      .post('/api/v1/invitations/password')
      .set('x-forwarded-for', sourceIp)
      .send({ token: invitation.token, email, invitationId: invitation.id, password })
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
    expect(setPassword.body.reauthenticationRequired).toBe(true)
    expect(String(setPassword.headers['set-cookie'])).toContain('profile_session=;')
    await db.pool.query(
      "UPDATE password_verification_pace SET next_permit = clock_timestamp() - interval '1 second'"
    )
    const login = await request(publicApp)
      .post('/api/v1/auth/password-login')
      .set('x-forwarded-for', nextSourceIp())
      .send({ email: session.email, password: currentPassword })
      .expect(200)
    expect(login.body.token).toEqual(expect.any(String))
    const user = await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [
      session.userId,
    ])
    expect(user.rows[0].password_hash).toEqual(expect.any(String))
    return {
      ...session,
      token: login.body.token as string,
      passwordHash: user.rows[0].password_hash as string,
    }
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
    expect(retried.body.reauthenticationRequired).toBe(true)
    expect(String(retried.headers['set-cookie'])).toContain('profile_session=;')
    expect(
      await bcrypt.compare(
        invitationPassword,
        (await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [session.userId]))
          .rows[0].password_hash
      )
    ).toBe(true)
  })

  it('rolls back a callback TypeError and returns a sanitized non-retryable 500', async () => {
    const session = await acceptedInvitationSession()
    const failure = new TypeError('private SQL and credential diagnostic')
    const hash = vi.spyOn(bcrypt, 'hash').mockRejectedValueOnce(failure)

    let response: Awaited<ReturnType<typeof invitationPasswordRequest>>
    try {
      response = await invitationPasswordRequest(session, nextSourceIp())
    } finally {
      hash.mockRestore()
    }

    expect(response.status).toBe(500)
    expect(response.body).toMatchObject({ error: 'internal_error' })
    expect(response.headers['retry-after']).toBeUndefined()
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.text).not.toContain('private SQL')
    expect(response.text).not.toContain('credential diagnostic')
    expect(
      (await db.pool.query('SELECT status FROM invitations WHERE id = $1', [session.invitationId]))
        .rows[0].status
    ).toBe('accepted')
    expect(
      (await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [session.userId]))
        .rows[0].password_hash
    ).toBeNull()
    expect(
      (await db.pool.query('SELECT COUNT(*)::int AS count FROM password_verification_work')).rows[0]
        .count
    ).toBe(0)
  })

  it('rolls back a one-use reset callback TypeError without retrying the proof', async () => {
    const email = `r2m1-reset-callback-${randomBytes(8).toString('hex')}@example.invalid`
    const user = await db.pool.query('INSERT INTO users(email) VALUES ($1) RETURNING id', [email])
    const { createSilentPasswordResetInvitation } =
      await import('../src/services/directory/passwordResetInvitations.js')
    const invitation = await createSilentPasswordResetInvitation({
      inviteeName: 'Synthetic callback-failure reset',
      email,
    })
    const flowToken = `synthetic-reset-callback-${randomBytes(20).toString('hex')}`
    invitationFlowFixtures.set(flowToken, { email, invitationUuid: invitation.token })
    const mutationPostsBefore = oneUseResetMutationPosts
    const failure = new TypeError('private reset SQL and proof diagnostic')
    const hash = vi.spyOn(bcrypt, 'hash').mockRejectedValueOnce(failure)

    let response: Awaited<ReturnType<typeof invitationPasswordRequestWithoutSession>>
    try {
      response = await invitationPasswordRequestWithoutSession(
        { id: invitation.id, token: flowToken },
        email,
        nextSourceIp()
      )
    } finally {
      hash.mockRestore()
    }

    expect(response.status).toBe(500)
    expect(response.body).toMatchObject({ error: 'internal_error' })
    expect(response.headers['retry-after']).toBeUndefined()
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.text).not.toContain('private reset SQL')
    expect(response.text).not.toContain('proof diagnostic')
    expect(oneUseResetMutationPosts - mutationPostsBefore).toBe(1)
    expect(
      (
        await db.pool.query(
          `SELECT i.status, u.password_hash
             FROM invitations i JOIN users u ON u.id = $2
            WHERE i.id = $1`,
          [invitation.id, user.rows[0].id]
        )
      ).rows[0]
    ).toMatchObject({ status: 'pending', password_hash: null })
    expect(
      (await db.pool.query('SELECT COUNT(*)::int AS count FROM password_verification_work')).rows[0]
        .count
    ).toBe(0)
  })

  it.each(['member_invitation', 'admin_desktop_access'] as const)(
    'composes token-based %s onboarding through the ordinary endpoint and persists its identity',
    async purpose => {
      const { createSilentInvitationForTeams } =
        await import('../src/services/directory/membership.js')
      const email = `r16-${purpose}-${randomBytes(8).toString('hex')}@example.invalid`
      const teamId = (
        await db.pool.query('INSERT INTO teams(name) VALUES ($1) RETURNING id', [
          `Synthetic ${purpose} onboarding team`,
        ])
      ).rows[0].id as string
      const role = purpose === 'admin_desktop_access' ? 'admin' : 'member'
      const invitation = await createSilentInvitationForTeams({
        inviteeName: `Synthetic ${purpose} invitee`,
        email,
        purpose,
        teamAssignments: [{ teamId, role }],
        fallbackRole: role,
      })
      const flowToken = `synthetic-r16-flow-${randomBytes(20).toString('hex')}`
      invitationFlowFixtures.set(flowToken, { email, invitationUuid: invitation.token })
      const password = `Synthetic-${purpose}-Onboarding-123`
      const response = await invitationPasswordRequestWithoutSession(
        { id: invitation.id, token: flowToken },
        email,
        nextSourceIp(),
        password
      )

      expect(response.status, JSON.stringify(response.body)).toBe(200)
      expect(response.body).toMatchObject({
        passwordUpdated: true,
        reauthenticationRequired: true,
        purpose,
        status: 'accepted',
        email,
        role,
      })
      expect(String(response.headers['set-cookie'])).toContain('profile_session=;')

      const invitationRow = await db.pool.query(
        'SELECT purpose, status, accepted_user_id FROM invitations WHERE id = $1',
        [invitation.id]
      )
      expect(invitationRow.rows).toEqual([
        expect.objectContaining({
          purpose,
          status: 'accepted',
          accepted_user_id: response.body.userId,
        }),
      ])
      const userRow = await db.pool.query(
        'SELECT id, email, password_hash FROM users WHERE id = $1',
        [response.body.userId]
      )
      expect(userRow.rows[0]).toMatchObject({ id: response.body.userId, email })
      expect(await bcrypt.compare(password, userRow.rows[0].password_hash)).toBe(true)
      const memberships = await db.pool.query(
        'SELECT team_id, role, status FROM team_members WHERE user_id = $1 AND team_id = $2',
        [response.body.userId, teamId]
      )
      expect(memberships.rows).toEqual([{ team_id: teamId, role, status: 'active' }])

      expect(response.body).not.toHaveProperty('token')
      await db.pool.query(
        "UPDATE password_verification_pace SET next_permit = clock_timestamp() - interval '1 second'"
      )
      const login = await request(publicApp)
        .post('/api/v1/auth/password-login')
        .set('x-forwarded-for', nextSourceIp())
        .send({ email, password })
        .expect(200)
      const sessionCookie = String(login.headers['set-cookie'])
        .split(';', 1)[0]
        .replace(/^profile_session=/, '')
      const identity = await request(publicApp)
        .get('/api/v1/me')
        .set('cookie', `profile_session=${sessionCookie}`)
      expect(identity.status).toBe(200)
      expect(identity.body).toMatchObject({ id: response.body.userId, email, role })
    }
  )

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
    expect(retried.body.reauthenticationRequired).toBe(true)
    expect(String(retried.headers['set-cookie'])).toContain('profile_session=;')
  })

  it('maps authenticated password-change authority outcomes and permits a later retry', async () => {
    const member = await memberWithPassword()
    const sourceIp = nextSourceIp()
    const owner = await passwordOwner()
    let busy: Awaited<ReturnType<typeof memberPasswordRequest>>
    try {
      busy = await memberPasswordRequest(member.token, sourceIp)
    } finally {
      await owner.release()
    }
    expect(busy.status).toBe(429)
    expect(busy.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 8 })
    expect(busy.headers['retry-after']).toBe('8')
    expect(JSON.stringify(busy.body)).not.toMatch(/verification_busy|Control API|external\/users/i)
    expect(
      (await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [member.userId]))
        .rows[0].password_hash
    ).toBe(member.passwordHash)
    const retry = await memberPasswordRequest(member.token, sourceIp)
    expect(retry.status).toBe(200)
    expect(
      await bcrypt.compare(
        replacementPassword,
        (await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [member.userId]))
          .rows[0].password_hash
      )
    ).toBe(true)

    const unavailableMember = await memberWithPassword()
    const unavailableSourceIp = nextSourceIp()
    const unavailable = await withPasswordAuthorityUnavailable(() =>
      memberPasswordRequest(unavailableMember.token, unavailableSourceIp)
    )
    expect(unavailable.status).toBe(503)
    expect(unavailable.body).toEqual({ error: 'authority_unavailable', retryAfterSeconds: 2 })
    expect(unavailable.headers['retry-after']).toBe('2')
    expect(JSON.stringify(unavailable.body)).not.toMatch(
      /authority_failure|Control API|external\/users|relation/i
    )
    expect(
      (
        await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [
          unavailableMember.userId,
        ])
      ).rows[0].password_hash
    ).toBe(unavailableMember.passwordHash)
  })

  it('revokes the pre-reset session, sets no session, rejects the old password, and accepts a fresh login', async () => {
    const member = await memberWithPassword()
    const sessionCookie = `profile_session=${member.token}`
    const beforeReset = await request(publicApp).get('/api/v1/me').set('cookie', sessionCookie)
    expect(beforeReset.status).toBe(200)
    expect(beforeReset.body).toMatchObject({ id: member.userId, email: member.email })

    const { createSilentPasswordResetInvitation } =
      await import('../src/services/directory/passwordResetInvitations.js')
    const invitation = await createSilentPasswordResetInvitation({
      inviteeName: 'Synthetic pre-reset session',
      email: member.email,
    })
    const flowToken = `synthetic-reset-revokes-${randomBytes(20).toString('hex')}`
    invitationFlowFixtures.set(flowToken, {
      email: member.email,
      invitationUuid: invitation.token,
    })
    const resetPassword = `Synthetic-Reset-Revokes-${randomBytes(8).toString('hex')}`

    const reset = await request(publicApp)
      .post('/api/v1/invitations/password')
      .set('cookie', sessionCookie)
      .set('origin', 'http://127.0.0.1')
      .set('x-forwarded-for', nextSourceIp())
      .send({
        token: flowToken,
        email: member.email,
        invitationId: invitation.id,
        password: resetPassword,
      })

    expect(reset.status, JSON.stringify(reset.body)).toBe(200)
    expect(reset.body).toMatchObject({
      userId: member.userId,
      passwordUpdated: true,
      reauthenticationRequired: true,
    })
    expect(reset.body).not.toHaveProperty('token')
    expect(reset.body).not.toHaveProperty('sessionContext')
    expect(String(reset.headers['set-cookie'])).toContain('profile_session=;')
    expect(String(reset.headers['set-cookie'])).not.toMatch(/profile_session=[^;]+/)

    const revoked = await request(publicApp).get('/api/v1/me').set('cookie', sessionCookie)
    expect(revoked.status).toBe(401)

    await db.pool.query(
      "UPDATE password_verification_pace SET next_permit = clock_timestamp() - interval '1 second'"
    )
    const stalePasswordLogin = await request(publicApp)
      .post('/api/v1/auth/password-login')
      .set('x-forwarded-for', nextSourceIp())
      .send({ email: member.email, password: currentPassword })
    expect(stalePasswordLogin.status).toBe(401)
    await db.pool.query(
      "UPDATE password_verification_pace SET next_permit = clock_timestamp() - interval '1 second'"
    )
    const login = await request(publicApp)
      .post('/api/v1/auth/password-login')
      .set('x-forwarded-for', nextSourceIp())
      .send({ email: member.email, password: resetPassword })
    expect(login.status).toBe(200)
    expect(login.body.token).toEqual(expect.any(String))
    const freshCookie = `profile_session=${login.body.token as string}`
    const freshSession = await request(publicApp).get('/api/v1/me').set('cookie', freshCookie)
    expect(freshSession.status).toBe(200)
    expect(freshSession.body).toMatchObject({ id: member.userId, email: member.email })
    expect(
      await bcrypt.compare(
        resetPassword,
        (await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [member.userId]))
          .rows[0].password_hash
      )
    ).toBe(true)
  })
})
