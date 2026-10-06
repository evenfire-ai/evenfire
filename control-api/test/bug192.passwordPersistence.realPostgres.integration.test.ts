import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { applyPasswordAdmissionSchema } from '../src/services/auth/passwordAdmissionSchema.js'
import {
  passwordIdentifierKey,
  PASSWORD_ADMISSION_POLICY as policy,
} from '../src/services/auth/passwordAdmissionState.js'
import {
  capturePasswordEvaluation,
  cleanupPasswordIdentifierState,
  completePasswordEvaluation,
  reservePasswordPace,
  verifyMemberPassword,
} from '../src/services/auth/passwordCredentialVerification.js'
import {
  setInvitationPasswordForEmail,
  updateUserPassword,
} from '../src/services/directory/membership.js'
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
      r: Parameters<typeof real.acquireRateLimitConcurrencyLease>[0]
    ) => real.acquireRateLimitConcurrencyLease(r, { client: holder.leaseClient }),
  }
})
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip
realPg('Spec 043 persistence, migration, atomicity and fencing design acceptance', () => {
  const database = `bug192_design_${randomBytes(6).toString('hex')}`
  const email = 'member@example.invalid',
    password = 'Synthetic-BUG192-correct-password'
  let admin: Pool, userId: string, hash: string, connectionString: string
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    connectionString = url.toString()
    holder.pool = new Pool({ connectionString })
    await initDb(holder.pool)
    holder.leaseClient = await holder.pool.connect()
    hash = await bcrypt.hash(password, 12)
  }, 60_000)
  beforeEach(async () => {
    vi.restoreAllMocks()
    await holder.pool.query('DELETE FROM users')
    await holder.pool.query('DELETE FROM password_identifier_state')
    await holder.pool.query('DELETE FROM password_verification_pace')
    userId = (
      await holder.pool.query(
        'INSERT INTO users(email,password_hash) VALUES ($1,$2) RETURNING id',
        [email, hash]
      )
    ).rows[0].id
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
  async function now() {
    return Number(
      (
        await holder.pool.query(
          'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms'
        )
      ).rows[0].ms
    )
  }
  async function row() {
    return (
      await holder.pool.query('SELECT * FROM password_identifier_state WHERE identifier_key=$1', [
        passwordIdentifierKey(email),
      ])
    ).rows[0]
  }
  async function completedFailures(n = 5) {
    for (let i = 0; i < n; i++) {
      const c = await capturePasswordEvaluation(email, false)
      expect(await completePasswordEvaluation(c, false)).toBe(true)
    }
  }

  it('forward migration is idempotent and grants runtime access', async () => {
    await applyPasswordAdmissionSchema(holder.pool)
    const permissions = (
      await holder.pool.query(
        "SELECT has_table_privilege('control_api_runtime','password_identifier_state','SELECT,INSERT,UPDATE,DELETE') AS state, has_table_privilege('control_api_runtime','password_verification_pace','SELECT,INSERT,UPDATE,DELETE') AS pace"
      )
    ).rows[0]
    expect(permissions).toEqual({ state: true, pace: true })
    const migrations = (
      await holder.pool.query(
        "SELECT version FROM schema_migrations WHERE version='0125_bug192_password_admission'"
      )
    ).rows
    expect(migrations).toHaveLength(1)
  })
  it('serializes competing identifier attempts to exactly five admissions', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => capturePasswordEvaluation(email, true))
    )
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(5)
    expect((await row()).attempts).toHaveLength(5)
    const before = await row()
    for (let i = 0; i < 3; i++)
      await expect(capturePasswordEvaluation(email, true)).rejects.toMatchObject({ status: 429 })
    expect(await row()).toEqual(before)
  })
  it('fifth failure sets one cooldown from DB completion time without extension', async () => {
    await completedFailures(4)
    const before = await now()
    const c = await capturePasswordEvaluation(email, false)
    await completePasswordEvaluation(c, false)
    const after = await now()
    const state = await row()
    expect(Number(state.locked_until_ms)).toBeGreaterThanOrEqual(before + policy.cooldownMs)
    expect(Number(state.locked_until_ms)).toBeLessThanOrEqual(after + policy.cooldownMs)
    for (let i = 0; i < 4; i++)
      await expect(capturePasswordEvaluation(email, true)).rejects.toMatchObject({ status: 429 })
    expect(await row()).toEqual(state)
  })
  it('active attempt budget and staggered cooldown have real/shadow equivalent retry state', async () => {
    const shadow = 'shadow@example.invalid'
    const t = await now()
    for (const identity of [email, shadow]) {
      await capturePasswordEvaluation(identity, false)
      await holder.pool.query(
        'UPDATE password_identifier_state SET attempts=$2,failures=$2,locked_until_ms=$3 WHERE identifier_key=$1',
        [
          passwordIdentifierKey(identity),
          [t - 1000000, t - 850000, t - 800000, t - 750000, t - 700000],
          t + 200000,
        ]
      )
    }
    const outcomes = await Promise.all(
      [email, shadow].map(identity =>
        capturePasswordEvaluation(identity, true).catch(e => ({
          status: e.status,
          retryAfterSeconds: e.retryAfterSeconds,
        }))
      )
    )
    expect(outcomes[0]).toEqual(outcomes[1])
    expect(outcomes[0]).toMatchObject({ status: 429 })
  })
  it('attempt budget exhaustion ends naturally despite repeated denied requests', async () => {
    for (let i = 0; i < 5; i++) await capturePasswordEvaluation(email, true)
    const state = await row()
    await expect(capturePasswordEvaluation(email, true)).rejects.toMatchObject({ status: 429 })
    expect(await row()).toEqual(state)
    const t = await now()
    await holder.pool.query(
      'UPDATE password_identifier_state SET attempts=$2 WHERE identifier_key=$1',
      [passwordIdentifierKey(email), [t - policy.windowMs - 1]]
    )
    await expect(capturePasswordEvaluation(email, true)).resolves.toBeDefined()
    expect((await row()).attempts).toHaveLength(1)
  })
  it('natural cooldown expiry removes stale failures without extending attempts', async () => {
    await completedFailures()
    const t = await now()
    await holder.pool.query(
      'UPDATE password_identifier_state SET locked_until_ms=$2,failures=$3 WHERE identifier_key=$1',
      [passwordIdentifierKey(email), t - 1, [t - policy.windowMs - 1]]
    )
    await capturePasswordEvaluation(email, false)
    expect(await row()).toMatchObject({ locked_until_ms: '0', failures: [] })
  })
  it('successful authentication/reverification clears failures but retains public attempt history', async () => {
    const failed = await capturePasswordEvaluation(email, true)
    await completePasswordEvaluation(failed, false)
    expect(
      await verifyMemberPassword(email, password, { publicLogin: false, userId })
    ).toMatchObject({ id: userId })
    const state = await row()
    expect(state.failures).toEqual([])
    expect(state.locked_until_ms).toBe('0')
    expect(state.attempts).toHaveLength(1)
  })
  it('successful completion fences an older failure completion on the same credential', async () => {
    const older = await capturePasswordEvaluation(email, false),
      successful = await capturePasswordEvaluation(email, false)
    expect(await completePasswordEvaluation(successful, true)).toBe(true)
    expect(await completePasswordEvaluation(older, false)).toBe(false)
    expect((await row()).failures).toEqual([])
  })
  it('real password-change producer fences stale failure and success results', async () => {
    const failure = await capturePasswordEvaluation(email, false),
      success = await capturePasswordEvaluation(email, false)
    expect(
      await updateUserPassword(userId, email, password, 'Synthetic-BUG192-new-password')
    ).toEqual({ updated: true })
    expect(await completePasswordEvaluation(failure, false)).toBe(false)
    expect(await completePasswordEvaluation(success, true)).toBe(false)
    expect((await row()).failures).toEqual([])
  })
  it('real reset/establishment producer clears cooldown and fences old work', async () => {
    const stale = await capturePasswordEvaluation(email, false)
    await completedFailures()
    // Database producer for a pending reset; the real reset function owns the
    // credential write/acceptance and its generation trigger in one transaction.
    const invitation = (
      await holder.pool.query(
        "INSERT INTO invitations(email,role,purpose,status) VALUES ($1,'member','password_reset','pending') RETURNING id",
        [email]
      )
    ).rows[0]
    const result = await setInvitationPasswordForEmail(
      email,
      invitation.id,
      'Synthetic-BUG192-reset-password'
    )
    expect(result).not.toHaveProperty('error')
    expect(await completePasswordEvaluation(stale, false)).toBe(false)
    expect(await row()).toMatchObject({ failures: [], locked_until_ms: '0' })
    const credential = (
      await holder.pool.query('SELECT password_hash FROM users WHERE id=$1', [userId])
    ).rows[0]
    expect(bcrypt.getRounds(credential.password_hash)).toBe(12)
  })
  it('provisioning and lifecycle changes fence stale completions at the database boundary', async () => {
    for (const update of ['password_hash = NULL', 'lifecycle_version = lifecycle_version + 1']) {
      const stale = await capturePasswordEvaluation(email, false)
      await holder.pool.query(`UPDATE users SET ${update} WHERE id=$1`, [userId])
      expect(await completePasswordEvaluation(stale, false)).toBe(false)
    }
  })
  it('new identity creation fences an old shadow evaluation', async () => {
    const stale = await capturePasswordEvaluation('new@example.invalid', false)
    await holder.pool.query(
      "INSERT INTO users(email,password_hash) VALUES ('new@example.invalid',$1)",
      [hash]
    )
    expect(await completePasswordEvaluation(stale, false)).toBe(false)
  })
  it('two aggregate reservations cannot both win, and denials do not advance pace', async () => {
    const results = await Promise.allSettled([reservePasswordPace(), reservePasswordPace()])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const before = (await holder.pool.query('SELECT * FROM password_verification_pace')).rows
    await expect(reservePasswordPace()).rejects.toMatchObject({ status: 429 })
    expect((await holder.pool.query('SELECT * FROM password_verification_pace')).rows).toEqual(
      before
    )
    await holder.pool.query(
      "UPDATE password_verification_pace SET next_permit=clock_timestamp()-interval '1 minute'"
    )
    await reservePasswordPace()
    await expect(reservePasswordPace()).rejects.toMatchObject({ status: 429 })
  })
  it('persisted aggregate pacing works across independent Node processes', async () => {
    // The required hosted PostgreSQL lane runs source tests without building Control API.
    // Reuse its declared ts-node resolver so both processes execute the real producer.
    const script = `require('ts-node').register({project:'./tsconfig.json',experimentalResolver:true,transpileOnly:true});const {reservePasswordPace}=require('./src/services/auth/passwordCredentialVerification.ts');reservePasswordPace().then(()=>{console.log('ALLOWED');process.exit(0)},e=>{console.log('DENIED:'+e.status);process.exit(e.status===429?0:1)})`
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], {
          cwd: process.cwd(),
          env: { ...process.env, CONTROL_API_PG_CONNECTION_STRING: connectionString },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = '',
          err = ''
        child.stdout.on('data', c => (out += c))
        child.stderr.on('data', c => (err += c))
        const timeout = setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error('bounded child timed out'))
        }, 10000)
        child.once('exit', code => {
          clearTimeout(timeout)
          if (code !== 0) reject(new Error('child failed: ' + err))
          else resolve(out.trim())
        })
      })
    const results = await Promise.all([run(), run()])
    expect(results.sort()).toEqual(['ALLOWED', 'DENIED:429'])
  })
  it('busy bcrypt is rejected without queue and the reserved pace is not refunded', async () => {
    let started!: () => void, finish!: (value: boolean) => void
    const entered = new Promise<void>(r => (started = r)),
      held = new Promise<boolean>(r => (finish = r))
    const spy = vi.spyOn(bcrypt, 'compare').mockImplementationOnce(async () => {
      started()
      return held
    })
    const first = verifyMemberPassword(email, 'wrong', { publicLogin: false, userId })
    await entered
    try {
      await holder.pool.query(
        "UPDATE password_verification_pace SET next_permit=clock_timestamp()-interval '1 second'"
      )
      await expect(
        verifyMemberPassword('shadow@example.invalid', 'wrong', { publicLogin: true })
      ).rejects.toMatchObject({ status: 429 })
      expect(spy).toHaveBeenCalledTimes(1)
      await expect(reservePasswordPace()).rejects.toMatchObject({ status: 429 })
    } finally {
      finish(false)
      await first
    }
  })
  it('cleanup retains each active component and preserves stale-result fencing after recreation', async () => {
    const t = await now()
    for (const kind of ['attempt', 'failure', 'cooldown']) {
      const identity = `${kind}@example.invalid`
      await capturePasswordEvaluation(identity, false)
      await holder.pool.query(
        'UPDATE password_identifier_state SET attempts=$2,failures=$3,locked_until_ms=$4 WHERE identifier_key=$1',
        [
          passwordIdentifierKey(identity),
          kind === 'attempt' ? [t] : [],
          kind === 'failure' ? [t] : [],
          kind === 'cooldown' ? t + policy.cooldownMs : 0,
        ]
      )
    }
    const old = await capturePasswordEvaluation('expired@example.invalid', false)
    expect(await cleanupPasswordIdentifierState()).toBe(1)
    expect((await holder.pool.query('SELECT * FROM password_identifier_state')).rows).toHaveLength(
      3
    )
    await capturePasswordEvaluation('expired@example.invalid', false)
    expect(await completePasswordEvaluation(old, false)).toBe(false)
    expect(
      (await holder.pool.query('SELECT password_auth_generation FROM users WHERE id=$1', [userId]))
        .rows[0]
    ).toHaveProperty('password_auth_generation')
  })
})
