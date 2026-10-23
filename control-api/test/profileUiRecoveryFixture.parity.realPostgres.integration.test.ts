import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { Pool } from 'pg'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip

type FixtureModule = {
  RECOVERY_CONTROL_API_SERVICE_TOKEN: string
  RECOVERY_INVITATIONS: Array<{
    token: string
    id: string
    email: string
    purpose: string
    status: string
    role: string
    teamId: string | null
    teamName: string | null
    userId: string | null
    expiresAt: string
    acceptedAt: string | null
  }>
  RECOVERY_PASSWORDS: Record<'recovery' | 'logout' | 'replacement' | 'onboarding', string>
  RECOVERY_USERS: Record<
    'onboarding' | 'recovery' | 'logout' | 'usedInvitee',
    {
      id: string
      email: string
      name: string
      teamId: string | null
      teamName: string | null
      role: string
      password: string | null
    }
  >
  createRecoveryControlApi: (options: { privateKey: unknown }) => Promise<{
    handle: (input: {
      method: string
      path: string
      headers: Record<string, string>
      body?: unknown
    }) => Promise<{ status: number; body: unknown }>
  }>
}

function bodyShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(bodyShape)
  if (!value || typeof value !== 'object') return typeof value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, bodyShape(entry)])
  )
}

realPg('Profile UI recovery lane fixture parity on PostgreSQL 16', () => {
  const database = `profile_ui_fixture_parity_${randomBytes(6).toString('hex')}`
  const internalServiceToken = `synthetic-fixture-parity-${randomBytes(20).toString('hex')}`
  let admin: Pool
  let db: typeof import('../src/db.js')
  let controlServer: Server
  let fixture: Awaited<ReturnType<FixtureModule['createRecoveryControlApi']>>
  let fixtureModule: FixtureModule
  let privateKeyPem: string
  let sourceCounter = 1

  function nextSourceIp() {
    sourceCounter += 1
    return `198.51.100.${sourceCounter % 250}`
  }

  async function requestReal(
    method: 'GET' | 'POST',
    path: string,
    input: { body?: unknown; sessionToken?: string } = {}
  ) {
    const target = controlServer.address()
    if (!target || typeof target === 'string') throw new Error('control server did not bind TCP')
    const url = `http://127.0.0.1:${target.port}/api/v1${path}`
    const headers: Record<string, string> = {
      authorization: `Bearer ${internalServiceToken}`,
      'x-service-token': 'external-rest-api',
      'x-external-client-ip': nextSourceIp(),
    }
    if (input.sessionToken) headers['x-user-session-token'] = input.sessionToken
    const response = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }

  async function requestFixture(
    method: 'GET' | 'POST',
    path: string,
    input: { body?: unknown; sessionToken?: string } = {}
  ) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${fixtureModule.RECOVERY_CONTROL_API_SERVICE_TOKEN}`,
      'x-service-token': 'external-rest-api',
    }
    if (input.sessionToken) headers['x-user-session-token'] = input.sessionToken
    return fixture.handle({ method, path, headers, body: input.body })
  }

  async function expectParity(
    method: 'GET' | 'POST',
    path: string,
    input: { body?: unknown; sessionToken?: string } = {}
  ) {
    const real = await requestReal(method, path, input)
    const synthetic = await requestFixture(method, path, input)
    expect(synthetic.status, `${method} ${path}`).toBe(real.status)
    expect(bodyShape(synthetic.body), `${method} ${path}`).toEqual(bodyShape(real.body))
    return { real, synthetic }
  }

  async function openPasswordPace() {
    await db.pool.query(
      "UPDATE password_verification_pace SET next_permit = clock_timestamp() - interval '1 second'"
    )
  }

  async function loginReal(email: string, password: string) {
    return requestReal('POST', '/external/auth/password-login', { body: { email, password } })
  }

  async function loginFixture(email: string, password: string) {
    return requestFixture('POST', '/external/auth/password-login', { body: { email, password } })
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const databaseUrl = new URL(adminUrl!)
    databaseUrl.pathname = `/${database}`
    vi.stubEnv('CONTROL_API_PG_CONNECTION_STRING', databaseUrl.toString())
    vi.stubEnv('CONTROL_API_INTERNAL_SERVICE_TOKENS', `external-rest-api=${internalServiceToken}`)
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    vi.stubEnv('CONTROL_API_SESSION_JWT_PRIVATE_KEY', privateKeyPem)
    vi.stubEnv(
      'EXTERNAL_REST_API_JWT_PUBLIC_KEY',
      publicKey.export({ type: 'spki', format: 'pem' }).toString()
    )
    vi.resetModules()
    fixtureModule =
      (await import('../../tests/e2e/playwright/profile-ui-recovery-control-api.mjs')) as FixtureModule
    vi.doMock('../src/services/invitationFlowRegistrationService.js', () => ({
      validateInvitationFlowToken: vi.fn(async (token: string, email?: string) => {
        const invitation = fixtureModule.RECOVERY_INVITATIONS.find(row => row.token === token)
        if (!invitation) throw new Error('invalid synthetic invitation flow')
        if (email && invitation.email.toLowerCase() !== email.toLowerCase()) {
          throw new Error('invalid synthetic invitation flow')
        }
        return { email: invitation.email, invitationUuid: invitation.token }
      }),
      storeDesktopAuthorizationToken: vi.fn(),
    }))

    db = await import('../src/db.js')
    await db.initDb()
    fixture = await fixtureModule.createRecoveryControlApi({ privateKey })

    for (const user of Object.values(fixtureModule.RECOVERY_USERS)) {
      const passwordHash = user.password ? await bcrypt.hash(user.password, 12) : null
      await db.pool.query(
        `INSERT INTO users(id, email, name, password_hash, lifecycle_version)
         VALUES ($1, $2, $3, $4, 1)`,
        [user.id, user.email, user.name, passwordHash]
      )
      await db.pool.query(
        `INSERT INTO profiles(user_id, display_name, channels) VALUES ($1, $2, $3::jsonb)`,
        [user.id, user.name, JSON.stringify({})]
      )
      if (user.teamId) {
        await db.pool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [
          user.teamId,
          user.teamName,
        ])
        await db.pool.query(
          `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
          [user.teamId, user.id, user.role]
        )
      }
    }
    for (const invitation of fixtureModule.RECOVERY_INVITATIONS) {
      await db.pool.query(
        `INSERT INTO invitations(
           id, team_id, email, role, token, status, purpose, expires_at, accepted_at, accepted_user_id, invitee_name
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          invitation.id,
          invitation.teamId,
          invitation.email,
          invitation.role,
          invitation.token,
          invitation.status,
          invitation.purpose,
          invitation.expiresAt,
          invitation.acceptedAt,
          invitation.status === 'accepted' ? invitation.userId : null,
          'Synthetic recovery fixture invitee',
        ]
      )
    }

    const { requireInternalService, requireInternalToken } =
      await import('../src/middleware/internalServiceAuth.js')
    const { clerumErrorHandler } = await import('../src/http/errorHandler.js')
    const { createExternalInvitationsRouter } =
      await import('../src/routes/external/invitations.js')
    const { createExternalAuthRouter } = await import('../src/routes/external/auth.js')
    const { createExternalUsersRouter } = await import('../src/routes/external/users.js')

    const app = express()
    app.use(express.json())
    app.use(requireInternalToken)
    const controlApi = express.Router()
    controlApi.use('/external', requireInternalService('external-rest-api'))
    controlApi.use(createExternalInvitationsRouter())
    controlApi.use(createExternalAuthRouter({} as Parameters<typeof createExternalAuthRouter>[0]))
    controlApi.use(createExternalUsersRouter({} as Parameters<typeof createExternalUsersRouter>[0]))
    app.use('/api/v1', controlApi)
    app.use(clerumErrorHandler)
    controlServer = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => controlServer.once('listening', resolve))
  }, 120_000)

  afterAll(async () => {
    try {
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
      vi.doUnmock('../src/services/invitationFlowRegistrationService.js')
    }
  })

  it('returns the same invitation preview for pending, used, expired and invented tokens', async () => {
    for (const token of [
      'synthetic-member-invitation',
      'synthetic-reset-proof',
      'synthetic-used-invitation',
      'synthetic-expired-invitation',
      'synthetic-invented-token',
    ]) {
      await expectParity('GET', `/external/invitations/token/${token}`)
    }
  })

  it('parities rejected invitation mutations without creating a session', async () => {
    const rejected = [
      {
        path: '/external/invitations/accept',
        body: {
          email: fixtureModule.RECOVERY_USERS.recovery.email,
          token: 'synthetic-reset-proof',
        },
        error: 'not_pending',
      },
      {
        path: '/external/invitations/accept',
        body: {
          email: fixtureModule.RECOVERY_USERS.onboarding.email,
          token: 'synthetic-invented-token',
        },
        error: 'invalid_invitation',
      },
      {
        path: '/external/invitations/password-token',
        body: {
          email: fixtureModule.RECOVERY_USERS.recovery.email,
          token: 'synthetic-invented-token',
          invitationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          password: 'Synthetic-Fixture-Parity-123',
        },
        error: 'invalid_invitation',
      },
      {
        path: '/external/invitations/password-token',
        body: {
          email: 'wrong-recovery@example.invalid',
          token: 'synthetic-reset-proof',
          invitationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          password: 'Synthetic-Fixture-Parity-123',
        },
        error: 'invalid_invitation',
      },
      {
        path: '/external/invitations/password-token',
        body: {
          email: fixtureModule.RECOVERY_USERS.recovery.email,
          token: 'synthetic-reset-proof',
          invitationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
          password: 'Synthetic-Fixture-Parity-123',
        },
        error: 'forbidden',
      },
    ]
    for (const scenario of rejected) {
      const parity = await expectParity('POST', scenario.path, { body: scenario.body })
      expect(parity.real.status).toBeGreaterThanOrEqual(400)
      expect(parity.real.body).toMatchObject({ error: scenario.error })
      expect(parity.synthetic.body).not.toHaveProperty('token')
    }
  })

  it('parities an owner replay of an accepted invitation as a success without a session', async () => {
    const before = await db.pool.query(
      'SELECT status, accepted_at FROM invitations WHERE id = $1',
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3']
    )
    const parity = await expectParity('POST', '/external/invitations/accept', {
      body: {
        email: fixtureModule.RECOVERY_USERS.usedInvitee.email,
        token: 'synthetic-used-invitation',
      },
    })
    expect(parity.real.status).toBe(200)
    expect(parity.real.body).toMatchObject({ accepted: true, replay: true })
    expect(parity.synthetic.body).toMatchObject({ accepted: true, replay: true })
    expect(parity.real.body).not.toHaveProperty('token')
    expect(parity.synthetic.body).not.toHaveProperty('token')
    const after = await db.pool.query('SELECT status, accepted_at FROM invitations WHERE id = $1', [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    ])
    expect(before.rows[0].status).toBe('accepted')
    expect(after.rows).toEqual(before.rows)
  })

  it('parities accept, authenticated password setup and the resulting session identity', async () => {
    const accepted = await expectParity('POST', '/external/invitations/accept', {
      body: {
        email: fixtureModule.RECOVERY_USERS.onboarding.email,
        token: 'synthetic-member-invitation',
      },
    })
    expect(accepted.real.status).toBe(200)
    const realToken = (accepted.real.body as { token: string }).token
    const fixtureToken = (accepted.synthetic.body as { token: string }).token
    expect(realToken).toEqual(expect.any(String))
    expect(fixtureToken).toEqual(expect.any(String))

    const passwordPayload = {
      userId: fixtureModule.RECOVERY_USERS.onboarding.id,
      email: fixtureModule.RECOVERY_USERS.onboarding.email,
      invitationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      password: fixtureModule.RECOVERY_PASSWORDS.onboarding,
    }
    const realPassword = await requestReal('POST', '/external/invitations/password', {
      body: passwordPayload,
      sessionToken: realToken,
    })
    const fixturePassword = await requestFixture('POST', '/external/invitations/password', {
      body: passwordPayload,
      sessionToken: fixtureToken,
    })
    expect(fixturePassword.status, JSON.stringify(fixturePassword.body)).toBe(realPassword.status)
    expect(bodyShape(fixturePassword.body)).toEqual(bodyShape(realPassword.body))
    expect(realPassword.status).toBe(200)

    await openPasswordPace()
    const realLogin = await loginReal(
      fixtureModule.RECOVERY_USERS.onboarding.email,
      fixtureModule.RECOVERY_PASSWORDS.onboarding
    )
    const fixtureLogin = await loginFixture(
      fixtureModule.RECOVERY_USERS.onboarding.email,
      fixtureModule.RECOVERY_PASSWORDS.onboarding
    )
    expect(fixtureLogin.status).toBe(realLogin.status)
    expect(bodyShape(fixtureLogin.body)).toEqual(bodyShape(realLogin.body))
    expect(realLogin.status).toBe(200)

    const realMe = await requestReal(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.onboarding.id}/me?teamId=${fixtureModule.RECOVERY_USERS.onboarding.teamId}`,
      { sessionToken: (realLogin.body as { token: string }).token }
    )
    const fixtureMe = await requestFixture(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.onboarding.id}/me?teamId=${fixtureModule.RECOVERY_USERS.onboarding.teamId}`,
      { sessionToken: (fixtureLogin.body as { token: string }).token }
    )
    expect(fixtureMe.status).toBe(realMe.status)
    expect(bodyShape(fixtureMe.body)).toEqual(bodyShape(realMe.body))
    expect(realMe.status).toBe(200)

    const repeatPayload = {
      userId: fixtureModule.RECOVERY_USERS.onboarding.id,
      email: fixtureModule.RECOVERY_USERS.onboarding.email,
      invitationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      password: fixtureModule.RECOVERY_PASSWORDS.replacement,
    }
    const realRepeat = await requestReal('POST', '/external/invitations/password', {
      body: repeatPayload,
      sessionToken: (realLogin.body as { token: string }).token,
    })
    const fixtureRepeat = await requestFixture('POST', '/external/invitations/password', {
      body: repeatPayload,
      sessionToken: (fixtureLogin.body as { token: string }).token,
    })
    expect(fixtureRepeat.status).toBe(realRepeat.status)
    expect(bodyShape(fixtureRepeat.body)).toEqual(bodyShape(realRepeat.body))
    expect(realRepeat.status).toBe(409)
    expect(realRepeat.body).toEqual({ error: 'password_already_set' })
    expect(fixtureRepeat.body).toEqual({ error: 'password_already_set' })

    // The refused repeat leaves the first password in place on both sides.
    await openPasswordPace()
    const realKeptLogin = await loginReal(
      fixtureModule.RECOVERY_USERS.onboarding.email,
      fixtureModule.RECOVERY_PASSWORDS.onboarding
    )
    const fixtureKeptLogin = await loginFixture(
      fixtureModule.RECOVERY_USERS.onboarding.email,
      fixtureModule.RECOVERY_PASSWORDS.onboarding
    )
    expect(realKeptLogin.status).toBe(200)
    expect(fixtureKeptLogin.status).toBe(200)

    const realRevoked = await requestReal(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.onboarding.id}/me?teamId=${fixtureModule.RECOVERY_USERS.onboarding.teamId}`,
      { sessionToken: realToken }
    )
    const fixtureRevoked = await requestFixture(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.onboarding.id}/me?teamId=${fixtureModule.RECOVERY_USERS.onboarding.teamId}`,
      { sessionToken: fixtureToken }
    )
    expect(fixtureRevoked.status).toBe(realRevoked.status)
    expect(bodyShape(fixtureRevoked.body)).toEqual(bodyShape(realRevoked.body))
    expect(realRevoked.status).toBe(401)
  })

  it('parities reset completion, the revoked prior session and the fresh login session', async () => {
    await openPasswordPace()
    const priorLogin = await loginReal(
      fixtureModule.RECOVERY_USERS.recovery.email,
      fixtureModule.RECOVERY_PASSWORDS.recovery
    )
    const priorFixtureLogin = await loginFixture(
      fixtureModule.RECOVERY_USERS.recovery.email,
      fixtureModule.RECOVERY_PASSWORDS.recovery
    )
    expect(priorLogin.status).toBe(200)
    expect(priorFixtureLogin.status).toBe(200)
    const priorRealToken = (priorLogin.body as { token: string }).token
    const priorFixtureToken = (priorFixtureLogin.body as { token: string }).token
    const validBefore = await requestReal(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.recovery.id}/me?teamId=`,
      { sessionToken: priorRealToken }
    )
    expect(validBefore.status).toBe(200)
    const fixtureValidBefore = await requestFixture(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.recovery.id}/me?teamId=`,
      { sessionToken: priorFixtureToken }
    )
    expect(fixtureValidBefore.status).toBe(200)

    const resetPayload = {
      email: fixtureModule.RECOVERY_USERS.recovery.email,
      token: 'synthetic-reset-proof',
      invitationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      password: fixtureModule.RECOVERY_PASSWORDS.replacement,
    }
    await expectParity('POST', '/external/invitations/password-token', { body: resetPayload })

    const realRevoked = await requestReal(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.recovery.id}/me?teamId=`,
      { sessionToken: priorRealToken }
    )
    const fixtureRevoked = await requestFixture(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.recovery.id}/me?teamId=`,
      { sessionToken: priorFixtureToken }
    )
    expect(fixtureRevoked.status).toBe(realRevoked.status)
    expect(bodyShape(fixtureRevoked.body)).toEqual(bodyShape(realRevoked.body))
    expect(realRevoked.status).toBe(401)

    await openPasswordPace()
    const realLogin = await loginReal(
      fixtureModule.RECOVERY_USERS.recovery.email,
      fixtureModule.RECOVERY_PASSWORDS.replacement
    )
    const fixtureLogin = await loginFixture(
      fixtureModule.RECOVERY_USERS.recovery.email,
      fixtureModule.RECOVERY_PASSWORDS.replacement
    )
    expect(fixtureLogin.status).toBe(realLogin.status)
    expect(bodyShape(fixtureLogin.body)).toEqual(bodyShape(realLogin.body))
    expect(realLogin.status).toBe(200)
    const realFreshMe = await requestReal(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.recovery.id}/me?teamId=`,
      { sessionToken: (realLogin.body as { token: string }).token }
    )
    const fixtureFreshMe = await requestFixture(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.recovery.id}/me?teamId=`,
      { sessionToken: (fixtureLogin.body as { token: string }).token }
    )
    expect(fixtureFreshMe.status).toBe(realFreshMe.status)
    expect(bodyShape(fixtureFreshMe.body)).toEqual(bodyShape(realFreshMe.body))
    expect(realFreshMe.status).toBe(200)
  })

  it('parities login, wrong-password and logout handlers', async () => {
    await openPasswordPace()
    const loggedIn = await expectParity('POST', '/external/auth/password-login', {
      body: {
        email: fixtureModule.RECOVERY_USERS.logout.email,
        password: fixtureModule.RECOVERY_PASSWORDS.logout,
      },
    })
    expect(loggedIn.real.status).toBe(200)
    const realToken = (loggedIn.real.body as { token: string }).token
    const fixtureToken = (loggedIn.synthetic.body as { token: string }).token

    await openPasswordPace()
    await expectParity('POST', '/external/auth/password-login', {
      body: {
        email: fixtureModule.RECOVERY_USERS.logout.email,
        password: 'synthetic-definitely-not-the-password',
      },
    })

    const realLogout = await requestReal('POST', '/external/auth/session/logout', {
      sessionToken: realToken,
    })
    const fixtureLogout = await requestFixture('POST', '/external/auth/session/logout', {
      sessionToken: fixtureToken,
    })
    expect(fixtureLogout.status).toBe(realLogout.status)
    expect(bodyShape(fixtureLogout.body)).toEqual(bodyShape(realLogout.body))
    expect(realLogout.status).toBe(200)

    const realRevoked = await requestReal(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.logout.id}/me?teamId=`,
      { sessionToken: realToken }
    )
    const fixtureRevoked = await requestFixture(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.logout.id}/me?teamId=`,
      { sessionToken: fixtureToken }
    )
    expect(fixtureRevoked.status).toBe(realRevoked.status)
    expect(bodyShape(fixtureRevoked.body)).toEqual(bodyShape(realRevoked.body))
    expect(realRevoked.status).toBe(401)

    await expectParity(
      'GET',
      `/external/users/${fixtureModule.RECOVERY_USERS.logout.id}/me?teamId=`
    )
  })

  it('rejects a member invitation on the reset producer in both implementations', async () => {
    const payload = {
      email: fixtureModule.RECOVERY_USERS.usedInvitee.email,
      token: 'synthetic-used-invitation',
      invitationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      password: 'Synthetic-Fixture-Parity-123',
    }
    const parity = await expectParity('POST', '/external/invitations/password-token', {
      body: payload,
    })
    expect(parity.real.status).toBe(409)
    const realRow = await db.pool.query('SELECT status FROM invitations WHERE id = $1', [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    ])
    const fixtureRow = (await fixture.handle({
      method: 'GET',
      path: '/external/invitations/token/synthetic-used-invitation',
      headers: {
        authorization: `Bearer ${fixtureModule.RECOVERY_CONTROL_API_SERVICE_TOKEN}`,
        'x-service-token': 'external-rest-api',
      },
    })) as { body: { status: string } }
    expect(realRow.rows[0].status).toBe('accepted')
    expect(fixtureRow.body.status).toBe('accepted')
  })
})
