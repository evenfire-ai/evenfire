import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip
const password = 'Synthetic-RP002-correct-password'
const email = 'member@example.invalid'
const realCompare = bcrypt.compare.bind(bcrypt)
realPg('RP-002 durable credential evaluation lifetime', () => {
  const database = `rp002_${randomBytes(6).toString('hex')}`
  let admin: Pool
  let db: typeof import('../src/db.js')
  let engine: typeof import('../src/services/auth/passwordCredentialVerification.js')
  let login: typeof import('../src/services/directory/login.js')
  let userId: string
  let hash: string
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    vi.stubEnv('CONTROL_API_PG_CONNECTION_STRING', url.toString())
    vi.stubEnv('CORE_POOL_MAX', '2')
    vi.resetModules()
    db = await import('../src/db.js')
    await db.initDb()
    engine = await import('../src/services/auth/passwordCredentialVerification.js')
    login = await import('../src/services/directory/login.js')
    hash = await bcrypt.hash(password, 12)
  }, 60_000)
  beforeEach(async () => {
    vi.restoreAllMocks()
    await db.pool.query('TRUNCATE password_identifier_state, password_verification_pace')
    await db.pool.query('DELETE FROM users')
    userId = String(
      (
        await db.pool.query('INSERT INTO users(email,password_hash) VALUES ($1,$2) RETURNING id', [
          email,
          hash,
        ])
      ).rows[0].id
    )
  })
  afterAll(async () => {
    try {
      vi.restoreAllMocks()
      if (db) {
        await endPoolAndWaitForClients(db.pool)
        await endPoolAndWaitForClients(db.rateLimitPool)
      }
      if (admin) await admin.query(`DROP DATABASE "${database}"`)
    } finally {
      await admin?.end()
      vi.unstubAllEnvs()
    }
  })
  async function withHeldComparison(work: () => Promise<void>) {
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    vi.spyOn(bcrypt, 'compare').mockImplementation(async (submitted: string, stored: string) => {
      entered()
      await held
      return realCompare(submitted, stored)
    })
    const verification = login.verifyUserPassword({ userId, email, password })
    try {
      await started
      await work()
    } finally {
      release()
    }
    return verification
  }
  it('completes correct Desktop verification when real cleanup runs during bcrypt', async () => {
    const result = await withHeldComparison(async () => {
      await engine.cleanupPasswordIdentifierState()
    })
    expect(result).toBe(true)
  })
  it('protects an admitted capture from an older cleanup SQL owner', async () => {
    const result = await withHeldComparison(async () => {
      await db.pool.query(`DELETE FROM password_identifier_state
        WHERE locked_until_ms <= floor(extract(epoch FROM clock_timestamp()) * 1000)
        AND NOT EXISTS (SELECT 1 FROM unnest(attempts || failures) t
          WHERE t > floor(extract(epoch FROM clock_timestamp()) * 1000) - 900000)`)
    })
    expect(result).toBe(true)
  })
  it('rejects an expired producer capture without adding a failure', async () => {
    const transaction = db.withTransaction
    vi.spyOn(db, 'withTransaction').mockImplementation(work =>
      transaction(async client => {
        const query = client.query.bind(client)
        return work({
          ...client,
          query: (sql: string, values?: unknown[]) =>
            sql.includes('AS now_ms')
              ? query(
                  sql.replace('clock_timestamp()', "clock_timestamp() - interval '16 minutes'"),
                  values
                )
              : query(sql, values),
        })
      })
    )
    const capture = await engine.capturePasswordEvaluation(email, false)
    vi.restoreAllMocks()
    expect(await engine.completePasswordEvaluation(capture, false)).toBe(false)
    expect(
      (await db.pool.query('SELECT failures FROM password_identifier_state')).rows[0].failures
    ).toEqual([])
  })
  it('still rejects credential changes during a retained verification', async () => {
    const result = await withHeldComparison(async () => {
      await db.pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [
        userId,
        await bcrypt.hash('Synthetic-replacement', 12),
      ])
      await engine.cleanupPasswordIdentifierState()
    })
    expect(result).toBe(false)
    expect(
      (await db.pool.query('SELECT failures,locked_until_ms FROM password_identifier_state'))
        .rows[0]
    ).toMatchObject({ failures: [], locked_until_ms: '0' })
  })
  it('keeps later captures retained when an earlier one completes', async () => {
    const first = await engine.capturePasswordEvaluation(email, false)
    const second = await engine.capturePasswordEvaluation(email, false)
    expect(await engine.completePasswordEvaluation(first, false)).toBe(true)
    await engine.cleanupPasswordIdentifierState()
    expect(await engine.completePasswordEvaluation(second, false)).toBe(true)
    expect(
      (await db.pool.query('SELECT failures FROM password_identifier_state')).rows[0].failures
    ).toHaveLength(2)
  })
  it('preserves success revision fencing against an older failed result', async () => {
    const failure = await engine.capturePasswordEvaluation(email, false)
    const success = await engine.capturePasswordEvaluation(email, false)
    expect(await engine.completePasswordEvaluation(success, true)).toBe(true)
    expect(await engine.completePasswordEvaluation(failure, false)).toBe(false)
    expect(
      (await db.pool.query('SELECT failures FROM password_identifier_state')).rows[0].failures
    ).toEqual([])
  })
  it('expires retention naturally without deleting active history or cooldown', async () => {
    for (const identity of ['empty', 'attempt', 'failure', 'cooldown']) {
      const capture = await engine.capturePasswordEvaluation(`${identity}@example.invalid`, false)
      if (identity === 'failure' || identity === 'cooldown')
        await engine.completePasswordEvaluation(capture, false)
      if (identity === 'attempt')
        await engine.capturePasswordEvaluation(`${identity}@example.invalid`, true)
      if (identity === 'cooldown') {
        for (let i = 1; i < 5; i++) {
          const next = await engine.capturePasswordEvaluation(`${identity}@example.invalid`, false)
          await engine.completePasswordEvaluation(next, false)
        }
      }
    }
    await db.pool.query('UPDATE password_identifier_state SET retained_until_ms=0')
    expect(await engine.cleanupPasswordIdentifierState()).toBe(1)
    expect(
      (await db.pool.query('SELECT identifier_key FROM password_identifier_state')).rows
    ).toHaveLength(3)
  })
  it('rejects old instance completion after expired retention cleanup and recreation', async () => {
    const old = await engine.capturePasswordEvaluation(email, false)
    await db.pool.query('UPDATE password_identifier_state SET retained_until_ms=0')
    expect(await engine.cleanupPasswordIdentifierState()).toBe(1)
    await engine.capturePasswordEvaluation(email, false)
    expect(await engine.completePasswordEvaluation(old, false)).toBe(false)
    expect(
      (await db.pool.query('SELECT failures FROM password_identifier_state')).rows[0].failures
    ).toEqual([])
  })
  it('pins a legacy capture update and permits cleanup after its deadline', async () => {
    await engine.capturePasswordEvaluation(email, false)
    await db.pool.query('UPDATE password_identifier_state SET retained_until_ms=0')
    // This is the exact legacy producer shape: settled histories but no retention field.
    await db.pool.query(
      'UPDATE password_identifier_state SET attempts=$1,failures=$2,locked_until_ms=$3',
      [[], [], 0]
    )
    await db.pool.query('DELETE FROM password_identifier_state')
    expect((await db.pool.query('SELECT * FROM password_identifier_state')).rows).toHaveLength(1)
    await db.pool.query('UPDATE password_identifier_state SET retained_until_ms=0')
    await db.pool.query('DELETE FROM password_identifier_state')
    expect((await db.pool.query('SELECT * FROM password_identifier_state')).rows).toHaveLength(0)
  })
  it('backfills existing captures and applies the forward migration idempotently', async () => {
    await engine.capturePasswordEvaluation(email, false)
    const schema = await import('../src/services/auth/passwordAdmissionSchema.js')
    await db.pool.query('DROP TRIGGER password_evaluation_retention ON password_identifier_state')
    await db.pool.query('ALTER TABLE password_identifier_state DROP COLUMN retained_until_ms')
    await schema.applyPasswordEvaluationRetentionSchema(db.pool)
    await schema.applyPasswordEvaluationRetentionSchema(db.pool)
    await db.pool.query('DELETE FROM password_identifier_state')
    expect((await db.pool.query('SELECT * FROM password_identifier_state')).rows).toHaveLength(1)
    expect(
      await engine.completePasswordEvaluation(
        await engine.capturePasswordEvaluation(email, false),
        true
      )
    ).toBe(true)
  })
})
