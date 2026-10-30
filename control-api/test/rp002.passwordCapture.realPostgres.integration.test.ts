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
realPg('Spec 092 durable outcome admission and capture lifetime', () => {
  const database = `rp002_${randomBytes(6).toString('hex')}`
  let admin: Pool
  let root: Pool
  let connectionString: string
  let db: typeof import('../src/db.js')
  let admissionState: typeof import('../src/services/auth/passwordAdmissionState.js')
  let engine: typeof import('../src/services/auth/passwordCredentialVerification.js')
  let login: typeof import('../src/services/directory/login.js')
  let work: typeof import('../src/services/auth/passwordWorkOwnership.js')
  let userId: string
  let hash: string
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    connectionString = url.toString()
    root = new Pool({ connectionString })
    vi.stubEnv('CONTROL_API_PG_CONNECTION_STRING', connectionString)
    vi.stubEnv('CORE_POOL_MAX', '2')
    vi.resetModules()
    db = await import('../src/db.js')
    await db.initDb()
    engine = await import('../src/services/auth/passwordCredentialVerification.js')
    admissionState = await import('../src/services/auth/passwordAdmissionState.js')
    login = await import('../src/services/directory/login.js')
    work = await import('../src/services/auth/passwordWorkOwnership.js')
    hash = await bcrypt.hash(password, 12)
  }, 60_000)
  beforeEach(async () => {
    vi.restoreAllMocks()
    await root.query(
      'TRUNCATE password_identifier_state, password_verification_pace, password_verification_work'
    )
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
      if (root) await endPoolAndWaitForClients(root)
      if (admin) await admin.query(`DROP DATABASE "${database}"`)
    } finally {
      await admin?.end()
      vi.unstubAllEnvs()
    }
  })
  async function row() {
    return (
      await db.pool.query('SELECT * FROM password_identifier_state WHERE identifier_key=$1', [
        admissionState.passwordIdentifierKey(email),
      ])
    ).rows[0]
  }
  async function completeCapture(
    capture: Awaited<ReturnType<typeof engine.capturePasswordEvaluation>>,
    success: boolean
  ) {
    if (!capture) throw new Error('expected admitted capture')
    const lease = await work.acquirePasswordWork()
    if (!lease) throw new Error('expected free durable work owner')
    const started = await engine.markPasswordEvaluationRunning(capture, lease)
    if (!started) {
      await work.releasePasswordWork(lease)
      return false
    }
    await work.releasePasswordWork(lease)
    return engine.completePasswordEvaluation(capture, success, lease)
  }
  async function withHeldComparison(workDuringBcrypt: () => Promise<void>) {
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    vi.spyOn(bcrypt, 'compare').mockImplementation(async (submitted: string, stored: string) => {
      const result = await realCompare(submitted, stored)
      entered()
      await held
      return result
    })
    const verification = login.verifyUserPassword({ userId, email, password })
    try {
      await started
      await workDuringBcrypt()
    } finally {
      release()
    }
    return verification
  }

  it('completes correct Desktop reverification while cleanup runs during bcrypt', async () => {
    const result = await withHeldComparison(async () => {
      await engine.cleanupPasswordIdentifierState()
    })
    expect(result).toBe(true)
    expect((await row()).provisional_operation).toBeNull()
    expect((await row()).successes).toEqual([])
  })

  it('does not let legacy cleanup delete or reclaim a running operation', async () => {
    const result = await withHeldComparison(async () => {
      await root.query(`DELETE FROM password_identifier_state
        WHERE locked_until_ms <= floor(extract(epoch FROM clock_timestamp()) * 1000)
        AND NOT EXISTS (SELECT 1 FROM unnest(attempts || failures) t
          WHERE t > floor(extract(epoch FROM clock_timestamp()) * 1000) - 900000)`)
      const during = await row()
      expect(during.provisional_phase).toBe('running')
      await root.query(
        `UPDATE password_identifier_state
            SET provisional_expires_at_ms = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 1,
                retained_until_ms = 0 WHERE identifier_key=$1`,
        [admissionState.passwordIdentifierKey(email)]
      )
      expect(await engine.cleanupPasswordIdentifierState()).toBe(0)
      expect((await row()).provisional_phase).toBe('running')
    })
    expect(result).toBe(true)
  })

  it('expires only an unstarted reservation and records no failure', async () => {
    const capture = await engine.capturePasswordEvaluation(email, false)
    if (!capture) throw new Error('expected capture')
    const expiredAt =
      Number(
        (await root.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS ms'))
          .rows[0].ms
      ) - 1
    capture.expiresAt = expiredAt
    await root.query(
      `UPDATE password_identifier_state SET provisional_expires_at_ms = $2
        WHERE identifier_key=$1 AND provisional_operation=$3`,
      [admissionState.passwordIdentifierKey(email), expiredAt, capture.operation]
    )
    const lease = await work.acquirePasswordWork()
    if (!lease) throw new Error('expected work lease')
    expect(await engine.markPasswordEvaluationRunning(capture, lease)).toBe(false)
    await work.releasePasswordWork(lease)
    expect(await row()).toMatchObject({ provisional_operation: null, failures: [] })
  })

  it('fences running completion after a real password-generation change', async () => {
    const result = await withHeldComparison(async () => {
      await db.pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [
        userId,
        await bcrypt.hash('Synthetic-RP002-replacement', 12),
      ])
      await engine.cleanupPasswordIdentifierState()
    })
    expect(result).toBe(false)
    expect(await row()).toMatchObject({
      failures: [],
      locked_until_ms: '0',
      provisional_operation: null,
    })
  })

  it('admits one operation per identity and makes terminal completion idempotently fail closed', async () => {
    const capture = await engine.capturePasswordEvaluation(email, false)
    expect(capture).not.toBeNull()
    await expect(engine.capturePasswordEvaluation(email, true)).rejects.toMatchObject({
      status: 429,
    })
    if (!capture) throw new Error('expected capture')
    const lease = await work.acquirePasswordWork()
    if (!lease) throw new Error('expected work lease')
    expect(await engine.markPasswordEvaluationRunning(capture, lease)).toBe(true)
    await work.releasePasswordWork(lease)
    expect(await engine.completePasswordEvaluation(capture, false, lease)).toBe(true)
    expect(await engine.completePasswordEvaluation(capture, false, lease)).toBe(false)
    expect((await row()).failures).toHaveLength(1)
  })

  it('preserves a prior failure across successful authenticated reverification', async () => {
    const failure = await engine.capturePasswordEvaluation(email, false)
    expect(await completeCapture(failure, false)).toBe(true)
    expect(await login.verifyUserPassword({ userId, email, password })).toBe(true)
    expect(await row()).toMatchObject({ failures: expect.any(Array), successes: [] })
    expect((await row()).failures).toHaveLength(1)
  })

  it('applies the migration hold to live legacy admissions without inventing outcomes', async () => {
    const key = admissionState.passwordIdentifierKey('legacy@example.invalid')
    const at = Number(
      (await root.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms'))
        .rows[0].ms
    )
    await root.query(
      'INSERT INTO password_identifier_state(identifier_key,attempts) VALUES ($1,$2)',
      [key, [at]]
    )
    const schema = await import('../src/services/auth/passwordAdmissionSchema.js')
    await schema.applyPasswordSuccessAdmissionSchema(root)
    await schema.applyPasswordSuccessAdmissionSchema(root)
    const legacy = (
      await db.pool.query(
        'SELECT attempts,failures,successes,uncertain,legacy_hold_until_ms FROM password_identifier_state WHERE identifier_key=$1',
        [key]
      )
    ).rows[0]
    expect(legacy).toMatchObject({
      attempts: [String(at)],
      failures: [],
      successes: [],
      uncertain: [],
    })
    expect(Number(legacy.legacy_hold_until_ms)).toBe(at + 900_000)
    await expect(
      engine.capturePasswordEvaluation('legacy@example.invalid', false)
    ).rejects.toMatchObject({ status: 429, reason: 'identifier_migration_hold' })
  })

  it('uses the database fence to reject old verifier writes but accepts the v2 protocol', async () => {
    const client = await root.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE control_api_runtime')
      await expect(
        client.query('INSERT INTO password_identifier_state(identifier_key) VALUES ($1)', [
          admissionState.passwordIdentifierKey('legacy-binary@example.invalid'),
        ])
      ).rejects.toMatchObject({ code: '55000' })
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE control_api_runtime')
      await client.query("SET LOCAL app.password_admission_protocol = 'v2'")
      await client.query('INSERT INTO password_identifier_state(identifier_key) VALUES ($1)', [
        admissionState.passwordIdentifierKey('v2-binary@example.invalid'),
      ])
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  it('does not reclaim running work after its deadline and rejects stale instances after cleanup', async () => {
    const capture = await engine.capturePasswordEvaluation(email, false)
    if (!capture) throw new Error('expected capture')
    const lease = await work.acquirePasswordWork()
    if (!lease) throw new Error('expected work lease')
    expect(await engine.markPasswordEvaluationRunning(capture, lease)).toBe(true)
    await work.releasePasswordWork(lease)
    await root.query(
      `UPDATE password_identifier_state
          SET provisional_expires_at_ms = 0, retained_until_ms = 0
        WHERE identifier_key=$1`,
      [admissionState.passwordIdentifierKey(email)]
    )
    expect(await engine.cleanupPasswordIdentifierState()).toBe(0)
    expect((await row()).provisional_phase).toBe('running')
  })
})
