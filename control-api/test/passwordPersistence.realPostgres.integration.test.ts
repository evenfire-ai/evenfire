import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import {
  applyPasswordAdmissionSchema,
  applyPasswordSuccessAdmissionSchema,
} from '../src/services/auth/passwordAdmissionSchema.js'
import {
  passwordIdentifierKey,
  PASSWORD_ADMISSION_POLICY as policy,
} from '../src/services/auth/passwordAdmissionState.js'
import {
  cancelUnstartedPasswordEvaluation,
  capturePasswordEvaluation,
  cleanupPasswordIdentifierState,
  completePasswordEvaluation,
  markPasswordEvaluationRunning,
  reservePasswordPace,
  verifyMemberPassword,
} from '../src/services/auth/passwordCredentialVerification.js'
import {
  acquirePasswordWork,
  releasePasswordWork,
} from '../src/services/auth/passwordWorkOwnership.js'
import {
  acceptInvitationForEmail,
  createSilentInvitationForTeams,
  getInvitationByToken,
  setInvitationPasswordForEmail,
  setInvitationPasswordForUser,
  updateUserPassword,
  withMemberPasswordWorkLease,
} from '../src/services/directory/membership.js'
import {
  createPasswordResetInvitation,
  createSilentPasswordResetInvitation,
} from '../src/services/directory/passwordResetInvitations.js'
import { createPostgresCommitReplyBlackhole } from './helpers/realPostgresCancellation.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({
  pool: null as unknown as Pool,
  leaseClient: null as unknown as import('pg').PoolClient,
}))
const invitationFlow = vi.hoisted(() => ({
  registerAndSendInvitation: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/services/invitationFlowRegistrationService.js', () => invitationFlow)
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
    invitationFlow.registerAndSendInvitation.mockReset().mockResolvedValue(undefined)
    await holder.pool.query('DELETE FROM users')
    await holder.pool.query('TRUNCATE password_identifier_state, password_verification_pace')
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
      expect(await finishCapture(c, false)).toBe(true)
    }
  }
  async function finishCapture(
    capture: Awaited<ReturnType<typeof capturePasswordEvaluation>>,
    success: boolean
  ) {
    if (!capture) throw new Error('expected an admitted password evaluation')
    const lease = await acquirePasswordWork()
    if (!lease) throw new Error('expected available password work owner')
    const running = await markPasswordEvaluationRunning(capture, lease)
    if (!running) {
      await releasePasswordWork(lease)
      return false
    }
    await releasePasswordWork(lease)
    return completePasswordEvaluation(capture, success, lease)
  }
  async function reconcileRunningOperation(
    capture: NonNullable<Awaited<ReturnType<typeof capturePasswordEvaluation>>>,
    disposition: unknown
  ) {
    const current = (
      await holder.pool.query(
        `SELECT revision,provisional_epoch,provisional_owner_instance,
                provisional_owner_host,provisional_owner_pid
           FROM password_identifier_state WHERE identifier_key=$1`,
        [capture.key]
      )
    ).rows[0]
    return holder.pool.query(
      `SELECT * FROM password_reconcile_running_admission($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        capture.key,
        capture.instance,
        current.revision,
        capture.operation,
        current.provisional_epoch,
        current.provisional_owner_instance,
        current.provisional_owner_host,
        current.provisional_owner_pid,
        disposition,
      ]
    )
  }

  it('forward migration is idempotent and grants runtime access', async () => {
    await applyPasswordAdmissionSchema(holder.pool)
    await applyPasswordSuccessAdmissionSchema(holder.pool)
    await applyPasswordSuccessAdmissionSchema(holder.pool)
    const permissions = (
      await holder.pool.query(
        `SELECT has_table_privilege('control_api_runtime','password_identifier_state','SELECT,INSERT,UPDATE,DELETE') AS state,
                has_table_privilege('control_api_runtime','password_verification_pace','SELECT,INSERT,UPDATE,DELETE') AS pace,
                has_function_privilege('control_api_runtime',
                  'public.password_reconcile_running_admission(text,uuid,bigint,uuid,bigint,uuid,text,integer,text)',
                  'EXECUTE') AS recovery`
      )
    ).rows[0]
    expect(permissions).toEqual({ state: true, pace: true, recovery: false })
    const migrations = (
      await holder.pool.query(
        "SELECT version FROM schema_migrations WHERE version='0126_bug192_password_admission'"
      )
    ).rows
    expect(migrations).toHaveLength(1)
    expect(
      (
        await holder.pool.query(
          "SELECT version FROM schema_migrations WHERE version='0130_password_login_success_admission'"
        )
      ).rows
    ).toHaveLength(1)

    const legacyKey = passwordIdentifierKey('legacy@example.invalid')
    const legacyAttempt = await now()
    await holder.pool.query(
      'INSERT INTO password_identifier_state(identifier_key,attempts) VALUES ($1,$2)',
      [legacyKey, [legacyAttempt]]
    )
    await applyPasswordSuccessAdmissionSchema(holder.pool)
    const legacy = (
      await holder.pool.query(
        'SELECT legacy_hold_until_ms,successes,uncertain FROM password_identifier_state WHERE identifier_key=$1',
        [legacyKey]
      )
    ).rows[0]
    expect(Number(legacy.legacy_hold_until_ms)).toBe(legacyAttempt + policy.windowMs)
    expect(legacy.successes).toEqual([])
    expect(legacy.uncertain).toEqual([])

    const client = await holder.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE control_api_runtime')
      await expect(
        client.query('INSERT INTO password_identifier_state(identifier_key) VALUES ($1)', [
          passwordIdentifierKey('old-runtime@example.invalid'),
        ])
      ).rejects.toMatchObject({ code: '55000' })
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE control_api_runtime')
      await client.query("SET LOCAL app.password_admission_protocol = 'v2'")
      await client.query('INSERT INTO password_identifier_state(identifier_key) VALUES ($1)', [
        passwordIdentifierKey('new-runtime@example.invalid'),
      ])
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    await expect(
      holder.pool.query(
        `UPDATE password_identifier_state
            SET terminal_operation=$2, terminal_disposition=NULL,
                terminal_at_ms=$3, terminal_epoch=revision
          WHERE identifier_key=$1`,
        [legacyKey, randomUUID(), legacyAttempt]
      )
    ).rejects.toMatchObject({ code: '23514' })
  })
  it('rejects NULL provisional shape and fails closed without reclaiming malformed running state', async () => {
    const capture = await capturePasswordEvaluation(email, false)
    if (!capture) throw new Error('expected public reservation')
    const lease = await acquirePasswordWork()
    if (!lease) throw new Error('expected durable work owner')
    expect(await markPasswordEvaluationRunning(capture, lease)).toBe(true)
    await releasePasswordWork(lease)

    await expect(
      holder.pool.query(
        'UPDATE password_identifier_state SET provisional_phase = NULL WHERE identifier_key = $1',
        [capture.key]
      )
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      holder.pool.query(
        'UPDATE password_identifier_state SET provisional_scope = NULL WHERE identifier_key = $1',
        [capture.key]
      )
    ).rejects.toMatchObject({ code: '23514' })
    expect(await row()).toMatchObject({
      provisional_operation: capture.operation,
      provisional_phase: 'running',
      provisional_scope: 'public_login',
    })

    await holder.pool.query(
      'ALTER TABLE password_identifier_state DROP CONSTRAINT password_identifier_provisional_shape'
    )
    await holder.pool.query(`
      ALTER TABLE password_identifier_state
        ADD CONSTRAINT password_identifier_provisional_shape
        CHECK (provisional_operation IS NULL OR
          (provisional_phase IN ('reserved', 'running') AND
           provisional_scope IN ('public_login', 'authenticated_reverification')))
    `)
    await applyPasswordSuccessAdmissionSchema(holder.pool)
    await expect(
      holder.pool.query(
        'UPDATE password_identifier_state SET provisional_phase = NULL WHERE identifier_key = $1',
        [capture.key]
      )
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      holder.pool.query(
        'UPDATE password_identifier_state SET provisional_scope = NULL WHERE identifier_key = $1',
        [capture.key]
      )
    ).rejects.toMatchObject({ code: '23514' })

    await holder.pool.query(
      'ALTER TABLE password_identifier_state DROP CONSTRAINT password_identifier_provisional_shape'
    )
    try {
      await holder.pool.query(
        'UPDATE password_identifier_state SET provisional_phase = NULL WHERE identifier_key = $1',
        [capture.key]
      )
      await expect(capturePasswordEvaluation(email, false)).rejects.toThrow(
        'password admission provisional state is malformed'
      )
      expect(await row()).toMatchObject({
        provisional_operation: capture.operation,
        provisional_phase: null,
        provisional_scope: 'public_login',
        terminal_operation: null,
      })
    } finally {
      await holder.pool.query(
        "UPDATE password_identifier_state SET provisional_phase = 'running' WHERE identifier_key = $1",
        [capture.key]
      )
      await applyPasswordSuccessAdmissionSchema(holder.pool)
    }
  })
  it('recovers an ambiguous public operation with conservative failure and success debits once', async () => {
    const capture = await capturePasswordEvaluation(email, false)
    if (!capture) throw new Error('expected public reservation')
    const lease = await acquirePasswordWork()
    if (!lease) throw new Error('expected durable work owner')
    expect(await markPasswordEvaluationRunning(capture, lease)).toBe(true)
    await releasePasswordWork(lease)

    const recovered = await reconcileRunningOperation(capture, 'uncertain')
    expect(recovered.rows).toEqual([
      { reconciliation: 'uncertain', operation_id: capture.operation },
    ])
    const state = await row()
    expect(state).toMatchObject({
      failures: [],
      successes: expect.any(Array),
      uncertain: expect.any(Array),
      provisional_operation: null,
      terminal_operation: capture.operation,
      terminal_disposition: 'uncertain',
    })
    expect(state.successes).toHaveLength(1)
    expect(state.uncertain).toHaveLength(1)
    expect((await reconcileRunningOperation(capture, 'uncertain')).rows).toEqual([
      { reconciliation: 'already_terminal', operation_id: capture.operation },
    ])
    expect((await row()).successes).toHaveLength(1)
    expect((await row()).uncertain).toHaveLength(1)
  })
  it('rejects NULL, invalid, stale, and competing recovery identities without freeing work', async () => {
    const capture = await capturePasswordEvaluation(email, false)
    if (!capture) throw new Error('expected public reservation')
    const lease = await acquirePasswordWork()
    if (!lease) throw new Error('expected durable work owner')
    expect(await markPasswordEvaluationRunning(capture, lease)).toBe(true)
    await releasePasswordWork(lease)
    const current = await row()
    const reconcileAs = (
      disposition: unknown,
      overrides: Partial<{
        revision: string
        operation: string
        epoch: string
        ownerInstance: string
        ownerHost: string
        ownerPid: number
      }> = {}
    ) =>
      holder.pool.query(
        `SELECT * FROM password_reconcile_running_admission($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          capture.key,
          capture.instance,
          overrides.revision ?? String(current.revision),
          overrides.operation ?? capture.operation,
          overrides.epoch ?? String(current.provisional_epoch),
          overrides.ownerInstance ?? current.provisional_owner_instance,
          overrides.ownerHost ?? current.provisional_owner_host,
          overrides.ownerPid ?? Number(current.provisional_owner_pid),
          disposition,
        ]
      )

    await expect(reconcileAs(null)).rejects.toMatchObject({ code: '22023' })
    await expect(reconcileAs('invalid')).rejects.toMatchObject({
      code: '22023',
    })
    await expect(
      reconcileAs('prestart', {
        revision: String(Number(current.revision) + 1),
      })
    ).rejects.toMatchObject({ code: '55000' })
    await expect(reconcileAs('prestart', { operation: randomUUID() })).rejects.toMatchObject({
      code: '55000',
    })
    await expect(
      reconcileAs('prestart', {
        ownerPid: Number(current.provisional_owner_pid) + 1,
      })
    ).rejects.toMatchObject({ code: '55000' })
    await expect(capturePasswordEvaluation(email, false)).rejects.toMatchObject({ status: 429 })
    expect(await row()).toMatchObject({
      failures: [],
      successes: [],
      uncertain: [],
      provisional_operation: capture.operation,
      provisional_phase: 'running',
      terminal_operation: null,
    })

    const client = await holder.pool.connect()
    let competingRecovery: Promise<{ rows: unknown[] }> | undefined
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL synchronous_commit = 'off'")
      const first = await client.query(
        `SELECT * FROM password_reconcile_running_admission($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          capture.key,
          capture.instance,
          current.revision,
          capture.operation,
          current.provisional_epoch,
          current.provisional_owner_instance,
          current.provisional_owner_host,
          current.provisional_owner_pid,
          'failure',
        ]
      )
      expect(first.rows).toEqual([{ reconciliation: 'failure', operation_id: capture.operation }])
      expect(
        (await client.query("SELECT current_setting('synchronous_commit') AS mode")).rows[0]
      ).toEqual({ mode: 'on' })
      competingRecovery = holder.pool.query(
        `SELECT * FROM password_reconcile_running_admission($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          capture.key,
          capture.instance,
          current.revision,
          capture.operation,
          current.provisional_epoch,
          current.provisional_owner_instance,
          current.provisional_owner_host,
          current.provisional_owner_pid,
          'success',
        ]
      ) as Promise<{ rows: unknown[] }>
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    if (!competingRecovery) throw new Error('expected competing recovery query')
    expect((await competingRecovery).rows).toEqual([
      { reconciliation: 'already_terminal', operation_id: capture.operation },
    ])
    expect(await row()).toMatchObject({
      failures: expect.any(Array),
      successes: [],
      uncertain: [],
      provisional_operation: null,
      terminal_operation: capture.operation,
      terminal_disposition: 'failure',
    })
    expect((await row()).failures).toHaveLength(1)
  })
  it('recovery of a confirmed fifth failure starts the fixed cooldown once', async () => {
    await completedFailures(4)
    const capture = await capturePasswordEvaluation(email, false)
    if (!capture) throw new Error('expected public reservation')
    const lease = await acquirePasswordWork()
    if (!lease) throw new Error('expected durable work owner')
    expect(await markPasswordEvaluationRunning(capture, lease)).toBe(true)
    await releasePasswordWork(lease)
    const before = await now()
    expect((await reconcileRunningOperation(capture, 'failure')).rows).toEqual([
      { reconciliation: 'failure', operation_id: capture.operation },
    ])
    const after = await now()
    const state = await row()
    expect(state.failures).toHaveLength(5)
    expect(Number(state.locked_until_ms)).toBeGreaterThanOrEqual(before + policy.cooldownMs)
    expect(Number(state.locked_until_ms)).toBeLessThanOrEqual(after + policy.cooldownMs)
  })
  it('charges no password outcome after an exactly proven pre-start cancellation', async () => {
    const capture = await capturePasswordEvaluation(email, false)
    if (!capture) throw new Error('expected public reservation')
    const lease = await acquirePasswordWork()
    if (!lease) throw new Error('expected durable work owner')
    expect(await markPasswordEvaluationRunning(capture, lease)).toBe(true)
    await releasePasswordWork(lease)
    expect((await reconcileRunningOperation(capture, 'prestart')).rows).toEqual([
      { reconciliation: 'cancelled', operation_id: capture.operation },
    ])
    expect(await row()).toMatchObject({
      failures: [],
      successes: [],
      uncertain: [],
      provisional_operation: null,
      terminal_disposition: 'cancelled',
    })
  })
  it('recovers quota-masked uncertainty without charging public success history', async () => {
    const key = passwordIdentifierKey(email)
    const nowMs = await now()
    await holder.pool.query(
      'INSERT INTO password_identifier_state(identifier_key) VALUES ($1) ON CONFLICT DO NOTHING',
      [key]
    )
    await holder.pool.query(
      'UPDATE password_identifier_state SET successes=$2 WHERE identifier_key=$1',
      [key, Array.from({ length: 40 }, (_, index) => nowMs - 100 - index)]
    )
    const capture = await capturePasswordEvaluation(email, false)
    if (!capture) throw new Error('expected quota-masked reservation')
    expect(capture.quotaMasked).toBe(true)
    const lease = await acquirePasswordWork()
    if (!lease) throw new Error('expected durable work owner')
    expect(await markPasswordEvaluationRunning(capture, lease)).toBe(true)
    await releasePasswordWork(lease)
    await reconcileRunningOperation(capture, 'uncertain')
    expect(await row()).toMatchObject({
      successes: expect.any(Array),
      failures: [],
      uncertain: expect.any(Array),
      provisional_operation: null,
      terminal_disposition: 'uncertain',
    })
    expect((await row()).successes).toHaveLength(40)
    expect((await row()).uncertain).toHaveLength(1)
  })
  it('discards a running operation made stale by the real password-change producer', async () => {
    const capture = await capturePasswordEvaluation(email, false)
    if (!capture) throw new Error('expected public reservation')
    const lease = await acquirePasswordWork()
    if (!lease) throw new Error('expected durable work owner')
    expect(await markPasswordEvaluationRunning(capture, lease)).toBe(true)
    await releasePasswordWork(lease)
    await updateUserPassword(userId, email, password, 'Synthetic-recovery-fence-password')
    expect((await reconcileRunningOperation(capture, 'uncertain')).rows).toEqual([
      { reconciliation: 'stale', operation_id: capture.operation },
    ])
    expect(await row()).toMatchObject({
      failures: [],
      successes: [],
      uncertain: [],
      provisional_operation: null,
      terminal_disposition: 'stale',
    })
  })
  it('upgrades the actual pre-0130 schema and conservatively holds live legacy attempts', async () => {
    const upgradeDatabase = `password_upgrade_${randomBytes(6).toString('hex')}`
    await admin.query(`CREATE DATABASE "${upgradeDatabase}"`)
    const upgradeUrl = new URL(adminUrl!)
    upgradeUrl.pathname = `/${upgradeDatabase}`
    const upgradePool = new Pool({ connectionString: upgradeUrl.toString() })
    try {
      const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
      await upgradePool.query(`CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
      await upgradePool.query('BEGIN')
      await upgradePool.query('SET LOCAL synchronous_commit = on')
      try {
        for (const migration of CONTROL_API_MIGRATIONS) {
          if (migration.version === '0130_password_login_success_admission') break
          await migration.apply(upgradePool)
          await upgradePool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
            migration.version,
          ])
        }
        await upgradePool.query('COMMIT')
      } catch (error) {
        await upgradePool.query('ROLLBACK')
        throw error
      }

      const nowMs = Number(
        (
          await upgradePool.query(
            'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS ms'
          )
        ).rows[0].ms
      )
      const legacyKey = passwordIdentifierKey('pre-upgrade@example.invalid')
      const newestLegacyAttempt = nowMs - 1_000
      await upgradePool.query(
        'INSERT INTO password_identifier_state(identifier_key,attempts) VALUES ($1,$2)',
        [legacyKey, [nowMs - policy.windowMs - 1, newestLegacyAttempt]]
      )
      await upgradePool.query(
        "DELETE FROM schema_migrations WHERE version='0130_password_login_success_admission'"
      )

      // Re-enter the actual migration runner against the actual predecessor schema.
      await initDb(upgradePool)
      const legacy = (
        await upgradePool.query(
          `SELECT attempts,failures,successes,uncertain,legacy_hold_until_ms
             FROM password_identifier_state WHERE identifier_key=$1`,
          [legacyKey]
        )
      ).rows[0]
      expect(legacy).toMatchObject({
        attempts: [String(nowMs - policy.windowMs - 1), String(newestLegacyAttempt)],
        failures: [],
        successes: [],
        uncertain: [],
      })
      const fenceAt = Number(
        (
          await upgradePool.query(
            'SELECT fenced_at_ms::text FROM password_admission_rollout_state WHERE singleton'
          )
        ).rows[0].fenced_at_ms
      )
      expect(Number(legacy.legacy_hold_until_ms)).toBeGreaterThanOrEqual(
        newestLegacyAttempt + policy.windowMs
      )
      expect(Number(legacy.legacy_hold_until_ms)).toBeGreaterThanOrEqual(fenceAt + policy.windowMs)
      expect(
        (
          await upgradePool.query(
            "SELECT version FROM schema_migrations WHERE version='0130_password_login_success_admission'"
          )
        ).rows
      ).toHaveLength(1)
      await initDb(upgradePool)
    } finally {
      await endPoolAndWaitForClients(upgradePool)
      await admin.query(`DROP DATABASE IF EXISTS "${upgradeDatabase}"`)
    }
  })
  it('serializes one provisional identifier operation and rejects all competitors', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => capturePasswordEvaluation(email, true))
    )
    const admitted = results.filter(
      (
        result
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof capturePasswordEvaluation>>> =>
        result.status === 'fulfilled'
    )
    expect(admitted).toHaveLength(1)
    expect(admitted[0].value).not.toBeNull()
    expect((await row()).attempts).toHaveLength(0)
    expect((await row()).provisional_phase).toBe('reserved')
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(11)
    const capture = admitted[0].value!
    expect(await cancelUnstartedPasswordEvaluation(capture)).toBe(true)
    expect((await row()).provisional_operation).toBeNull()
  })
  it('fifth failure sets one cooldown from DB completion time without extension', async () => {
    await completedFailures(4)
    const before = await now()
    const c = await capturePasswordEvaluation(email, false)
    await finishCapture(c, false)
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
  it('five completed failures exhaust risk until expiry without denied-request extension', async () => {
    await completedFailures()
    const state = await row()
    await expect(capturePasswordEvaluation(email, true)).rejects.toMatchObject({ status: 429 })
    expect(await row()).toEqual(state)
    const t = await now()
    await holder.pool.query(
      'UPDATE password_identifier_state SET failures=$2,locked_until_ms=0 WHERE identifier_key=$1',
      [passwordIdentifierKey(email), [t - policy.windowMs - 1]]
    )
    await expect(capturePasswordEvaluation(email, true)).resolves.toBeDefined()
    expect((await row()).failures).toHaveLength(0)
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
  it('successful authentication/reverification preserves earlier failures', async () => {
    const failed = await capturePasswordEvaluation(email, true)
    await finishCapture(failed, false)
    expect(
      await verifyMemberPassword(email, password, {
        publicLogin: false,
        userId,
      })
    ).toMatchObject({ id: userId })
    const state = await row()
    expect(state.failures).toHaveLength(1)
    expect(state.locked_until_ms).toBe('0')
    expect(state.successes).toHaveLength(0)
  })
  it('serializes same-identity completion and terminal receipts prevent duplicate success', async () => {
    const first = await capturePasswordEvaluation(email, true)
    await expect(capturePasswordEvaluation(email, true)).rejects.toMatchObject({ status: 429 })
    if (!first) throw new Error('expected capture')
    const lease = await acquirePasswordWork()
    if (!lease) throw new Error('expected password work owner')
    expect(await markPasswordEvaluationRunning(first, lease)).toBe(true)
    await releasePasswordWork(lease)
    expect(await completePasswordEvaluation(first, true, lease)).toBe(true)
    expect(await completePasswordEvaluation(first, true, lease)).toBe(false)
    expect((await row()).successes).toHaveLength(1)
  })
  it('real password-change producer fences stale failure and success results', async () => {
    const stale = await capturePasswordEvaluation(email, false)
    const before = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation
    expect(
      await updateUserPassword(userId, email, password, 'Synthetic-BUG192-new-password')
    ).toEqual({ updated: true })
    const after = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation
    expect(Number(after)).toBe(Number(before) + 1)
    if (!stale) throw new Error('expected capture')
    const lease = await acquirePasswordWork()
    if (!lease) throw new Error('expected password work owner')
    expect(await markPasswordEvaluationRunning(stale, lease)).toBe(false)
    await releasePasswordWork(lease)
    expect((await row()).failures).toEqual([])
    expect((await row()).provisional_operation).toBeNull()
  })
  it('serializes authenticated password change and recovery through one durable owner', async () => {
    const invitation = await createSilentPasswordResetInvitation({
      inviteeName: 'Synthetic member',
      email,
    })
    let resolveCompareEntered!: () => void
    let releaseCompare!: () => void
    const compareEntered = new Promise<void>(resolve => {
      resolveCompareEntered = resolve
    })
    const continueCompare = new Promise<void>(resolve => {
      releaseCompare = resolve
    })
    const originalCompare = bcrypt.compare.bind(bcrypt)
    let paused = false
    vi.spyOn(bcrypt, 'compare').mockImplementation(async (candidate, encoded) => {
      const matches = await originalCompare(candidate, encoded)
      if (!paused) {
        paused = true
        resolveCompareEntered()
        await continueCompare
      }
      return matches
    })

    const stalePasswordChange = updateUserPassword(
      userId,
      email,
      password,
      'Synthetic-BUG192-stale-password-change'
    )
    const recoveryPassword = 'Synthetic-BUG192-recovered-password'
    try {
      await compareEntered
      await expect(
        setInvitationPasswordForEmail(email, invitation.id, recoveryPassword)
      ).rejects.toMatchObject({ status: 429, reason: 'verification_busy' })
    } finally {
      releaseCompare()
    }
    await expect(stalePasswordChange).resolves.toEqual({ updated: true })
    const recovery = await setInvitationPasswordForEmail(email, invitation.id, recoveryPassword)
    expect(recovery).not.toHaveProperty('error')
    await expect(
      verifyMemberPassword(email, recoveryPassword, {
        publicLogin: false,
        userId,
      })
    ).resolves.toMatchObject({ id: userId })
    const finalHash = (
      await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])
    ).rows[0].password_hash
    await expect(bcrypt.compare('Synthetic-BUG192-stale-password-change', finalHash)).resolves.toBe(
      false
    )
  })
  it('real reset/establishment producer clears cooldown and fences old work', async () => {
    await completedFailures(4)
    const stale = await capturePasswordEvaluation(email, false)
    // Database producer for a pending reset; the real reset function owns the
    // credential write/acceptance and its generation trigger in one transaction.
    const invitation = (
      await holder.pool.query(
        "INSERT INTO invitations(email,role,purpose,status) VALUES ($1,'member','password_reset','pending') RETURNING id",
        [email]
      )
    ).rows[0]
    const before = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation
    const result = await setInvitationPasswordForEmail(
      email,
      invitation.id,
      'Synthetic-BUG192-reset-password'
    )
    expect(result).not.toHaveProperty('error')
    const after = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation
    expect(Number(after)).toBe(Number(before) + 1)
    if (!stale) throw new Error('expected capture')
    const lease = await acquirePasswordWork()
    if (!lease) throw new Error('expected password work owner')
    expect(await markPasswordEvaluationRunning(stale, lease)).toBe(false)
    await releasePasswordWork(lease)
    expect(await row()).toMatchObject({ failures: [], locked_until_ms: '0' })
    const credential = (
      await holder.pool.query('SELECT password_hash FROM users WHERE id=$1', [userId])
    ).rows[0]
    expect(bcrypt.getRounds(credential.password_hash)).toBe(12)
  })
  it('completes authenticated reset with a one-connection PostgreSQL pool', async () => {
    const invitation = await createSilentPasswordResetInvitation({
      inviteeName: 'Synthetic member',
      email,
    })
    const previousPool = holder.pool
    const singleConnectionPool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 2500,
    })
    holder.pool = singleConnectionPool
    try {
      const result = await setInvitationPasswordForUser(
        userId,
        email,
        invitation.id,
        'Synthetic-BUG192-single-pool-reset'
      )
      expect(result).not.toHaveProperty('error')
      const after = (
        await singleConnectionPool.query(
          'SELECT password_hash, password_auth_generation FROM users WHERE id = $1',
          [userId]
        )
      ).rows[0]
      expect(after.password_hash).not.toBe(hash)
      expect(Number(after.password_auth_generation)).toBeGreaterThan(1)
      expect(
        (
          await singleConnectionPool.query('SELECT status FROM invitations WHERE id = $1', [
            invitation.id,
          ])
        ).rows[0].status
      ).toBe('accepted')
    } finally {
      holder.pool = previousPool
      await endPoolAndWaitForClients(singleConnectionPool)
    }
  })
  it('advances password generation once for both existing-user admin seed producers', async () => {
    const { provisionAdminDesktopWorkspace, provisionMemberFromAdmin } =
      await import('../src/services/directory/adminProvisioning.js')
    const firstSeedHash = await bcrypt.hash('Synthetic-BUG192-admin-seed-one', 12)
    const secondSeedHash = await bcrypt.hash('Synthetic-BUG192-admin-seed-two', 12)
    const before = (
      await holder.pool.query(
        'SELECT password_auth_generation, lifecycle_version FROM users WHERE id = $1',
        [userId]
      )
    ).rows[0]
    const adminId = (
      await holder.pool.query(
        `INSERT INTO control_admin_users(username, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [`seed-admin-${randomBytes(4).toString('hex')}`, email, secondSeedHash]
      )
    ).rows[0].id as string

    await provisionAdminDesktopWorkspace({
      controlAdminId: adminId,
      email,
      displayName: 'Synthetic member',
      passwordHash: firstSeedHash,
      agentNames: [],
      contextIds: [],
      linkDesktopOperator: false,
    })
    const afterWorkspaceSeed = (
      await holder.pool.query(
        'SELECT password_auth_generation, lifecycle_version FROM users WHERE id = $1',
        [userId]
      )
    ).rows[0]
    expect(Number(afterWorkspaceSeed.password_auth_generation)).toBe(
      Number(before.password_auth_generation) + 1
    )
    expect(Number(afterWorkspaceSeed.lifecycle_version)).toBe(Number(before.lifecycle_version) + 1)

    await provisionMemberFromAdmin({
      adminId,
      operatorSub: adminId,
      teamAssignments: [],
      seedPassword: true,
    })
    const afterMemberSeed = (
      await holder.pool.query(
        'SELECT password_auth_generation, lifecycle_version FROM users WHERE id = $1',
        [userId]
      )
    ).rows[0]
    expect(Number(afterMemberSeed.password_auth_generation)).toBe(
      Number(afterWorkspaceSeed.password_auth_generation) + 1
    )
    expect(Number(afterMemberSeed.lifecycle_version)).toBe(
      Number(afterWorkspaceSeed.lifecycle_version) + 1
    )
  })
  it('fails closed when session revocation sees a different password lifecycle generation', async () => {
    const { revokeAllUserSessions } = await import('../src/services/auth/userSessionService.js')
    const before = (
      await holder.pool.query('SELECT lifecycle_version FROM users WHERE id = $1', [userId])
    ).rows[0].lifecycle_version
    const staleVersion = (BigInt(String(before)) - 1n).toString()

    await expect(
      revokeAllUserSessions(userId, 'password_changed', undefined, undefined, staleVersion)
    ).rejects.toThrow('password transition lifecycle generation changed before session revocation')

    const after = (
      await holder.pool.query('SELECT lifecycle_version FROM users WHERE id = $1', [userId])
    ).rows[0].lifecycle_version
    const epochs = await holder.pool.query(
      'SELECT count(*)::int AS count FROM external_user_session_security_epochs WHERE user_id = $1',
      [userId]
    )
    expect(String(after)).toBe(String(before))
    expect(epochs.rows[0].count).toBe(0)
  })
  it('does not hash accepted invitation passwords outside the durable owner', async () => {
    const invitation = await createSilentInvitationForTeams({
      inviteeName: 'Synthetic member',
      email,
      purpose: 'member_invitation',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    const accepted = await acceptInvitationForEmail(email, invitation.token, invitation.id)
    expect(accepted).toMatchObject({ data: { accepted: true, userId } })

    const lease = await acquirePasswordWork()
    expect(lease).not.toBeNull()
    const hashSpy = vi.spyOn(bcrypt, 'hash')
    try {
      await expect(
        setInvitationPasswordForUser(
          userId,
          email,
          invitation.id,
          'Synthetic-BUG192-invitation-password'
        )
      ).rejects.toMatchObject({ status: 429, reason: 'verification_busy' })
      expect(hashSpy).not.toHaveBeenCalled()
      const current = (
        await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])
      ).rows[0].password_hash
      expect(current).toBe(hash)
    } finally {
      hashSpy.mockRestore()
      await lease?.release()
    }
  })
  it('reuses a reserved owner to complete accepted invitation password setup', async () => {
    const invitation = await createSilentInvitationForTeams({
      inviteeName: 'Synthetic member',
      email,
      purpose: 'member_invitation',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    const accepted = await acceptInvitationForEmail(email, invitation.token, invitation.id)
    expect(accepted).toMatchObject({ data: { accepted: true, userId } })
    const before = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation

    const result = await withMemberPasswordWorkLease(lease =>
      setInvitationPasswordForUser(
        userId,
        email,
        invitation.id,
        'Synthetic-BUG192-reserved-invitation-password',
        lease
      )
    )

    expect(result).not.toHaveProperty('error')
    const after = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation
    expect(Number(after)).toBe(Number(before) + 1)
    expect(
      (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
        .password_hash
    ).not.toBe(hash)
    expect(
      (await holder.pool.query('SELECT count(*)::text AS count FROM password_verification_work'))
        .rows[0].count
    ).toBe('0')
  })
  it('does not accept a pending password-reset link through generic invitation acceptance', async () => {
    const invitation = await createSilentPasswordResetInvitation({
      inviteeName: 'Synthetic member',
      email,
    })

    await expect(acceptInvitationForEmail(email, '', invitation.id)).resolves.toEqual({
      error: 'not_pending',
    })
    expect(
      (await holder.pool.query('SELECT status FROM invitations WHERE id = $1', [invitation.id]))
        .rows[0].status
    ).toBe('pending')
    expect(
      (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
        .password_hash
    ).toBe(hash)
  })
  it('revokes every other pending password-reset link for the same account only', async () => {
    const makeReset = (address: string) =>
      createSilentPasswordResetInvitation({
        inviteeName: 'Synthetic member',
        email: address,
      })
    const redeemed = await makeReset(email)
    const sibling = await makeReset(email)
    await expect(getInvitationByToken(redeemed.token)).resolves.toMatchObject({
      id: redeemed.id,
      purpose: 'password_reset',
      status: 'pending',
    })
    const otherEmail = 'other-member@example.invalid'
    await holder.pool.query('INSERT INTO users(email) VALUES ($1)', [otherEmail])
    const otherMember = await makeReset(otherEmail)
    const before = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation

    const result = await setInvitationPasswordForEmail(
      email,
      redeemed.id,
      'Synthetic-BUG192-recovered-password'
    )

    expect(result).not.toHaveProperty('error')
    const rows = (
      await holder.pool.query(
        'SELECT id, email, purpose, status FROM invitations WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[redeemed.id, sibling.id, otherMember.id]]
      )
    ).rows
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: redeemed.id,
          email,
          purpose: 'password_reset',
          status: 'accepted',
        }),
        expect.objectContaining({
          id: sibling.id,
          email,
          purpose: 'password_reset',
          status: 'revoked',
        }),
        expect.objectContaining({
          id: otherMember.id,
          email: otherEmail,
          purpose: 'password_reset',
          status: 'pending',
        }),
      ])
    )
    const after = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation
    expect(Number(after)).toBe(Number(before) + 1)
    const replayHash = vi.spyOn(bcrypt, 'hash')
    await expect(
      setInvitationPasswordForEmail(email, redeemed.id, 'Synthetic-BUG192-used-link-replay')
    ).resolves.toMatchObject({ error: 'not_pending' })
    await expect(
      setInvitationPasswordForEmail(email, sibling.id, 'Synthetic-BUG192-replay-password')
    ).resolves.toMatchObject({ error: 'not_pending' })
    expect(replayHash).not.toHaveBeenCalled()
    expect(
      Number(
        (
          await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [
            userId,
          ])
        ).rows[0].password_auth_generation
      )
    ).toBe(Number(after))
  })

  it('maps the email producer token to its distinct recovery row ID', async () => {
    const invitation = await createPasswordResetInvitation({
      inviteeName: 'Synthetic member',
      email,
    })
    expect(invitationFlow.registerAndSendInvitation).toHaveBeenCalledWith(
      email,
      invitation.token,
      null,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ purpose: 'password_reset' })
    )
    expect(invitation.token).toBeTruthy()
    expect(invitation.token).not.toBe(invitation.id)

    const preview = await getInvitationByToken(invitation.token)
    expect(preview).toMatchObject({
      id: invitation.id,
      email,
      purpose: 'password_reset',
      status: 'pending',
    })

    const result = await setInvitationPasswordForEmail(
      email,
      preview!.id,
      'Synthetic-BUG192-token-mapped-recovery'
    )
    expect(result).not.toHaveProperty('error')
    expect(
      (await holder.pool.query('SELECT status FROM invitations WHERE id = $1', [invitation.id]))
        .rows[0].status
    ).toBe('accepted')
  })

  it('allows at most one credential mutation when sibling reset links race', async () => {
    const makeReset = () =>
      createSilentPasswordResetInvitation({
        inviteeName: 'Synthetic member',
        email,
      })
    const first = await makeReset()
    const second = await makeReset()
    const hash = vi.spyOn(bcrypt, 'hash')
    const before = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation

    const outcomes = await Promise.allSettled([
      setInvitationPasswordForEmail(email, first.id, 'Synthetic-BUG192-race-password-a'),
      setInvitationPasswordForEmail(email, second.id, 'Synthetic-BUG192-race-password-b'),
    ])

    expect(
      outcomes.filter(result => result.status === 'fulfilled' && !('error' in result.value))
    ).toHaveLength(1)
    expect(hash).toHaveBeenCalledTimes(1)
    const after = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation
    expect(Number(after)).toBe(Number(before) + 1)
    expect(
      (
        await holder.pool.query('SELECT status FROM invitations WHERE id = ANY($1::uuid[])', [
          [first.id, second.id],
        ])
      ).rows
        .map(row => row.status)
        .sort()
    ).toEqual(['accepted', 'revoked'])
    const redeemedId = (
      await holder.pool.query(
        "SELECT id FROM invitations WHERE id = ANY($1::uuid[]) AND status = 'accepted'",
        [[first.id, second.id]]
      )
    ).rows[0].id
    const siblingId = redeemedId === first.id ? second.id : first.id
    await expect(
      setInvitationPasswordForEmail(email, siblingId, 'Synthetic-BUG192-race-replay')
    ).resolves.toMatchObject({ error: 'not_pending' })
  })
  it('rejects expired, revoked, wrong-purpose and wrong-account recovery credentials', async () => {
    const makeInvitation = (purpose: 'password_reset' | 'member_invitation') =>
      purpose === 'password_reset'
        ? createSilentPasswordResetInvitation({
            inviteeName: 'Synthetic member',
            email,
          })
        : createSilentInvitationForTeams({
            inviteeName: 'Synthetic member',
            email,
            purpose,
            teamAssignments: [],
            fallbackRole: 'member',
          })
    const expired = await makeInvitation('password_reset')
    const revoked = await makeInvitation('password_reset')
    const wrongAccount = await makeInvitation('password_reset')
    const memberInvite = await makeInvitation('member_invitation')
    await holder.pool.query(
      "UPDATE invitations SET expires_at = NOW() - interval '1 second' WHERE id = $1",
      [expired.id]
    )
    await holder.pool.query("UPDATE invitations SET status = 'revoked' WHERE id = $1", [revoked.id])

    await expect(
      setInvitationPasswordForEmail(email, expired.id, 'Synthetic-BUG192-expired-reset')
    ).resolves.toMatchObject({ error: 'expired' })
    await expect(
      setInvitationPasswordForEmail(email, revoked.id, 'Synthetic-BUG192-revoked-reset')
    ).resolves.toMatchObject({ error: 'not_pending' })
    await expect(
      setInvitationPasswordForEmail(
        'other@example.invalid',
        wrongAccount.id,
        'Synthetic-BUG192-wrong-account'
      )
    ).resolves.toMatchObject({ error: 'forbidden' })
    await expect(
      setInvitationPasswordForEmail(email, memberInvite.id, 'Synthetic-BUG192-wrong-purpose')
    ).resolves.toMatchObject({ error: 'not_found' })
    expect(
      (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
        .password_hash
    ).toBe(hash)
  })
  it('fails recovery closed when durable password work authority is unavailable', async () => {
    const invitation = await createSilentPasswordResetInvitation({
      inviteeName: 'Synthetic member',
      email,
    })
    await holder.pool.query(
      'ALTER TABLE password_verification_work RENAME TO password_verification_work_unavailable'
    )
    try {
      await expect(
        setInvitationPasswordForEmail(email, invitation.id, 'Synthetic-BUG192-no-authority')
      ).rejects.toMatchObject({ status: 503 })
      expect(
        (await holder.pool.query('SELECT status FROM invitations WHERE id = $1', [invitation.id]))
          .rows[0].status
      ).toBe('pending')
      expect(
        (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
          .password_hash
      ).toBe(hash)
    } finally {
      await holder.pool.query(
        'ALTER TABLE password_verification_work_unavailable RENAME TO password_verification_work'
      )
    }
  })
  it('bounds recovery hashing with the shared owner and does not hash while it is busy', async () => {
    const invitation = await createSilentPasswordResetInvitation({
      inviteeName: 'Synthetic member',
      email,
    })
    const lease = await acquirePasswordWork()
    expect(lease).not.toBeNull()
    const hashSpy = vi.spyOn(bcrypt, 'hash')
    try {
      await expect(
        setInvitationPasswordForEmail(email, invitation.id, 'Synthetic-BUG192-owner-busy')
      ).rejects.toMatchObject({ status: 429, reason: 'verification_busy' })
      expect(hashSpy).not.toHaveBeenCalled()
      expect(
        (await holder.pool.query('SELECT status FROM invitations WHERE id = $1', [invitation.id]))
          .rows[0].status
      ).toBe('pending')
      expect(
        (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
          .password_hash
      ).toBe(hash)
    } finally {
      hashSpy.mockRestore()
      await lease?.release()
    }
  })
  it('provisioning and lifecycle changes fence stale completions at the database boundary', async () => {
    for (const update of ['password_hash = NULL', 'lifecycle_version = lifecycle_version + 1']) {
      const stale = await capturePasswordEvaluation(email, false)
      await holder.pool.query(`UPDATE users SET ${update} WHERE id=$1`, [userId])
      expect(await finishCapture(stale, false)).toBe(false)
    }
  })
  it('new identity creation fences an old shadow evaluation', async () => {
    const stale = await capturePasswordEvaluation('new@example.invalid', false)
    await holder.pool.query(
      "INSERT INTO users(email,password_hash) VALUES ('new@example.invalid',$1)",
      [hash]
    )
    expect(await finishCapture(stale, false)).toBe(false)
  })
  it('two aggregate reservations cannot both win, and denials do not advance pace', async () => {
    const results = await Promise.allSettled([reservePasswordPace(), reservePasswordPace()])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const before = (await holder.pool.query('SELECT * FROM password_verification_pace')).rows
    await expect(reservePasswordPace()).rejects.toMatchObject({
      status: 429,
    })
    expect((await holder.pool.query('SELECT * FROM password_verification_pace')).rows).toEqual(
      before
    )
    await holder.pool.query(
      "UPDATE password_verification_pace SET next_permit=clock_timestamp()-interval '1 minute'"
    )
    await reservePasswordPace()
    await expect(reservePasswordPace()).rejects.toMatchObject({
      status: 429,
    })
  })
  it('fails closed when a global denial cannot cancel its exact provisional operation', async () => {
    const replacementOperation = randomUUID()
    await holder.pool.query(
      `INSERT INTO password_verification_pace(singleton,next_permit)
       VALUES (TRUE,clock_timestamp()+interval '1 minute')`
    )
    let replaced = false
    const query = holder.pool.query.bind(holder.pool)
    const querySpy = vi.spyOn(holder.pool, 'query')
    querySpy.mockImplementation((async (...args: unknown[]) => {
      const result = await (
        query as (...queryArgs: unknown[]) => Promise<{
          rows: Array<Record<string, unknown>>
        }>
      )(...args)
      const statement =
        typeof args[0] === 'string'
          ? args[0]
          : String((args[0] as { text?: string } | undefined)?.text ?? '')
      if (!replaced && statement.includes('SELECT greatest(1, ceil')) {
        replaced = true
        const active = await query(
          'SELECT provisional_operation FROM password_identifier_state WHERE identifier_key=$1',
          [passwordIdentifierKey(email)]
        )
        expect(active.rows).toHaveLength(1)
        const originalOperation = active.rows[0].provisional_operation
        await query('BEGIN')
        await query("SET LOCAL app.password_admission_protocol = 'v2'")
        await query(
          `UPDATE password_identifier_state SET provisional_operation=$2
              WHERE identifier_key=$1 AND provisional_operation=$3`,
          [passwordIdentifierKey(email), replacementOperation, originalOperation]
        )
        await query('COMMIT')
      }
      return result as never
    }) as typeof holder.pool.query)
    const compare = vi.spyOn(bcrypt, 'compare')
    try {
      await expect(
        verifyMemberPassword(email, password, { publicLogin: true })
      ).rejects.toMatchObject({ status: 503 })
      expect(compare).not.toHaveBeenCalled()
      expect(replaced).toBe(true)
      expect((await row()).provisional_operation).toBe(replacementOperation)
    } finally {
      querySpy.mockRestore()
      compare.mockRestore()
    }
  })
  it('persisted aggregate pacing works across independent Node processes', async () => {
    // The required hosted PostgreSQL lane runs source tests without building Control API.
    // Reuse its declared ts-node resolver so both processes execute the real producer.
    const script = `require('ts-node').register({project:'./tsconfig.json',experimentalResolver:true,transpileOnly:true});const {reservePasswordPace}=require('./src/services/auth/passwordCredentialVerification.ts');reservePasswordPace().then(()=>{console.log('ALLOWED');process.exit(0)},e=>{console.log('DENIED:'+e.status);process.exit(e.status===429?0:1)})`
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CONTROL_API_PG_CONNECTION_STRING: connectionString,
          },
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
  it('serializes an identifier reservation across independent Node processes', async () => {
    const script = `require('ts-node').register({project:'./tsconfig.json',experimentalResolver:true,transpileOnly:true});const {capturePasswordEvaluation}=require('./src/services/auth/passwordCredentialVerification.ts');capturePasswordEvaluation(process.argv[1],{scope:'public_login'}).then(c=>{console.log(JSON.stringify({operation:c.operation}));process.stdin.resume();process.stdin.once('data',()=>process.exit(0))},e=>{console.error('capture failed:'+e.status);process.exit(1)})`
    const child = spawn(process.execPath, ['-e', script, email], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONTROL_API_PG_CONNECTION_STRING: connectionString,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let errorOutput = ''
    let readyResolve!: (value: { operation: string }) => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<{ operation: string }>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    child.stdout.on('data', chunk => {
      output += String(chunk)
      const newline = output.indexOf('\n')
      if (newline >= 0) {
        try {
          readyResolve(JSON.parse(output.slice(0, newline)))
        } catch {
          readyReject(new Error('child emitted an invalid reservation receipt'))
        }
      }
    })
    child.stderr.on('data', chunk => (errorOutput += String(chunk)))
    const startupTimeout = setTimeout(
      () => readyReject(new Error('child capture timed out')),
      10_000
    )
    let childOperation: string
    try {
      childOperation = (await ready).operation
    } catch (error) {
      child.kill('SIGTERM')
      throw new Error(`${String(error)} ${errorOutput}`)
    } finally {
      clearTimeout(startupTimeout)
    }
    try {
      await expect(capturePasswordEvaluation(email, true)).rejects.toMatchObject({ status: 429 })
      expect((await row()).provisional_operation).toBe(childOperation)
    } finally {
      child.stdin.end('release\n')
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error('child process did not stop'))
        }, 10_000)
        child.once('exit', code => {
          clearTimeout(timeout)
          if (code === 0) resolve()
          else reject(new Error(`child exited ${code}: ${errorOutput}`))
        })
      })
    }
    await holder.pool.query(
      `UPDATE password_identifier_state
          SET provisional_expires_at_ms = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 1
        WHERE identifier_key=$1 AND provisional_operation=$2`,
      [passwordIdentifierKey(email), childOperation]
    )
    const recoveredReservation = await capturePasswordEvaluation(email, false)
    expect(recoveredReservation).not.toBeNull()
    expect(await cancelUnstartedPasswordEvaluation(recoveredReservation!)).toBe(true)
  })
  it('does not repeat an ambiguous successful terminal commit after a lost acknowledgement', async () => {
    const capture = await capturePasswordEvaluation(email, true)
    if (!capture) throw new Error('expected public reservation')
    const lease = await acquirePasswordWork()
    if (!lease) throw new Error('expected durable work owner')
    expect(await markPasswordEvaluationRunning(capture, lease)).toBe(true)
    await releasePasswordWork(lease)

    const originalPool = holder.pool
    const blackhole = await createPostgresCommitReplyBlackhole(connectionString)
    const proxyPool = new Pool({
      connectionString: blackhole.connectionString,
      max: 1,
    })
    holder.pool = proxyPool
    let outcome: unknown
    try {
      const completion = completePasswordEvaluation(capture, true, lease)
      await blackhole.commitForwarded
      blackhole.failClientAfterCommitForwarded()
      outcome = await completion.then(
        () => new Error('completion unexpectedly acknowledged a withheld COMMIT reply'),
        error => error
      )
    } finally {
      holder.pool = originalPool
      await endPoolAndWaitForClients(proxyPool)
      await blackhole.close()
    }
    expect(outcome).toBeInstanceOf(Error)
    const committed = await row()
    expect(committed.successes).toHaveLength(1)
    expect(committed.failures).toHaveLength(0)
    expect(committed.provisional_operation).toBeNull()
    expect(committed.terminal_operation).toBe(capture.operation)
    expect(await completePasswordEvaluation(capture, true, lease)).toBe(false)
    expect((await row()).successes).toHaveLength(1)
  })
  it('busy bcrypt is rejected without queue and the reserved pace is not refunded', async () => {
    let started!: () => void, finish!: (value: boolean) => void
    const entered = new Promise<void>(r => (started = r)),
      held = new Promise<boolean>(r => (finish = r))
    const spy = vi.spyOn(bcrypt, 'compare').mockImplementationOnce(async () => {
      started()
      return held
    })
    const first = verifyMemberPassword(email, 'wrong', {
      publicLogin: false,
      userId,
    })
    await entered
    try {
      await holder.pool.query(
        "UPDATE password_verification_pace SET next_permit=clock_timestamp()-interval '1 second'"
      )
      await expect(
        verifyMemberPassword('shadow@example.invalid', 'wrong', {
          publicLogin: true,
        })
      ).rejects.toMatchObject({ status: 429 })
      expect(spy).toHaveBeenCalledTimes(1)
      await expect(reservePasswordPace()).rejects.toMatchObject({
        status: 429,
      })
    } finally {
      finish(false)
      await first
    }
  })
  it('cleanup retains each active component and preserves stale-result fencing after recreation', async () => {
    const t = await now()
    for (const kind of ['attempt', 'failure', 'cooldown']) {
      const identity = `${kind}@example.invalid`
      await holder.pool.query(
        'INSERT INTO password_identifier_state(identifier_key) VALUES ($1) ON CONFLICT DO NOTHING',
        [passwordIdentifierKey(identity)]
      )
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
    await holder.pool.query(
      `UPDATE password_identifier_state
          SET provisional_expires_at_ms = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 1,
              retained_until_ms=0 WHERE identifier_key=$1`,
      [passwordIdentifierKey('expired@example.invalid')]
    )
    const replacement = await capturePasswordEvaluation('expired@example.invalid', false)
    if (!replacement) throw new Error('expected replacement capture')
    expect(await cancelUnstartedPasswordEvaluation(replacement)).toBe(true)
    await holder.pool.query(
      'UPDATE password_identifier_state SET retained_until_ms=0 WHERE identifier_key=$1',
      [passwordIdentifierKey('expired@example.invalid')]
    )
    expect(await cleanupPasswordIdentifierState()).toBe(1)
    expect((await holder.pool.query('SELECT * FROM password_identifier_state')).rows).toHaveLength(
      3
    )
    await capturePasswordEvaluation('expired@example.invalid', false)
    expect(await finishCapture(old, false)).toBe(false)
    expect(
      (await holder.pool.query('SELECT password_auth_generation FROM users WHERE id=$1', [userId]))
        .rows[0]
    ).toHaveProperty('password_auth_generation')
  })
})
