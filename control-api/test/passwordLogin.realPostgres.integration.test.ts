import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { passwordAdmissionDenialsTotal } from '../src/observability/metrics.js'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import { passwordIdentifierKey } from '../src/services/auth/passwordAdmissionState.js'
import { PASSWORD_DUMMY_HASH } from '../src/services/auth/passwordCredentialVerification.js'
import { acquirePasswordWork } from '../src/services/auth/passwordWorkOwnership.js'
import { verifyUserPassword } from '../src/services/directory/login.js'
import {
  deleteManagedUserForUser,
  setInvitationPasswordForEmail,
  updateUserPassword,
} from '../src/services/directory/membership.js'
import { createPasswordResetInvitation } from '../src/services/directory/passwordResetInvitations.js'
import { adminDeleteUser, retireDesktopUser } from '../src/services/directory/users.js'
import { verifyExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import {
  type ExternalRestHttpProcess,
  boundedRequest as request,
  startExternalRestHttpProcess,
} from './helpers/externalRestHttpProcess.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({
  pool: null as unknown as Pool,
  leaseClient: null as unknown as import('pg').PoolClient,
  queryObserver: null as ((sql: string, values?: unknown[]) => void) | null,
}))
const invitationFlow = vi.hoisted(() => ({
  registerAndSendInvitation: vi.fn().mockResolvedValue(undefined),
  validateInvitationFlowToken: vi.fn(),
}))
const passwordAdmissionLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}))
vi.mock('../src/observability/logger.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/observability/logger.js')>()
  const rootLogger = new Proxy(real.rootLogger, {
    get(target, property) {
      if (property === 'child') {
        return (bindings: Record<string, unknown>) => {
          if (bindings.module === 'password-admission') return passwordAdmissionLogger
          return Reflect.apply(
            Reflect.get(target, property, target) as (...args: unknown[]) => unknown,
            target,
            [bindings]
          )
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ...real, rootLogger }
})
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
    query: (...args: unknown[]) => {
      const text =
        typeof args[0] === 'string'
          ? args[0]
          : ((args[0] as { text?: string } | undefined)?.text ?? '')
      holder.queryObserver?.(text, Array.isArray(args[1]) ? args[1] : undefined)
      return (holder.pool.query as Function)(...args)
    },
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
    ) =>
      real.acquireRateLimitConcurrencyLease(requirements, {
        client: holder.leaseClient,
      }),
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
  let runtimePool: Pool
  let runtimeLeaseClient: import('pg').PoolClient
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
  async function withRuntime<T>(work: () => Promise<T>): Promise<T> {
    const previousPool = holder.pool
    const previousLeaseClient = holder.leaseClient
    holder.pool = runtimePool
    holder.leaseClient = runtimeLeaseClient
    try {
      return await work()
    } finally {
      holder.pool = previousPool
      holder.leaseClient = previousLeaseClient
    }
  }
  async function stateFor(email: string) {
    const key = passwordIdentifierKey(email)
    return (
      await holder.pool.query(
        `SELECT user_id::text, to_jsonb(state) - 'user_id' AS retained
           FROM password_identifier_state AS state
          WHERE identifier_key = $1`,
        [key]
      )
    ).rows[0]
  }
  async function denialCount(reason: string) {
    const metric = await passwordAdmissionDenialsTotal.get()
    return metric.values.find(value => value.labels.reason === reason)?.value ?? 0
  }
  async function recoverPassword(nextPassword: string) {
    const invitation = await createPasswordResetInvitation({
      inviteeName: 'Synthetic member',
      email: 'member@example.invalid',
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
    expect(reset.body.reauthenticationRequired).toBe(true)
    expect(reset.body).not.toHaveProperty('token')

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
  }
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    holder.pool = new Pool({ connectionString: url.toString() })
    await initDb(holder.pool)
    holder.leaseClient = await holder.pool.connect()
    runtimePool = new Pool({
      connectionString: url.toString(),
      options: '-c role=control_api_runtime',
    })
    const runtimeIdentity = await runtimePool.query('SELECT current_user')
    expect(runtimeIdentity.rows[0].current_user).toBe('control_api_runtime')
    runtimeLeaseClient = await runtimePool.connect()
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
      await holder.pool.query('TRUNCATE password_identifier_state, password_verification_pace')
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
      runtimeLeaseClient?.release()
      holder.leaseClient?.release()
      await endPoolAndWaitForClients(runtimePool)
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
  it('trusted password recovery clears failure cooldown while preserving success history', async () => {
    const successfulResponses: Array<{ status: number }> = []
    for (let i = 0; i < 2; i++) {
      await openPace()
      successfulResponses.push(await login('member@example.invalid', password, `192.0.2.${35 + i}`))
    }
    expect(successfulResponses.map(response => response.status)).toEqual([200, 200])

    for (let i = 0; i < 5; i++) {
      await openPace()
      expect((await login('member@example.invalid', 'wrong', `192.0.2.${40 + i}`)).status).toBe(401)
    }
    const before = compare.mock.calls.length
    await openPace()
    const denied = await login('member@example.invalid', password, '192.0.2.49')
    expect(denied.status).toBe(429)
    expect(compare.mock.calls.length).toBe(before)

    const stateBeforeRecovery = (
      await holder.pool.query(
        'SELECT attempts,successes FROM password_identifier_state WHERE identifier_key = $1',
        [passwordIdentifierKey('member@example.invalid')]
      )
    ).rows[0]
    expect(stateBeforeRecovery.attempts).toEqual([])
    expect(stateBeforeRecovery.successes).toHaveLength(2)
    const now = Date.now()
    expect(
      stateBeforeRecovery.successes.every(
        (timestamp: string) => now - Number(timestamp) < 15 * 60 * 1_000
      )
    ).toBe(true)
    const teamId = (
      await holder.pool.query(
        "INSERT INTO teams(name) VALUES ('Synthetic recovery team') RETURNING id"
      )
    ).rows[0].id
    await holder.pool.query(
      "INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')",
      [teamId, userId]
    )
    await recoverPassword('Synthetic-BUG192-recovered-during-identifier-cooldown')
    const stateAfterRecovery = (
      await holder.pool.query(
        'SELECT attempts,successes,failures,locked_until_ms FROM password_identifier_state WHERE identifier_key = $1',
        [passwordIdentifierKey('member@example.invalid')]
      )
    ).rows[0]
    expect(stateAfterRecovery.attempts).toEqual(stateBeforeRecovery.attempts)
    expect(stateAfterRecovery).toMatchObject({
      failures: [],
      locked_until_ms: '0',
    })
    expect(stateAfterRecovery.successes).toEqual(stateBeforeRecovery.successes)
    const comparisons = compare.mock.calls.length
    await openPace()
    const admitted = await login(
      'member@example.invalid',
      'Synthetic-BUG192-recovered-during-identifier-cooldown',
      '192.0.2.50'
    )
    expect(admitted.status).toBe(200)
    expect(compare.mock.calls.length).toBe(comparisons + 1)
    const successesAfterNewCredential = (
      await holder.pool.query(
        'SELECT successes FROM password_identifier_state WHERE identifier_key=$1',
        [passwordIdentifierKey('member@example.invalid')]
      )
    ).rows[0].successes
    expect(successesAfterNewCredential).toHaveLength(3)
    expect(successesAfterNewCredential.slice(0, 2)).toEqual(stateBeforeRecovery.successes)
  })
  it('admits forty successes and quota-masks the next login through dummy verification', async () => {
    for (let i = 0; i < 40; i++) {
      await openPace()
      const ip = `192.0.2.${100 + Math.floor(i / 5)}`
      const response = await login('member@example.invalid', password, ip)
      expect(response.status).toBe(200)
      if ([5, 19, 39].includes(i)) {
        const state = (
          await holder.pool.query(
            'SELECT successes FROM password_identifier_state WHERE identifier_key = $1',
            [passwordIdentifierKey('member@example.invalid')]
          )
        ).rows[0]
        expect(state.successes).toHaveLength(i + 1)
      }
      expect(verifyExternalSessionToken(response.body.token)).toMatchObject({
        userId,
        email: 'member@example.invalid',
      })
    }
    expect(compare).toHaveBeenCalledTimes(40)
    await openPace()
    const quotaMasked = await login('member@example.invalid', password, '192.0.2.250')
    expect(quotaMasked.status).toBe(401)
    expect(quotaMasked.body).toEqual({ error: 'invalid_credentials' })
    expect(compare).toHaveBeenCalledTimes(41)
    expect(compare.mock.calls[40][1]).toBe(PASSWORD_DUMMY_HASH)
    const state = (
      await holder.pool.query(
        `SELECT successes, failures, locked_until_ms
         FROM password_identifier_state WHERE identifier_key = $1`,
        [passwordIdentifierKey('member@example.invalid')]
      )
    ).rows[0]
    expect(state.successes).toHaveLength(40)
    expect(state.failures).toHaveLength(1)
    expect(state.locked_until_ms).toBe('0')
  }, 120_000)
  it('keeps a quota-masked known identity indistinguishable from an unknown identity', async () => {
    const identities = ['member@example.invalid', 'quota-shadow@example.invalid']
    const columns = await holder.pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='password_identifier_state'`
    )
    const hasSuccessAccounting = columns.rows.some(
      row => (row as { column_name: string }).column_name === 'successes'
    )
    const now = Number(
      (
        await holder.pool.query(
          'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS ms'
        )
      ).rows[0].ms
    )
    for (const identity of identities) {
      const key = passwordIdentifierKey(identity)
      await holder.pool.query(
        'INSERT INTO password_identifier_state(identifier_key) VALUES ($1) ON CONFLICT DO NOTHING',
        [key]
      )
      if (hasSuccessAccounting) {
        await holder.pool.query(
          'UPDATE password_identifier_state SET successes=$2 WHERE identifier_key=$1',
          [key, Array.from({ length: 40 }, (_, index) => now - 100 - index)]
        )
      } else {
        // At the genuine pre-amendment head this exercises the observable old gate: both
        // histories are exhausted and must not become valid T3 evidence via missing schema.
        await holder.pool.query(
          'UPDATE password_identifier_state SET attempts=$2 WHERE identifier_key=$1',
          [key, Array.from({ length: 5 }, (_, index) => now - 100 - index)]
        )
      }
    }

    const publicIdentityLookups: string[] = []
    holder.queryObserver = (sql, values) => {
      if (/FROM users WHERE email = \$1 LIMIT 1/i.test(sql))
        publicIdentityLookups.push(String(values?.[0]))
    }
    let known: Awaited<ReturnType<typeof login>>
    let unknown: Awaited<ReturnType<typeof login>>
    try {
      await openPace()
      known = await login('member@example.invalid', password, '192.0.2.241')
      await openPace()
      unknown = await login('quota-shadow@example.invalid', password, '192.0.2.242')
    } finally {
      holder.queryObserver = null
    }
    expect(known!.status).toBe(401)
    expect(unknown!.status).toBe(401)
    expect(publicIdentityLookups).toEqual(identities)
    expect({ status: known.status, body: known.body }).toEqual({
      status: unknown.status,
      body: unknown.body,
    })
    expect(known.body).toEqual({ error: 'invalid_credentials' })
    expect(known.headers['retry-after']).toBeUndefined()
    expect(compare.mock.calls.slice(-2).map(([, hash]) => hash)).toEqual([
      PASSWORD_DUMMY_HASH,
      PASSWORD_DUMMY_HASH,
    ])
    if (hasSuccessAccounting) {
      for (const identity of identities) {
        const state = (
          await holder.pool.query(
            'SELECT successes,failures FROM password_identifier_state WHERE identifier_key=$1',
            [passwordIdentifierKey(identity)]
          )
        ).rows[0]
        expect(state.successes).toHaveLength(40)
        expect(state.failures).toHaveLength(1)
      }
    }

    for (const identity of identities) {
      const octet = identity === identities[0] ? 243 : 244
      for (let failure = 2; failure <= 5; failure++) {
        await openPace()
        const response = await login(identity, password, `192.0.2.${octet + failure}`)
        expect(response.status).toBe(401)
        expect(response.body).toEqual({ error: 'invalid_credentials' })
      }
      const state = (
        await holder.pool.query(
          'SELECT successes,failures,locked_until_ms FROM password_identifier_state WHERE identifier_key=$1',
          [passwordIdentifierKey(identity)]
        )
      ).rows[0]
      if (hasSuccessAccounting) {
        expect(state.successes).toHaveLength(40)
        expect(state.failures).toHaveLength(5)
        expect(Number(state.locked_until_ms)).toBeGreaterThan(0)
      }
    }
    const comparisonsAtCooldown = compare.mock.calls.length
    await openPace()
    const knownCooldown = await login('member@example.invalid', password, '192.0.2.251')
    await openPace()
    const unknownCooldown = await login('quota-shadow@example.invalid', password, '192.0.2.252')
    expect(knownCooldown.status).toBe(429)
    expect(unknownCooldown.status).toBe(429)
    expect(knownCooldown.body.error).toBe(unknownCooldown.body.error)
    expect(Number(knownCooldown.body.retryAfterSeconds)).toBeGreaterThanOrEqual(899)
    expect(Number(unknownCooldown.body.retryAfterSeconds)).toBeGreaterThanOrEqual(899)
    expect(
      Math.abs(
        Number(knownCooldown.body.retryAfterSeconds) -
          Number(unknownCooldown.body.retryAfterSeconds)
      )
    ).toBeLessThanOrEqual(1)
    expect(compare.mock.calls).toHaveLength(comparisonsAtCooldown)
  })
  it('preserves an earlier failure across a later successful public login', async () => {
    await openPace()
    expect((await login('member@example.invalid', 'wrong', '192.0.2.30')).status).toBe(401)
    const before = (
      await holder.pool.query(
        'SELECT failures FROM password_identifier_state WHERE identifier_key = $1',
        [passwordIdentifierKey('member@example.invalid')]
      )
    ).rows[0].failures
    expect(before).toHaveLength(1)

    await openPace()
    const success = await login('member@example.invalid', password, '192.0.2.31')
    expect(success.status).toBe(200)
    const after = (
      await holder.pool.query(
        'SELECT failures FROM password_identifier_state WHERE identifier_key = $1',
        [passwordIdentifierKey('member@example.invalid')]
      )
    ).rows[0].failures
    expect(after).toEqual(before)
  })
  it('keeps the fifth completed failure boundary after an ordinary successful login', async () => {
    await openPace()
    expect((await login('member@example.invalid', 'wrong-1', '192.0.2.61')).status).toBe(401)
    await openPace()
    expect((await login('member@example.invalid', password, '192.0.2.62')).status).toBe(200)

    for (let failure = 2; failure <= 5; failure++) {
      await openPace()
      const response = await login(
        'member@example.invalid',
        `wrong-${failure}`,
        `192.0.2.${60 + failure}`
      )
      expect(response.status).toBe(401)
    }

    await openPace()
    const sixthFailure = await login('member@example.invalid', 'wrong-6', '192.0.2.70')
    expect(sixthFailure.status).toBe(429)
    expect(Number(sixthFailure.headers['retry-after'])).toBeGreaterThanOrEqual(899)
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
    const invitation = await createPasswordResetInvitation({
      inviteeName: 'Synthetic member',
      email: 'member@example.invalid',
    })
    const sibling = await createPasswordResetInvitation({
      inviteeName: 'Synthetic member',
      email: 'member@example.invalid',
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
      data: { passwordUpdated: true },
    })
    const resultData = (result as { data: Record<string, unknown> }).data
    expect(resultData).not.toHaveProperty('sessionContext')
    expect(resultData).not.toHaveProperty('token')
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
          'SELECT attempts, failures, successes, locked_until_ms FROM password_identifier_state'
        )
      ).rows[0]
      expect(row.attempts).toHaveLength(0)
      expect(row.failures).toHaveLength(5)
    }
  })
  it('shares public failure cooldown with authenticated reverification', async () => {
    for (let i = 0; i < 5; i++) {
      await openPace()
      const comparisonsBefore = compare.mock.calls.length
      expect(
        await verifyUserPassword({
          userId,
          email: 'member@example.invalid',
          password: 'wrong',
        })
      ).toBe(false)
      expect(compare.mock.calls).toHaveLength(comparisonsBefore + 1)
      expect(compare.mock.calls[comparisonsBefore]).toEqual(['wrong', realHash])
    }

    const identifier = passwordIdentifierKey('member@example.invalid')
    expect(passwordIdentifierKey(' MEMBER@example.invalid ')).toBe(identifier)
    const state = await stateFor(' MEMBER@example.invalid ')
    expect(state.user_id).toBe(userId)
    expect(state.retained.failures).toHaveLength(5)
    const cooldown = await holder.pool.query(
      `SELECT $1::bigint > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS active`,
      [state.retained.locked_until_ms]
    )
    expect(cooldown.rows[0].active).toBe(true)

    await openPace()
    const cooldownDenials = await denialCount('identifier_cooldown')
    const globalPaceDenials = await denialCount('global_pace')
    const sourceRateDenials = await denialCount('source_rate')
    const before = compare.mock.calls.length
    const response = await login('member@example.invalid', 'wrong', '203.0.113.239')
    expect(response.status).toBe(429)
    expect(response.body.error).toBe('rate_limited')
    expect(response.body).not.toHaveProperty('reason')
    expect(response.body).not.toHaveProperty('email')
    expect(compare.mock.calls.length).toBe(before)
    expect(await denialCount('identifier_cooldown')).toBe(cooldownDenials + 1)
    expect(await denialCount('global_pace')).toBe(globalPaceDenials)
    expect(await denialCount('source_rate')).toBe(sourceRateDenials)
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
    expect(success.body.me).toMatchObject({
      id: userId,
      role: 'member',
      teamId: null,
    })
  })
  it.each(['admin', 'managed-user'] as const)(
    'preserves password admission history when %s retirement deletes the bound user',
    async producer => {
      const email = `${producer}-${randomBytes(6).toString('hex')}@example.invalid`
      const targetId = (
        await holder.pool.query(
          'INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id::text AS id',
          [email, realHash]
        )
      ).rows[0].id as string
      let managerId: string | undefined
      let teamId: string | undefined
      if (producer === 'managed-user') {
        managerId = (
          await holder.pool.query(
            'INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id::text AS id',
            [`manager-${randomBytes(6).toString('hex')}@example.invalid`, realHash]
          )
        ).rows[0].id as string
        teamId = (
          await holder.pool.query(
            "INSERT INTO teams(name) VALUES ('Retirement fixture') RETURNING id"
          )
        ).rows[0].id as string
        await holder.pool.query(
          `INSERT INTO team_members(team_id, user_id, role, status)
           VALUES ($1, $2, 'admin', 'active'), ($1, $3, 'member', 'active')`,
          [teamId, managerId, targetId]
        )
      }

      await openPace()
      const authenticated = await withRuntime(() => login(email, password, '192.0.2.4'))
      expect(authenticated.status).toBe(200)
      expect(authenticated.body).toMatchObject({ me: { id: targetId } })
      for (let attempt = 0; attempt < 5; attempt++) {
        await openPace()
        const failed = await withRuntime(() =>
          login(
            ' ' + email.toUpperCase() + ' ',
            'Synthetic-wrong-password',
            `192.0.2.${50 + attempt}`
          )
        )
        expect(failed.status).toBe(401)
      }
      const before = await stateFor(email)
      expect(before.user_id).toBe(targetId)
      expect(before.retained.failures).toHaveLength(5)
      expect(before.retained.successes).toHaveLength(1)
      expect(Number(before.retained.locked_until_ms)).toBeGreaterThan(Date.now())

      const legacyDelete = await withRuntime(async () => {
        try {
          return await adminDeleteUser(targetId)
        } catch (error) {
          return { errorCode: String((error as { code?: unknown }).code ?? 'unknown') }
        }
      })
      expect(legacyDelete).toEqual({ errorCode: '55000' })
      expect(
        (await holder.pool.query('SELECT id FROM users WHERE id = $1', [targetId])).rowCount
      ).toBe(1)
      expect(await stateFor(email)).toEqual(before)

      await withRuntime(() =>
        holder.pool.query(
          `INSERT INTO desktop_user_retirement_operations(
             operation, actor_type, actor_control_admin_id, actor_desktop_user_id,
             target_user_id, idempotency_key_hash, request_fingerprint, reason
           ) VALUES (
             'retire_desktop_user', 'control_admin', $1::uuid, NULL, $2::uuid,
             repeat('a', 64), repeat('b', 64), 'stale ungoverned retirement'
           )`,
          [randomUUID(), targetId]
        )
      )
      const staleOperationDelete = await withRuntime(async () => {
        try {
          await adminDeleteUser(targetId)
          return { outcome: 'deleted' }
        } catch (error) {
          return { errorCode: String((error as { code?: unknown }).code ?? 'unknown') }
        }
      })
      expect(staleOperationDelete).toEqual({ errorCode: '55000' })
      expect(
        (await holder.pool.query('SELECT id FROM users WHERE id = $1', [targetId])).rowCount
      ).toBe(1)
      expect(await stateFor(email)).toEqual(before)

      let retirementResult: { outcome: string } | { errorCode: string }
      if (producer === 'admin') {
        retirementResult = await withRuntime(async () => {
          try {
            const retired = await retireDesktopUser(
              { kind: 'control_admin', controlAdminId: randomUUID() },
              targetId,
              'Synthetic admission-state retirement',
              `retirement-${randomBytes(12).toString('hex')}`,
              null
            )
            return { outcome: retired.outcome }
          } catch (error) {
            return { errorCode: String((error as { code?: unknown }).code ?? 'unknown') }
          }
        })
      } else {
        retirementResult = await withRuntime(async () => {
          try {
            const retired = await deleteManagedUserForUser(managerId!, targetId, {
              reason: 'Synthetic admission-state retirement',
              idempotencyKey: `retirement-${randomBytes(12).toString('hex')}`,
              requestId: null,
            })
            if ('error' in retired) return { errorCode: retired.error }
            return { outcome: retired.outcome.outcome }
          } catch (error) {
            return { errorCode: String((error as { code?: unknown }).code ?? 'unknown') }
          }
        })
      }
      expect(retirementResult).toEqual({ outcome: 'deleted' })

      expect(
        (await holder.pool.query('SELECT id FROM users WHERE id = $1', [targetId])).rowCount
      ).toBe(0)
      const after = await stateFor(email)
      expect(after.user_id).toBeNull()
      expect(after.retained).toEqual(before.retained)

      const survivingUser = (
        await holder.pool.query(
          'INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id::text AS id',
          [`survivor-${randomBytes(6).toString('hex')}@example.invalid`, realHash]
        )
      ).rows[0].id as string
      await expect(
        withRuntime(() =>
          holder.pool.query(
            `UPDATE password_identifier_state SET user_id = $2::uuid
              WHERE identifier_key = $1`,
            [passwordIdentifierKey(email), survivingUser]
          )
        )
      ).rejects.toMatchObject({ code: '55000' })
      const stillProtected = await stateFor(email)
      expect(stillProtected.user_id).toBeNull()
      expect(stillProtected.retained).toEqual(before.retained)
    }
  )
  it('preserves running admission state while an authenticated verification is retired', async () => {
    const email = 'member@example.invalid'
    let markEntered!: () => void
    let releaseComparison!: () => void
    const entered = new Promise<void>(resolve => {
      markEntered = resolve
    })
    const comparisonMayFinish = new Promise<void>(resolve => {
      releaseComparison = resolve
    })
    await openPace()
    expect((await withRuntime(() => login(email, password, '192.0.2.200'))).status).toBe(200)
    await openPace()
    compare.mockImplementationOnce(async (submitted, storedHash) => {
      markEntered()
      await comparisonMayFinish
      return realBcryptCompare(submitted, storedHash)
    })
    const verification = withRuntime(() => login(email, password, '192.0.2.201'))
    try {
      await entered
      const before = await stateFor(email)
      expect(before.user_id).toBe(userId)
      expect(before.retained.provisional_phase).toBe('running')
      expect(before.retained.provisional_operation).toEqual(expect.any(String))
      const ownerBefore = (
        await holder.pool.query(
          'SELECT to_jsonb(owner) AS owner FROM password_verification_work AS owner'
        )
      ).rows[0]?.owner
      expect(ownerBefore).toEqual(expect.any(Object))

      const retirementResult = await withRuntime(async () => {
        try {
          const retired = await retireDesktopUser(
            { kind: 'control_admin', controlAdminId: randomUUID() },
            userId,
            'Synthetic in-flight admission retirement',
            `retirement-${randomBytes(12).toString('hex')}`,
            null
          )
          return { outcome: retired.outcome }
        } catch (error) {
          return { errorCode: String((error as { code?: unknown }).code ?? 'unknown') }
        }
      })
      expect(retirementResult).toEqual({ outcome: 'deleted' })
      const detached = await stateFor(email)
      expect(detached.user_id).toBeNull()
      expect(detached.retained).toEqual(before.retained)
      const ownerDuring = (
        await holder.pool.query(
          'SELECT to_jsonb(owner) AS owner FROM password_verification_work AS owner'
        )
      ).rows[0]?.owner
      expect(ownerDuring).toEqual(ownerBefore)

      releaseComparison()
      const response = await verification
      expect(response.status).toBe(401)
      expect(compare).toHaveBeenCalledTimes(2)
      const terminal = await stateFor(email)
      expect(terminal.user_id).toBeNull()
      expect(terminal.retained.provisional_phase).toBeNull()
      expect(
        (await holder.pool.query('SELECT count(*)::int AS count FROM password_verification_work'))
          .rows[0].count
      ).toBe(0)
    } finally {
      releaseComparison()
      await verification.catch(() => undefined)
    }
  })
  it('keeps the supported credential diagnostic quiet for a quota-masked login', async () => {
    passwordAdmissionLogger.info.mockClear()
    for (let success = 0; success < 40; success++) {
      await openPace()
      const response = await withRuntime(() =>
        login(' MEMBER@example.invalid ', password, `192.0.2.${success + 1}`)
      )
      expect(response.status).toBe(200)
    }
    const beforeMaskedRequest = (
      await holder.pool.query(
        'SELECT successes, failures FROM password_identifier_state WHERE identifier_key = $1',
        [passwordIdentifierKey('member@example.invalid')]
      )
    ).rows[0]
    expect(beforeMaskedRequest.successes).toHaveLength(40)
    expect(beforeMaskedRequest.failures).toHaveLength(0)

    await openPace()
    const masked = await withRuntime(() => login('member@example.invalid', password, '192.0.3.41'))
    expect({ status: masked.status, body: masked.body }).toEqual({
      status: 401,
      body: { error: 'invalid_credentials' },
    })
    expect(compare).toHaveBeenCalledTimes(41)
    expect(compare.mock.calls[40][1]).toBe(PASSWORD_DUMMY_HASH)
    const resetRequiredEvents = passwordAdmissionLogger.info.mock.calls.filter(
      ([fields]) =>
        (fields as { event?: unknown } | undefined)?.event === 'password_credential_reset_required'
    )
    expect(resetRequiredEvents).toHaveLength(0)

    const unsupportedHash = await bcrypt.hash(password, 10)
    await holder.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      unsupportedHash,
      userId,
    ])
    passwordAdmissionLogger.info.mockClear()
    await openPace()
    const unsupportedMasked = await withRuntime(() =>
      login('member@example.invalid', password, '192.0.3.42')
    )
    expect(unsupportedMasked.status).toBe(401)
    expect(compare).toHaveBeenCalledTimes(42)
    expect(compare.mock.calls[41][1]).toBe(PASSWORD_DUMMY_HASH)
    expect(passwordAdmissionLogger.info).toHaveBeenCalledWith(
      { event: 'password_credential_reset_required' },
      'unsupported member credential'
    )

    const afterMaskedRequest = (
      await holder.pool.query(
        'SELECT successes, failures FROM password_identifier_state WHERE identifier_key = $1',
        [passwordIdentifierKey('member@example.invalid')]
      )
    ).rows[0]
    expect(afterMaskedRequest.successes).toHaveLength(40)
    expect(afterMaskedRequest.failures).toHaveLength(1)
  }, 60_000)
  it('reports a genuinely unsupported stored credential without verifying it', async () => {
    passwordAdmissionLogger.info.mockClear()
    const unsupportedHash = await bcrypt.hash(password, 10)
    await holder.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      unsupportedHash,
      userId,
    ])

    const response = await withRuntime(() => login('member@example.invalid', password))

    expect(response.status).toBe(401)
    expect(compare).toHaveBeenCalledTimes(1)
    expect(compare.mock.calls[0][1]).toBe(PASSWORD_DUMMY_HASH)
    expect(passwordAdmissionLogger.info).toHaveBeenCalledWith(
      { event: 'password_credential_reset_required' },
      'unsupported member credential'
    )
  })
  it('does not report reset-required for unknown, inactive, or passwordless identities', async () => {
    await holder.pool.query(
      "INSERT INTO users(email) VALUES ('no-password@example.invalid') ON CONFLICT DO NOTHING"
    )
    const controlAdminId = randomUUID()
    await holder.pool.query(
      `INSERT INTO control_admin_users(id, username, password_hash, role, status)
       VALUES ($1, $2, 'synthetic-diagnostic-admin', 'admin', 'active')`,
      [controlAdminId, `diagnostic-admin-${controlAdminId}`]
    )
    const retired = await withRuntime(() =>
      retireDesktopUser(
        { kind: 'control_admin', controlAdminId },
        userId,
        'Synthetic inactive identity diagnostic check',
        `retirement-${randomBytes(12).toString('hex')}`,
        null,
        { retainWithoutLinkHistory: true }
      )
    )
    expect(retired.outcome).toBe('retired')
    passwordAdmissionLogger.info.mockClear()

    for (const email of [
      'unknown@example.invalid',
      'member@example.invalid',
      'no-password@example.invalid',
    ]) {
      await openPace()
      const response = await withRuntime(() => login(email))
      expect({ status: response.status, body: response.body }).toEqual({
        status: 401,
        body: { error: 'invalid_credentials' },
      })
      expect(compare.mock.calls.at(-1)?.[1]).toBe(PASSWORD_DUMMY_HASH)
    }
    expect(
      passwordAdmissionLogger.info.mock.calls.filter(
        ([fields]) =>
          (fields as { event?: unknown } | undefined)?.event ===
          'password_credential_reset_required'
      )
    ).toHaveLength(0)
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
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address() as { port: number }
    let child: ExternalRestHttpProcess | undefined
    try {
      child = await startExternalRestHttpProcess({
        controlApiBaseUrl: `http://127.0.0.1:${address.port}`,
        controlApiServiceToken: 'synthetic-login-service-token',
        jwtPrivateKey: process.env.CONTROL_API_SESSION_JWT_PRIVATE_KEY!,
      })
      const edge = child.baseUrl
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
      try {
        await child?.stop()
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        )
      }
    }
  })
})
