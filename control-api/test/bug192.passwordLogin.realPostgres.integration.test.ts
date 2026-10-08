import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { createPublicKey, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'
import { verifyUserPassword } from '../src/services/directory/login.js'
import { verifyExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
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
const realPg = adminUrl ? describe : describe.skip
const password = 'Synthetic-BUG192-correct-password'
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
    app.use(createExternalAuthRouter({} as Parameters<typeof createExternalAuthRouter>[0]))
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
        res.status(500).json({ error: 'unexpected_test_failure' })
    )
  }, 60_000)
  beforeEach(async () => {
    vi.restoreAllMocks()
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
    for (let i = 0; i < 5; i++) {
      await openPace()
      await login(`source-${i}@example.invalid`)
    }
    const before = compare.mock.calls.length
    const response = await login('sixth@example.invalid')
    expect(response.status).toBe(429)
    expect(response.body.error).toBe('rate_limited')
    expect(compare.mock.calls.length).toBe(before)
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
    const before = compare.mock.calls.length
    const response = await login('Member@Example.Invalid', 'wrong', '192.0.2.100')
    expect(response.status).toBe(429)
    expect(response.body.error).toBe('rate_limited')
    expect(compare.mock.calls.length).toBe(before)
  })
  it('applies the same pace to unknown and existing evaluations with burst one', async () => {
    expect((await login('unknown@example.invalid')).status).toBe(401)
    const response = await login('member@example.invalid', 'wrong', '192.0.2.2')
    expect(response.status).toBe(429)
    expect(compare).toHaveBeenCalledTimes(1)
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(8)
  })
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
