import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { createPublicKey, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import { passwordAdmissionDenialsTotal } from '../src/observability/metrics.js'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import { passwordIdentifierKey } from '../src/services/auth/passwordAdmissionState.js'
import { acquirePasswordWork } from '../src/services/auth/passwordWorkOwnership.js'
import { verifyUserPassword } from '../src/services/directory/login.js'
import {
  createInvitationForTeams,
  setInvitationPasswordForEmail,
  updateUserPassword,
} from '../src/services/directory/membership.js'
import { verifyExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({
  pool: null as unknown as Pool,
  leaseClient: null as unknown as import('pg').PoolClient,
}))
const invitationFlow = vi.hoisted(() => ({
  registerAndSendInvitation: vi.fn().mockResolvedValue(undefined),
  validateInvitationFlowToken: vi.fn(),
}))
vi.mock('../src/services/invitationFlowRegistrationService.js', async importOriginal => {
  const real =
    await importOriginal<typeof import('../src/services/invitationFlowRegistrationService.js')>()
  return {
    ...real,
    registerAndSendInvitation: invitationFlow.registerAndSendInvitation,
    validateInvitationFlowToken: invitationFlow.validateInvitationFlowToken,
  }
})
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
      requirements: Parameters<typeof real.acquireRateLimitConcurrencyLease>[0]
    ) => real.acquireRateLimitConcurrencyLease(requirements, { client: holder.leaseClient }),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip
const password = 'Synthetic-BUG192-correct-password'
const realBcryptCompare = bcrypt.compare.bind(bcrypt)
realPg('BUG-192 observable password-login regressions on real PostgreSQL', () => {
  const database = `bug192_${randomBytes(6).toString('hex')}`
  let admin: Pool
  let app: express.Express
  let realHash: string
  let userId: string
  let compare: ReturnType<typeof vi.spyOn>
  // New-state manipulation is only clock/admission setup. At the buggy base
  // it is a no-op so T3 failures remain observable assertions, not absent-schema errors.
  async function newStateExists() {
    return !!(
      await holder.pool.query("SELECT to_regclass('password_identifier_state') AS relation")
    ).rows[0].relation
  }
  async function openPace() {
    if (await newStateExists())
      await holder.pool.query(
        "UPDATE password_verification_pace SET next_permit = clock_timestamp() - interval '1 second'"
      )
  }
  async function login(email: string, submitted = 'Synthetic-wrong-password', ip = '192.0.2.1') {
    return request(app)
      .post('/external/auth/password-login')
      .set('x-external-client-ip', ip)
      .send({ email, password: submitted })
  }
  async function denialCount(reason: string) {
    const metric = await passwordAdmissionDenialsTotal.get()
    return metric.values.find(value => value.labels.reason === reason)?.value ?? 0
  }
  async function recoverPassword(nextPassword: string) {
    const invitation = await createInvitationForTeams({
      inviteeName: 'Synthetic member',
      email: 'member@example.invalid',
      purpose: 'password_reset',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    const proof = 'synthetic-trusted-reset-proof'
    invitationFlow.validateInvitationFlowToken.mockResolvedValue({
      email: 'member@example.invalid',
      invitationUuid: invitation.token,
    })
    const lookup = await request(app).get(`/external/invitations/token/${proof}`).expect(200)
    expect(lookup.body).toMatchObject({
      id: invitation.id,
      purpose: 'password_reset',
      status: 'pending',
    })
    expect(lookup.body).not.toHaveProperty('token')

    const originalPasswordHash = (
      await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])
    ).rows[0].password_hash
    await request(app)
      .post('/external/invitations/password-token')
      .send({
        email: 'member@example.invalid',
        token: proof,
        invitationId: '00000000-0000-4000-8000-000000000000',
        password: nextPassword,
      })
      .expect(403)
    expect(
      (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
        .password_hash
    ).toBe(originalPasswordHash)

    const reset = await request(app)
      .post('/external/invitations/password-token')
      .send({
        email: 'member@example.invalid',
        token: proof,
        invitationId: invitation.id,
        password: nextPassword,
      })
      .expect(200)
    expect(reset.body).not.toHaveProperty('sessionContext')
    expect(reset.body.token).toEqual(expect.any(String))

    const replay = await request(app)
      .post('/external/invitations/password-token')
      .send({
        email: 'member@example.invalid',
        token: proof,
        invitationId: invitation.id,
        password: 'Synthetic-replay-password',
      })
      .expect(409)
    expect(replay.body).not.toHaveProperty('token')

    const access = await request(app)
      .post('/external/auth/verify')
      .send({ token: reset.body.token })
    expect(access.status).toBe(200)
    expect(access.body.claims).toMatchObject({ userId, email: 'member@example.invalid' })
    return access.body.claims
  }
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    holder.pool = new Pool({ connectionString: url.toString() })
    await initDb(holder.pool)
    holder.leaseClient = await holder.pool.connect()
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
    vi.restoreAllMocks()
    invitationFlow.registerAndSendInvitation.mockReset().mockResolvedValue(undefined)
    invitationFlow.validateInvitationFlowToken.mockReset()
    await holder.pool.query('DELETE FROM team_members')
    await holder.pool.query('DELETE FROM invitations')
    await holder.pool.query('DELETE FROM teams')
    await holder.pool.query('DELETE FROM users')
    await holder.pool.query('DELETE FROM rate_limit_buckets')
    if (await newStateExists()) {
      await holder.pool.query('UPDATE password_identifier_state SET retained_until_ms=0')
      await holder.pool.query('DELETE FROM password_identifier_state')
      await holder.pool.query('DELETE FROM password_verification_pace')
    }
    userId = (
      await holder.pool.query(
        "INSERT INTO users(email, password_hash) VALUES ('member@example.invalid', $1) RETURNING id",
        [realHash]
      )
    ).rows[0].id
    compare = vi.spyOn(bcrypt, 'compare')
  })
  afterAll(async () => {
    try {
      vi.restoreAllMocks()
      holder.leaseClient?.release()
      await endPoolAndWaitForClients(holder.pool)
      if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin?.end()
    }
  })

  it.each(['member@example.invalid', 'unknown@example.invalid', 'no-password@example.invalid'])(
    'returns the identical generic credential failure for %s',
    async email => {
      await holder.pool.query(
        "INSERT INTO users(email) VALUES ('no-password@example.invalid') ON CONFLICT DO NOTHING"
      )
      const response = await login(email)
      expect({ status: response.status, body: response.body }).toEqual({
        status: 401,
        body: { error: 'invalid_credentials' },
      })
    }
  )
  it.each(['unknown@example.invalid', 'no-password@example.invalid'])(
    'performs cost-12 dummy work for admitted %s',
    async email => {
      await holder.pool.query(
        "INSERT INTO users(email) VALUES ('no-password@example.invalid') ON CONFLICT DO NOTHING"
      )
      await login(email)
      expect(compare).toHaveBeenCalledTimes(1)
      expect(bcrypt.getRounds(compare.mock.calls[0][1] as string)).toBe(12)
    }
  )
  it.each([10, 11, 13, 14])('does not verify a stored cost-%i credential', async cost => {
    // Library producer emits the exact hash format, with real cost-12 work
    // avoided for deliberately unsupported synthetic costs during fixture setup.
    const hash = await bcrypt.hash(password, cost)
    await holder.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId])
    const response = await login('member@example.invalid', password)
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'invalid_credentials' })
    expect(compare).toHaveBeenCalledTimes(1)
    expect(compare.mock.calls[0][1]).not.toBe(hash)
    expect(bcrypt.getRounds(compare.mock.calls[0][1] as string)).toBe(12)
  })
  it('denies a sixth source attempt before bcrypt', async () => {
    // Keep all six source hits in one fixed minute even when five bcrypt
    // compares straddle a wall-clock boundary; otherwise global pace can
    // deny the sixth request before the source limiter is observed.
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    try {
      for (let i = 0; i < 5; i++) {
        await openPace()
        expect((await login(`source-${i}@example.invalid`)).status).toBe(401)
      }
      expect(compare).toHaveBeenCalledTimes(5)
      const sourceDenials = await denialCount('source_rate')
      const before = compare.mock.calls.length
      const response = await login('sixth@example.invalid')
      expect(response.status).toBe(429)
      expect(response.body.error).toBe('rate_limited')
      expect(compare.mock.calls.length).toBe(before)
      expect(await denialCount('source_rate')).toBe(sourceDenials + 1)
    } finally {
      wallClock.mockRestore()
    }
  })
  it('denies rotating sources and canonical identifier variants after five attempts', async () => {
    for (let i = 0; i < 5; i++) {
      await openPace()
      await login(
        i % 2 ? ' MEMBER@example.invalid ' : 'member@example.invalid',
        'wrong',
        `192.0.2.${i + 1}`
      )
    }
    const cooldownDenials = await denialCount('identifier_cooldown')
    const before = compare.mock.calls.length
    const response = await login('Member@Example.Invalid', 'wrong', '192.0.2.100')
    expect(response.status).toBe(429)
    expect(response.body.error).toBe('rate_limited')
    expect(compare.mock.calls.length).toBe(before)
    expect(await denialCount('identifier_cooldown')).toBe(cooldownDenials + 1)
  })
  it('applies the same pace to unknown and existing evaluations with burst one', async () => {
    expect((await login('unknown@example.invalid')).status).toBe(401)
    const globalPaceDenials = await denialCount('global_pace')
    const response = await login('member@example.invalid', 'wrong', '192.0.2.2')
    expect(response.status).toBe(429)
    expect(compare).toHaveBeenCalledTimes(1)
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(8)
    expect(await denialCount('global_pace')).toBe(globalPaceDenials + 1)
  })
  it('restores authenticated access after global pace exhaustion without refunding attempts', async () => {
    expect((await login('unknown@example.invalid', 'wrong', '192.0.2.31')).status).toBe(401)
    const denied = await login('member@example.invalid', password, '192.0.2.32')
    expect(denied.status).toBe(429)
    expect(compare).toHaveBeenCalledTimes(1)

    const attemptsBefore = (
      await holder.pool.query(
        'SELECT attempts FROM password_identifier_state WHERE identifier_key = $1',
        [passwordIdentifierKey('member@example.invalid')]
      )
    ).rows[0].attempts
    await recoverPassword('Synthetic-BUG192-recovered-under-global-saturation')
    const attemptsAfter = (
      await holder.pool.query(
        'SELECT attempts FROM password_identifier_state WHERE identifier_key = $1',
        [passwordIdentifierKey('member@example.invalid')]
      )
    ).rows[0].attempts
    expect(attemptsAfter).toEqual(attemptsBefore)
    expect(
      (
        await login(
          'member@example.invalid',
          'Synthetic-BUG192-recovered-under-global-saturation',
          '192.0.2.33'
        )
      ).status
    ).toBe(429)
  })
  it('restores authenticated access during identifier cooldown and preserves public attempts', async () => {
    for (let i = 0; i < 5; i++) {
      await openPace()
      await login('member@example.invalid', 'wrong', `192.0.2.${40 + i}`)
    }
    const before = compare.mock.calls.length
    await openPace()
    const denied = await login('member@example.invalid', password, '192.0.2.49')
    expect(denied.status).toBe(429)
    expect(compare.mock.calls.length).toBe(before)

    const stateBeforeRecovery = (
      await holder.pool.query(
        'SELECT attempts FROM password_identifier_state WHERE identifier_key = $1',
        [passwordIdentifierKey('member@example.invalid')]
      )
    ).rows[0].attempts
    expect(stateBeforeRecovery).toHaveLength(5)
    const teamId = (
      await holder.pool.query(
        "INSERT INTO teams(name) VALUES ('Synthetic recovery team') RETURNING id"
      )
    ).rows[0].id
    await holder.pool.query(
      "INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')",
      [teamId, userId]
    )
    const claims = await recoverPassword('Synthetic-BUG192-recovered-during-identifier-cooldown')
    expect(claims).toMatchObject({ teamId, role: 'admin' })
    const stateAfterRecovery = (
      await holder.pool.query(
        'SELECT attempts FROM password_identifier_state WHERE identifier_key = $1',
        [passwordIdentifierKey('member@example.invalid')]
      )
    ).rows[0].attempts
    expect(stateAfterRecovery).toEqual(stateBeforeRecovery)

    const attemptDenials = await denialCount('identifier_attempts')
    const comparisons = compare.mock.calls.length
    await openPace()
    const stillDenied = await login(
      'member@example.invalid',
      'Synthetic-BUG192-recovered-during-identifier-cooldown',
      '192.0.2.50'
    )
    expect(stillDenied.status).toBe(429)
    expect(compare.mock.calls.length).toBe(comparisons)
    expect(await denialCount('identifier_attempts')).toBe(attemptDenials + 1)
  })
  it('keeps the account attempt budget after correct-password successes', async () => {
    for (let i = 0; i < 5; i++) {
      await openPace()
      expect((await login('member@example.invalid', password, `192.0.2.${60 + i}`)).status).toBe(
        200
      )
    }
    const attemptDenials = await denialCount('identifier_attempts')
    await openPace()
    const denied = await login('member@example.invalid', password, '192.0.2.69')
    expect(denied.status).toBe(429)
    expect(await denialCount('identifier_attempts')).toBe(attemptDenials + 1)
  })
  it('records durable verification-owner contention without running bcrypt', async () => {
    const lease = await acquirePasswordWork()
    expect(lease).not.toBeNull()
    try {
      const busyDenials = await denialCount('verification_busy')
      const before = compare.mock.calls.length
      const response = await login('member@example.invalid', password)
      expect(response.status).toBe(429)
      expect(compare.mock.calls.length).toBe(before)
      expect(await denialCount('verification_busy')).toBe(busyDenials + 1)
    } finally {
      await lease?.release()
    }
  })
  it('returns acknowledged password recovery after a post-commit client cleanup failure', async () => {
    const invitation = await createInvitationForTeams({
      inviteeName: 'Synthetic member',
      email: 'member@example.invalid',
      purpose: 'password_reset',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    const sibling = await createInvitationForTeams({
      inviteeName: 'Synthetic member',
      email: 'member@example.invalid',
      purpose: 'password_reset',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    const connect = holder.pool.connect.bind(holder.pool)
    const connectSpy = vi.spyOn(holder.pool, 'connect')
    let recoveryUpdateCommitted = false
    let cleanupFailed = false
    connectSpy.mockImplementation((async () => {
      const client = await connect()
      const query = client.query.bind(client)
      const release = client.release.bind(client)
      let recoveryCredentialWritten = false
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return async (...args: unknown[]) => {
              const statement =
                typeof args[0] === 'string'
                  ? args[0]
                  : String((args[0] as { text?: string } | undefined)?.text || '')
              const result = await (query as (...queryArgs: unknown[]) => Promise<unknown>)(...args)
              if (/UPDATE users\s+SET password_hash/is.test(statement))
                recoveryCredentialWritten = true
              if (/^COMMIT\s*$/i.test(statement) && recoveryCredentialWritten)
                recoveryUpdateCommitted = true
              return result
            }
          }
          if (property === 'release') {
            return (error?: Error | boolean) => {
              if (recoveryUpdateCommitted && !cleanupFailed) {
                cleanupFailed = true
                release(new Error('synthetic post-commit cleanup failure'))
                throw new Error('synthetic post-commit cleanup failure')
              }
              return release(error)
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }) as typeof holder.pool.connect)

    let result: Awaited<ReturnType<typeof setInvitationPasswordForEmail>> | undefined
    try {
      result = await setInvitationPasswordForEmail(
        'member@example.invalid',
        invitation.id,
        'Synthetic-BUG192-recovered-after-commit'
      )
    } finally {
      connectSpy.mockRestore()
    }
    expect(cleanupFailed).toBe(true)
    expect(recoveryUpdateCommitted).toBe(true)
    expect(result).toBeDefined()
    expect(result).toMatchObject({
      data: { passwordUpdated: true, sessionContext: { userId } },
    })
    expect(
      (
        await holder.pool.query('SELECT id, status FROM invitations WHERE id = ANY($1::uuid[])', [
          [invitation.id, sibling.id],
        ])
      ).rows
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: invitation.id, status: 'accepted' }),
        expect.objectContaining({ id: sibling.id, status: 'revoked' }),
      ])
    )
    expect(
      (await holder.pool.query('SELECT count(*)::text AS count FROM password_verification_work'))
        .rows[0].count
    ).toBe('0')
    await openPace()
    const loginResponse = await login(
      'member@example.invalid',
      'Synthetic-BUG192-recovered-after-commit',
      '192.0.2.111'
    )
    expect(loginResponse.status).toBe(200)
  }, 30_000)
  it('keeps authenticated password change inside the single durable bcrypt owner', async () => {
    let releaseCompare!: () => void
    let compareStarted!: () => void
    const compareGate = new Promise<void>(resolve => {
      releaseCompare = resolve
    })
    const compareEntered = new Promise<void>(resolve => {
      compareStarted = resolve
    })
    let releaseHash!: () => void
    let hashStarted!: () => void
    const hashGate = new Promise<void>(resolve => {
      releaseHash = resolve
    })
    const hashEntered = new Promise<void>(resolve => {
      hashStarted = resolve
    })
    const realPasswordHash = bcrypt.hash.bind(bcrypt)
    let compareCalls = 0
    let hashCalls = 0
    compare.mockImplementation(async (submitted, stored) => {
      const matched = await realBcryptCompare(submitted, stored)
      if (compareCalls++ === 0) {
        compareStarted()
        await compareGate
      }
      return matched
    })
    const hash = vi.spyOn(bcrypt, 'hash').mockImplementation(async (submitted, rounds) => {
      const value = await realPasswordHash(submitted, rounds)
      if (hashCalls++ === 0) {
        hashStarted()
        await hashGate
      }
      return value
    })

    const update = updateUserPassword(
      userId,
      'member@example.invalid',
      password,
      'Synthetic-BUG192-password-changed'
    )
    let comparePhaseLoginStatus = 0
    let hashPhaseLoginStatus = 0
    try {
      await compareEntered
      await openPace()
      comparePhaseLoginStatus = (await login('member@example.invalid', password, '192.0.2.112'))
        .status
      releaseCompare()
      await hashEntered
      await openPace()
      hashPhaseLoginStatus = (await login('member@example.invalid', password, '192.0.2.113')).status
    } finally {
      releaseCompare()
      releaseHash()
    }

    expect(await update).toEqual({ updated: true })
    expect(comparePhaseLoginStatus).toBe(429)
    expect(hashPhaseLoginStatus).toBe(429)
    expect(compare).toHaveBeenCalledTimes(1)
    expect(hash).toHaveBeenCalledTimes(1)
    await openPace()
    expect(
      (await login('member@example.invalid', 'Synthetic-BUG192-password-changed', '192.0.2.114'))
        .status
    ).toBe(200)
  }, 30_000)
  it('keeps real and shadow cooldown status/body/retry metadata identical', async () => {
    // Backdate admitted attempts and completed failures using the DB clock,
    // then retain the real admission producer for the fifth transition.
    for (const email of ['member@example.invalid', 'unknown@example.invalid']) {
      for (let i = 0; i < 5; i++) {
        await openPace()
        await login(email, 'wrong', `192.0.2.${i + 1}`)
        await holder.pool.query('DELETE FROM rate_limit_buckets')
      }
    }
    const known = await login('member@example.invalid', 'wrong', '192.0.2.80')
    const shadow = await login('unknown@example.invalid', 'wrong', '192.0.2.81')
    expect(known.status).toBe(429)
    expect(shadow.status).toBe(429)
    // Align histories by producer-derived state; no hand-authored HTTP fixture.
    if (await newStateExists())
      await holder.pool.query(
        'UPDATE password_identifier_state SET attempts = (SELECT attempts FROM password_identifier_state WHERE user_id = $1), failures = (SELECT failures FROM password_identifier_state WHERE user_id = $1), locked_until_ms = (SELECT locked_until_ms FROM password_identifier_state WHERE user_id = $1)',
        [userId]
      )
    const a = await login('member@example.invalid', 'wrong', '192.0.2.82')
    const b = await login('unknown@example.invalid', 'wrong', '192.0.2.83')
    expect(a.body).toEqual(b.body)
    for (const name of [
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ])
      expect(a.headers[name]).toEqual(b.headers[name])
  })
  it('does not extend an identifier denial on repeated denied requests', async () => {
    for (let i = 0; i < 5; i++) {
      await openPace()
      await login('member@example.invalid', 'wrong', `192.0.2.${i + 1}`)
    }
    const before = await login('member@example.invalid', 'wrong', '192.0.2.90')
    const later = await login('member@example.invalid', 'wrong', '192.0.2.91')
    expect(before.status).toBe(429)
    expect(later.status).toBe(429)
    expect(Number(later.headers['retry-after'])).toBeLessThanOrEqual(
      Number(before.headers['retry-after'])
    )
    if (await newStateExists()) {
      const row = (
        await holder.pool.query(
          'SELECT attempts, failures, locked_until_ms FROM password_identifier_state'
        )
      ).rows[0]
      expect(row.attempts).toHaveLength(5)
      expect(row.failures).toHaveLength(5)
    }
  })
  it('shares public failure cooldown with authenticated reverification', async () => {
    for (let i = 0; i < 5; i++) {
      await openPace()
      await verifyUserPassword({ userId, email: 'member@example.invalid', password: 'wrong' })
    }
    const before = compare.mock.calls.length
    const response = await login('member@example.invalid', 'wrong')
    expect(response.status).toBe(429)
    expect(compare.mock.calls.length).toBe(before)
  })
  it('gates a correct canonical password behind the same aggregate authority', async () => {
    await login('unknown@example.invalid')
    const response = await login('member@example.invalid', password, '192.0.2.2')
    expect(response.status).toBe(429)
    await openPace()
    const success = await login('member@example.invalid', password, '192.0.2.3')
    expect(success.status).toBe(200)
    expect(verifyExternalSessionToken(success.body.token)).toMatchObject({
      userId,
      email: 'member@example.invalid',
      authGeneration: 1,
    })
    expect(success.body.me).toMatchObject({ id: userId, role: 'member', teamId: null })
  })
  it('fails closed before bcrypt when credential persistence is unavailable', async () => {
    // Real database producer: temporarily revoke table access by making its
    // relation unavailable, then restore it even when the assertion fails.
    const exists = await newStateExists()
    const authorityFailures = await denialCount('authority_failure')
    if (exists)
      await holder.pool.query(
        'ALTER TABLE password_identifier_state RENAME TO password_identifier_state_unavailable'
      )
    try {
      const a = await login('member@example.invalid')
      const b = await login('unknown@example.invalid', 'wrong', '192.0.2.2')
      expect(a.status).toBe(503)
      expect(b.status).toBe(503)
      expect(a.body).toEqual(b.body)
      expect(compare).not.toHaveBeenCalled()
      expect(await denialCount('authority_failure')).toBe(authorityFailures + 2)
    } finally {
      if (exists)
        await holder.pool.query(
          'ALTER TABLE password_identifier_state_unavailable RENAME TO password_identifier_state'
        )
    }
  })
  // Preservation coverage relocated from the old mocked bcrypt orchestration
  // suite. These cases are not BUG regression/T3 claims.
  it('preserves an existing membership without healing unrelated accepted invitations', async () => {
    const team = (
      await holder.pool.query("INSERT INTO teams(name) VALUES ('Existing') RETURNING id")
    ).rows[0]
    const other = (
      await holder.pool.query("INSERT INTO teams(name) VALUES ('Unrelated') RETURNING id")
    ).rows[0]
    await holder.pool.query(
      "INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'member','active')",
      [team.id, userId]
    )
    await holder.pool.query(
      "INSERT INTO invitations(team_id,email,role,status,accepted_user_id,accepted_at) VALUES ($1,'member@example.invalid','admin','accepted',$2,NOW())",
      [other.id, userId]
    )
    const response = await login('member@example.invalid', password)
    expect(response.status).toBe(200)
    expect(response.body.me.teamId).toBe(team.id)
    expect(
      (
        await holder.pool.query('SELECT team_id FROM team_members WHERE user_id=$1', [userId])
      ).rows.map(row => row.team_id)
    ).toEqual([team.id])
  })
  it('preserves accepted-invitation membership healing for an authenticated teamless member', async () => {
    const team = (
      await holder.pool.query("INSERT INTO teams(name) VALUES ('Accepted') RETURNING id")
    ).rows[0]
    await holder.pool.query(
      "INSERT INTO invitations(team_id,email,role,status,accepted_at) VALUES ($1,'member@example.invalid','member','accepted',NOW())",
      [team.id]
    )
    const response = await login('member@example.invalid', password)
    expect(response.status).toBe(200)
    expect(response.body.me.teamId).toBe(team.id)
    expect(
      (await holder.pool.query('SELECT user_id FROM team_members WHERE team_id=$1', [team.id]))
        .rows[0].user_id
    ).toBe(userId)
  })
  it('preserves the complete public error and trusted-source contract through both real services', async () => {
    process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY = createPublicKey(
      process.env.CONTROL_API_SESSION_JWT_PRIVATE_KEY!
    )
      .export({ type: 'spki', format: 'pem' })
      .toString()
    const { createAuthRouter } = await import('../../external-rest-api/src/routes/auth.js')
    const { config: externalConfig } = await import('../../external-rest-api/src/config.js')
    const { withExternalRequestContext } =
      await import('../../external-rest-api/src/requestContext.js')
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address() as { port: number }
    const previous = externalConfig.controlApiBaseUrl
    externalConfig.controlApiBaseUrl = `http://127.0.0.1:${address.port}`
    const edge = express()
    edge.set('trust proxy', 1)
    edge.use(express.json())
    edge.use(withExternalRequestContext)
    edge.use('/api/v1', createAuthRouter())
    try {
      await holder.pool.query("INSERT INTO users(email) VALUES ('no-password@example.invalid')")
      for (const email of [
        'member@example.invalid',
        'unknown@example.invalid',
        'no-password@example.invalid',
      ]) {
        await openPace()
        const response = await request(edge)
          .post('/api/v1/auth/password-login')
          .set('X-Forwarded-For', '192.0.2.123')
          .send({ email, password: 'wrong' })
        expect({ status: response.status, body: response.body }).toEqual({
          status: 401,
          body: { error: 'invalid_credentials' },
        })
      }
      const limited = await request(edge)
        .post('/api/v1/auth/password-login')
        .set('X-Forwarded-For', '192.0.2.124')
        .send({ email: 'another@example.invalid', password: 'wrong' })
      expect(limited.status).toBe(429)
      expect(limited.body.error).toBe('rate_limited')
      expect(limited.body.retryAfterSeconds).toBe(Number(limited.headers['retry-after']))
      expect(limited.headers['x-ratelimit-reset']).toBeUndefined()
      const keys = (await holder.pool.query('SELECT bucket_key FROM rate_limit_buckets')).rows.map(
        row => row.bucket_key
      )
      expect(keys).toContain('external_authentication_attempt:ip:192.0.2.123')
    } finally {
      externalConfig.controlApiBaseUrl = previous
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    }
  })
})
