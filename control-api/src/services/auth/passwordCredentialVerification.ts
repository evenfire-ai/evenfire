import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { type DbTransactionClient, pool, withTransaction } from '../../db.js'
import { rootLogger } from '../../observability/logger.js'
import { type PasswordAdmissionDenialReason } from '../../observability/metrics.js'
import { PasswordAdmissionError } from './passwordAdmissionError.js'
import {
  type PasswordIdentifierState,
  type PasswordVerificationScope,
  evaluatePasswordAdmission,
  finishPasswordState,
  passwordIdentifierKey,
  PASSWORD_ADMISSION_POLICY as policy,
  settledPasswordState,
} from './passwordAdmissionState.js'
import {
  type PasswordWorkLease,
  acquirePasswordWork,
  passwordWorkLeaseIdentity,
  passwordWorkReleaseConfirmed,
  releasePasswordWork,
} from './passwordWorkOwnership.js'

// Synthetic, repository-controlled cost-12 hash, precomputed once, never per request.
export const PASSWORD_DUMMY_HASH = '$2b$12$DdpJSFUb/dYx43plh72Ia.k9RJ8krESZ/DtTRUbdQq/ngzfJuyCUu'
const logger = rootLogger.child({ module: 'password-admission' })
const protocolVersion = 'v2'

export { PasswordAdmissionError } from './passwordAdmissionError.js'

function denied(retryMs: number, reason: PasswordAdmissionDenialReason): never {
  throw new PasswordAdmissionError(
    429,
    Math.min(900, Math.max(1, Math.ceil(retryMs / 1000))),
    reason
  )
}

async function useOutcomeAdmissionProtocol(db: Pick<DbTransactionClient, 'query'>): Promise<void> {
  await db.query('SET LOCAL synchronous_commit = on')
  await db.query("SELECT set_config('app.password_admission_protocol', $1, true)", [
    protocolVersion,
  ])
}

export type PasswordUser = {
  id: string
  email: string
  name: string | null
  picture: string | null
  password_hash: string | null
  lifecycle_state: string
  lifecycle_version: string | number
  password_auth_generation: string | number
}

export type PasswordCapture = {
  email: string
  key: string
  instance: string
  revision: string
  operation: string
  expiresAt: number
  scope: PasswordVerificationScope
  quotaMasked: boolean
  reservesPublicSuccess: boolean
  user: PasswordUser | null
}

type StateRow = {
  instance: string
  revision: string
  attempts: string[]
  failures: string[]
  successes: string[]
  uncertain: string[]
  locked_until_ms: string
  legacy_hold_until_ms: string
  provisional_operation: string | null
  provisional_phase: 'reserved' | 'running' | null
  provisional_scope: PasswordVerificationScope | null
  provisional_epoch: string | null
  provisional_expires_at_ms: string | null
  provisional_quota_masked: boolean
  provisional_owner_instance: string | null
  provisional_owner_host: string | null
  provisional_owner_pid: number | null
  terminal_operation: string | null
  terminal_disposition: string | null
}

function bigintArray(values: string[] | undefined): number[] {
  return (values ?? []).map(Number)
}

function stateOf(row: StateRow): PasswordIdentifierState {
  let provisional: PasswordIdentifierState['provisional'] = null
  if (row.provisional_operation) {
    if (
      (row.provisional_phase !== 'reserved' && row.provisional_phase !== 'running') ||
      (row.provisional_scope !== 'public_login' &&
        row.provisional_scope !== 'authenticated_reverification') ||
      row.provisional_epoch === null ||
      row.provisional_expires_at_ms === null
    ) {
      throw new Error('password admission provisional state is malformed')
    }
    const hasOwner =
      row.provisional_owner_instance !== null ||
      row.provisional_owner_host !== null ||
      row.provisional_owner_pid !== null
    if (
      (row.provisional_phase === 'running' &&
        (!row.provisional_owner_instance ||
          !row.provisional_owner_host ||
          !row.provisional_owner_pid ||
          row.provisional_owner_pid <= 0)) ||
      (row.provisional_phase === 'reserved' && hasOwner)
    ) {
      throw new Error('password admission provisional owner is malformed')
    }
    const expiresAt = Number(row.provisional_expires_at_ms)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
      throw new Error('password admission provisional expiry is malformed')
    }
    provisional = {
      operation: row.provisional_operation,
      phase: row.provisional_phase,
      expiresAt,
    }
  } else if (row.provisional_phase !== null || row.provisional_scope !== null) {
    throw new Error('password admission provisional state is malformed')
  }
  return {
    attempts: bigintArray(row.attempts),
    failures: bigintArray(row.failures),
    successes: bigintArray(row.successes),
    uncertain: bigintArray(row.uncertain),
    lockedUntil: Number(row.locked_until_ms),
    legacyHoldUntil: Number(row.legacy_hold_until_ms),
    provisional,
  }
}

async function databaseNow(db: Pick<DbTransactionClient, 'query'>): Promise<number> {
  const result = await db.query(
    'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms'
  )
  return Number((result.rows[0] as { now_ms: string }).now_ms)
}

const clearProvisionalSql = `
  UPDATE password_identifier_state
     SET terminal_operation = provisional_operation,
         terminal_disposition = $3,
         terminal_at_ms = $4,
         terminal_epoch = revision,
         provisional_operation = NULL,
         provisional_phase = NULL,
         provisional_scope = NULL,
         provisional_epoch = NULL,
         provisional_expires_at_ms = NULL,
         provisional_quota_masked = FALSE,
         provisional_started_at_ms = NULL,
         provisional_owner_instance = NULL,
         provisional_owner_host = NULL,
         provisional_owner_pid = NULL,
         provisional_user_id = NULL,
         provisional_generation = NULL
   WHERE identifier_key = $1 AND instance = $2
     AND provisional_operation = $5
`

async function clearProvisional(
  db: Pick<DbTransactionClient, 'query'>,
  capture: PasswordCapture,
  disposition: 'stale' | 'cancelled',
  now: number
): Promise<boolean> {
  const result = await db.query(clearProvisionalSql, [
    capture.key,
    capture.instance,
    disposition,
    now,
    capture.operation,
  ])
  return (result.rowCount ?? 0) === 1
}

export async function capturePasswordEvaluation(
  email: string,
  input: { scope: PasswordVerificationScope; userId?: string } | boolean,
  legacyUserId?: string
): Promise<PasswordCapture | null> {
  // Keep old internal callers source-compatible while their booleans no longer mean an
  // all-attempt charge. Scope remains trusted code, never request data.
  const options =
    typeof input === 'boolean'
      ? {
          scope: legacyUserId
            ? ('authenticated_reverification' as const)
            : ('public_login' as const),
          userId: legacyUserId,
        }
      : input
  const normalized = email.trim().toLowerCase()
  const key = passwordIdentifierKey(normalized)
  if (options.scope === 'authenticated_reverification' && options.userId === undefined) return null

  const reserved = await withTransaction(async db => {
    await useOutcomeAdmissionProtocol(db)
    let principal: PasswordUser | null = null
    if (options.scope === 'authenticated_reverification') {
      const users = await db.query(
        `SELECT id, email, name, picture, password_hash, lifecycle_state,
         lifecycle_version, password_auth_generation FROM users
         WHERE email = $1 AND id::text = $2 FOR SHARE`,
        [normalized, options.userId]
      )
      principal = (users.rows[0] as PasswordUser) ?? null
      if (!principal) return null
    }

    await db.query(
      'INSERT INTO password_identifier_state(identifier_key) VALUES ($1) ON CONFLICT DO NOTHING',
      [key]
    )
    const result = await db.query(
      'SELECT * FROM password_identifier_state WHERE identifier_key = $1 FOR UPDATE',
      [key]
    )
    const row = result.rows[0] as StateRow
    const now = await databaseNow(db)
    const previous = stateOf(row)
    if (previous.provisional?.phase === 'reserved' && previous.provisional.expiresAt <= now) {
      // Reserved work has no right to start bcrypt. Expiry is safe only for this phase.
      await clearProvisional(
        db,
        {
          email: normalized,
          key,
          instance: row.instance,
          revision: String(row.revision),
          operation: previous.provisional.operation,
          expiresAt: previous.provisional.expiresAt,
          scope: row.provisional_scope ?? 'public_login',
          quotaMasked: row.provisional_quota_masked,
          reservesPublicSuccess: row.provisional_scope === 'public_login',
          user: principal,
        },
        'cancelled',
        now
      )
      row.provisional_operation = null
      row.provisional_phase = null
      row.provisional_scope = null
      row.provisional_epoch = null
      row.provisional_expires_at_ms = null
      row.provisional_quota_masked = false
    }

    const decision = evaluatePasswordAdmission(stateOf(row), now, options.scope)
    if (decision.retryMs) {
      return {
        denied: true as const,
        retryMs: decision.retryMs,
        reason: decision.reason ?? 'identifier_attempts',
      }
    }

    const operation = randomUUID()
    const expiresAt = now + policy.evaluationMs
    const state = settledPasswordState(decision.state, now)
    await db.query(
      `UPDATE password_identifier_state
          SET attempts = $2, failures = $3, successes = $4, uncertain = $5,
              locked_until_ms = $6, legacy_hold_until_ms = $7,
              provisional_operation = $8, provisional_phase = 'reserved',
              provisional_scope = $9, provisional_epoch = revision,
              provisional_expires_at_ms = $10,
              provisional_quota_masked = $11,
              provisional_started_at_ms = NULL, provisional_owner_instance = NULL,
              provisional_owner_host = NULL, provisional_owner_pid = NULL,
              provisional_user_id = NULL, provisional_generation = NULL,
              retained_until_ms = greatest(retained_until_ms, $10)
        WHERE identifier_key = $1`,
      [
        key,
        state.attempts,
        state.failures,
        state.successes,
        state.uncertain,
        state.lockedUntil,
        state.legacyHoldUntil,
        operation,
        options.scope,
        expiresAt,
        decision.quotaMasked,
      ]
    )
    return {
      denied: false as const,
      capture: {
        email: normalized,
        key,
        instance: row.instance,
        revision: String(row.revision),
        operation,
        expiresAt,
        scope: options.scope,
        quotaMasked: decision.quotaMasked,
        reservesPublicSuccess: decision.reservesPublicSuccess,
        user: principal,
      } satisfies PasswordCapture,
    }
  })

  if (!reserved) return null
  if (reserved.denied) denied(reserved.retryMs, reserved.reason)
  const capture = reserved.capture
  if (capture.scope === 'authenticated_reverification') return capture
  try {
    const users = await pool.query(
      `SELECT id, email, name, picture, password_hash, lifecycle_state,
       lifecycle_version, password_auth_generation FROM users WHERE email = $1 LIMIT 1`,
      [normalized]
    )
    return { ...capture, user: (users.rows[0] as PasswordUser) ?? null }
  } catch (error) {
    await cancelUnstartedPasswordEvaluation(capture)
    throw error
  }
}

/** One-time CAS from reserved to running, after source/global admission and work ownership. */
export async function markPasswordEvaluationRunning(
  capture: PasswordCapture,
  lease: PasswordWorkLease
): Promise<boolean> {
  const owner = passwordWorkLeaseIdentity(lease)
  if (!owner) return false
  return withTransaction(async db => {
    await useOutcomeAdmissionProtocol(db)
    if (capture.user) {
      const principal = await db.query(
        `SELECT id, email, password_auth_generation FROM users
          WHERE id = $1 AND email = $2 FOR SHARE`,
        [capture.user.id, capture.email]
      )
      const current = principal.rows[0] as
        | {
            id: string
            email: string
            password_auth_generation: string | number
          }
        | undefined
      if (
        !current ||
        String(current.password_auth_generation) !== String(capture.user.password_auth_generation)
      )
        return false
    } else {
      const principal = await db.query('SELECT id FROM users WHERE email = $1 FOR SHARE', [
        capture.email,
      ])
      if (principal.rows.length) return false
    }
    const result = await db.query(
      'SELECT * FROM password_identifier_state WHERE identifier_key = $1 FOR UPDATE',
      [capture.key]
    )
    const row = result.rows[0] as StateRow | undefined
    if (
      !row ||
      row.instance !== capture.instance ||
      row.provisional_operation !== capture.operation ||
      row.provisional_phase !== 'reserved' ||
      row.provisional_scope !== capture.scope ||
      String(row.provisional_epoch) !== capture.revision ||
      String(row.revision) !== capture.revision ||
      row.provisional_quota_masked !== capture.quotaMasked ||
      Number(row.provisional_expires_at_ms) !== capture.expiresAt
    )
      return false
    const now = await databaseNow(db)
    if (now >= capture.expiresAt) {
      await clearProvisional(db, capture, 'cancelled', now)
      return false
    }
    const update = await db.query(
      `UPDATE password_identifier_state
          SET provisional_phase = 'running', provisional_started_at_ms = $4,
              provisional_owner_instance = $5, provisional_owner_host = $6,
              provisional_owner_pid = $7, provisional_user_id = $8,
              provisional_generation = $9
        WHERE identifier_key = $1 AND instance = $2
          AND provisional_operation = $3 AND provisional_phase = 'reserved'
        RETURNING provisional_operation`,
      [
        capture.key,
        capture.instance,
        capture.operation,
        now,
        owner.instance,
        owner.host,
        owner.pid,
        capture.user?.id ?? null,
        capture.user?.password_auth_generation ?? null,
      ]
    )
    return update.rows.length === 1
  })
}

/** Cancel only work which this request can prove never began; a running operation is never TTL-reclaimed. */
export async function cancelUnstartedPasswordEvaluation(
  capture: PasswordCapture,
  options: { knownUnstartedLease?: PasswordWorkLease } = {}
): Promise<boolean> {
  const owner = options.knownUnstartedLease
    ? passwordWorkLeaseIdentity(options.knownUnstartedLease)
    : null
  return withTransaction(async db => {
    await useOutcomeAdmissionProtocol(db)
    const result = await db.query(
      'SELECT * FROM password_identifier_state WHERE identifier_key = $1 FOR UPDATE',
      [capture.key]
    )
    const row = result.rows[0] as StateRow | undefined
    if (
      !row ||
      row.instance !== capture.instance ||
      row.provisional_operation !== capture.operation
    )
      return false
    const reserved = row.provisional_phase === 'reserved'
    const knownUnstartedRunning =
      row.provisional_phase === 'running' &&
      owner &&
      row.provisional_owner_instance === owner.instance &&
      row.provisional_owner_host === owner.host &&
      Number(row.provisional_owner_pid) === owner.pid
    if (!reserved && !knownUnstartedRunning) return false
    return clearProvisional(db, capture, 'cancelled', await databaseNow(db))
  })
}

/** Preserve an unconfirmed provisional operation if a denial cannot cancel its exact token. */
async function cancelUnstartedOrFailClosed(
  capture: PasswordCapture,
  options: { knownUnstartedLease?: PasswordWorkLease } = {}
): Promise<void> {
  try {
    if (await cancelUnstartedPasswordEvaluation(capture, options)) return
    const receipt = await pool.query(
      `SELECT instance, terminal_operation, terminal_disposition
         FROM password_identifier_state WHERE identifier_key = $1`,
      [capture.key]
    )
    const row = receipt.rows[0] as
      | {
          instance: string
          terminal_operation: string | null
          terminal_disposition: string | null
        }
      | undefined
    if (
      row?.instance === capture.instance &&
      row.terminal_operation === capture.operation &&
      (row.terminal_disposition === 'cancelled' || row.terminal_disposition === 'stale')
    )
      return
  } catch {
    // The original denial cannot be trusted while this operation's disposition is unknown.
  }
  throw new PasswordAdmissionError(503, 2, 'authority_failure')
}

export async function reservePasswordPace(): Promise<void> {
  // Force durable acknowledgement for the autocommit statement itself. The
  // materialized CTE executes in the same transaction as the pace upsert, so a
  // connection-level synchronous_commit=off setting cannot make a permit appear
  // committed before it is durable.
  const result = await pool.query(
    `WITH durable_commit AS MATERIALIZED (
       SELECT set_config('synchronous_commit', 'on', true)
     )
     INSERT INTO password_verification_pace(singleton, next_permit)
     SELECT TRUE, clock_timestamp() + $1 * interval '1 millisecond'
       FROM durable_commit
     ON CONFLICT (singleton) DO UPDATE
       SET next_permit = clock_timestamp() + $1 * interval '1 millisecond'
       WHERE password_verification_pace.next_permit <= clock_timestamp()
     RETURNING singleton`,
    [policy.paceMs]
  )
  if (result.rows.length) return
  const remaining = await pool.query(
    `SELECT greatest(1, ceil(extract(epoch FROM next_permit - clock_timestamp()) * 1000)) AS retry_ms FROM password_verification_pace WHERE singleton`
  )
  const pace = remaining.rows[0] as { retry_ms?: string | number } | undefined
  const retryMs = Number(pace?.retry_ms ?? policy.paceMs)
  if (retryMs) denied(retryMs, 'global_pace')
}

function supportedCredential(user: PasswordUser | null): boolean {
  if (!user || user.lifecycle_state !== 'active' || !user.password_hash) return false
  try {
    return (
      /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/.test(user.password_hash) &&
      bcrypt.getRounds(user.password_hash) === policy.bcryptCost
    )
  } catch {
    return false
  }
}

/** Finalize exactly one settled comparison after the durable bcrypt owner was released. */
async function finalizePasswordEvaluation(
  capture: PasswordCapture,
  outcome: 'success' | 'failure' | 'uncertain',
  lease: PasswordWorkLease
): Promise<boolean> {
  const owner = passwordWorkLeaseIdentity(lease)
  if (!owner || !passwordWorkReleaseConfirmed(lease)) return false
  const expectedDisposition =
    outcome === 'success' &&
    !capture.quotaMasked &&
    supportedCredential(capture.user) &&
    (capture.scope !== 'public_login' || capture.reservesPublicSuccess)
      ? 'success'
      : outcome
  try {
    return await withTransaction(async db => {
      await useOutcomeAdmissionProtocol(db)
      let principalCurrent: boolean
      if (capture.user) {
        const current = await db.query(
          `SELECT id, email, password_auth_generation FROM users
            WHERE id = $1 AND email = $2 FOR SHARE`,
          [capture.user.id, capture.email]
        )
        const user = current.rows[0] as
          | {
              id: string
              email: string
              password_auth_generation: string | number
            }
          | undefined
        principalCurrent =
          !!user &&
          String(user.password_auth_generation) === String(capture.user.password_auth_generation)
      } else {
        const current = await db.query('SELECT id FROM users WHERE email = $1 FOR SHARE', [
          capture.email,
        ])
        principalCurrent = current.rows.length === 0
      }
      const result = await db.query(
        'SELECT * FROM password_identifier_state WHERE identifier_key = $1 FOR UPDATE',
        [capture.key]
      )
      const row = result.rows[0] as StateRow | undefined
      if (!row || row.instance !== capture.instance) return false
      if (row.terminal_operation === capture.operation) return false
      if (row.provisional_operation !== capture.operation || row.provisional_phase !== 'running')
        return false
      const now = await databaseNow(db)
      const currentOperation =
        String(row.provisional_epoch) === capture.revision &&
        String(row.revision) === capture.revision &&
        row.provisional_scope === capture.scope &&
        row.provisional_quota_masked === capture.quotaMasked &&
        row.provisional_owner_instance === owner.instance &&
        row.provisional_owner_host === owner.host &&
        Number(row.provisional_owner_pid) === owner.pid
      if (!principalCurrent || !currentOperation || now >= capture.expiresAt) {
        await clearProvisional(db, capture, 'stale', now)
        return false
      }

      const authenticated = outcome === 'success' && expectedDisposition === 'success'
      const state = finishPasswordState(stateOf(row), now, {
        outcome: authenticated ? 'success' : outcome,
        scope: capture.scope,
        reservesPublicSuccess: capture.reservesPublicSuccess,
      })
      const finalized = await db.query(
        `UPDATE password_identifier_state
            SET failures = $2, successes = $3, uncertain = $4, locked_until_ms = $5,
                attempts = $6, user_id = CASE WHEN $7 THEN user_id ELSE $8::uuid END,
                retained_until_ms = greatest(retained_until_ms, $9),
                terminal_operation = $10, terminal_disposition = $11,
                terminal_at_ms = $12, terminal_epoch = revision,
                provisional_operation = NULL, provisional_phase = NULL,
                provisional_scope = NULL, provisional_epoch = NULL,
                provisional_expires_at_ms = NULL, provisional_quota_masked = FALSE,
                provisional_started_at_ms = NULL, provisional_owner_instance = NULL,
                provisional_owner_host = NULL, provisional_owner_pid = NULL,
                provisional_user_id = NULL, provisional_generation = NULL
          WHERE identifier_key = $1 AND instance = $13 AND provisional_operation = $10
            AND provisional_phase = 'running'
          RETURNING terminal_operation`,
        [
          capture.key,
          state.failures,
          state.successes,
          state.uncertain,
          state.lockedUntil,
          state.attempts,
          capture.quotaMasked,
          capture.user?.id ?? null,
          now + policy.windowMs,
          capture.operation,
          expectedDisposition,
          now,
          capture.instance,
        ]
      )
      return finalized.rows.length === 1
    })
  } catch (error) {
    // A lost acknowledgement may follow a committed terminal update. Read only this operation's
    // durable receipt; never repeat bcrypt or apply a second debit.
    try {
      const receipt = await pool.query(
        `SELECT terminal_operation, terminal_disposition
           FROM password_identifier_state
          WHERE identifier_key = $1 AND instance = $2`,
        [capture.key, capture.instance]
      )
      const row = receipt.rows[0] as
        | {
            terminal_operation: string | null
            terminal_disposition: string | null
          }
        | undefined
      if (row?.terminal_operation === capture.operation) {
        return row.terminal_disposition === expectedDisposition
      }
    } catch {
      // Keep the original failure as the public fail-closed result.
    }
    throw error
  }
}

export async function completePasswordEvaluation(
  capture: PasswordCapture,
  success: boolean,
  lease: PasswordWorkLease
): Promise<boolean> {
  return finalizePasswordEvaluation(capture, success ? 'success' : 'failure', lease)
}

export async function completeUncertainPasswordEvaluation(
  capture: PasswordCapture,
  lease: PasswordWorkLease
): Promise<boolean> {
  return finalizePasswordEvaluation(capture, 'uncertain', lease)
}

let busy = false
export async function verifyMemberPassword(
  email: string,
  password: string,
  options: { publicLogin: boolean; userId?: string }
): Promise<PasswordUser | null> {
  let capture: PasswordCapture | null = null
  let lease: PasswordWorkLease | null = null
  let bcryptStarted = false
  let reservationTerminal = false
  let acquiredProcessGuard = false
  try {
    const scope: PasswordVerificationScope = options.publicLogin
      ? 'public_login'
      : 'authenticated_reverification'
    capture = await capturePasswordEvaluation(email, {
      scope,
      userId: options.userId,
    })
    if (!capture) return null
    try {
      await reservePasswordPace()
    } catch (error) {
      await cancelUnstartedOrFailClosed(capture)
      reservationTerminal = true
      throw error
    }
    // The global pace permit remains consumed on local or durable owner contention.
    if (busy) {
      await cancelUnstartedOrFailClosed(capture)
      reservationTerminal = true
      denied(policy.busyRetryMs, 'verification_busy')
    }
    busy = true
    acquiredProcessGuard = true
    lease = await acquirePasswordWork()
    if (!lease) {
      await cancelUnstartedOrFailClosed(capture)
      reservationTerminal = true
      denied(policy.busyRetryMs, 'verification_busy')
    }
    const running = await markPasswordEvaluationRunning(capture, lease)
    if (!running) {
      await releasePasswordWork(lease)
      await cancelUnstartedOrFailClosed(capture, {
        knownUnstartedLease: lease,
      })
      return null
    }

    const user = capture.user
    // A quota-masked request still performs the same identity lookup and generation fence,
    // but it must never compare a real credential hash after the public success quota is full.
    const hasSupportedCredential = supportedCredential(user)
    const supported = !capture.quotaMasked && hasSupportedCredential
    if (user && user.lifecycle_state === 'active' && user.password_hash && !hasSupportedCredential)
      logger.info({ event: 'password_credential_reset_required' }, 'unsupported member credential')
    bcryptStarted = true
    let match: boolean
    try {
      match = await bcrypt.compare(password, supported ? user!.password_hash! : PASSWORD_DUMMY_HASH)
    } catch (error) {
      // The comparison promise settled without an outcome. Once the durable global owner is
      // released, convert this operation to a conservative U debit (and its reserved public S
      // slot) instead of leaving a settled operation permanently running.
      await releasePasswordWork(lease)
      await completeUncertainPasswordEvaluation(capture, lease)
      throw error
    }
    // Release the global owner before credential-state completion borrows its pool connection.
    await releasePasswordWork(lease)
    const authenticated =
      !capture.quotaMasked && !!user && user.lifecycle_state === 'active' && supported && match
    const current = await completePasswordEvaluation(capture, authenticated, lease)
    return current && authenticated ? user : null
  } catch (error) {
    if (capture && !bcryptStarted && !reservationTerminal) {
      try {
        if (lease) {
          await releasePasswordWork(lease)
          await cancelUnstartedOrFailClosed(capture, {
            knownUnstartedLease: lease,
          })
        } else {
          await cancelUnstartedOrFailClosed(capture)
        }
      } catch {
        // Cancellation/release uncertainty stays fail-closed; do not run or retry bcrypt.
        logger.warn(
          { event: 'password_reservation_cancel_unconfirmed' },
          'password reservation cancellation unconfirmed'
        )
        throw new PasswordAdmissionError(503, 2, 'authority_failure')
      }
    }
    if (error instanceof PasswordAdmissionError) throw error
    // Do not log SQL, identifiers, hashes, submitted credentials or backend messages.
    logger.warn({ event: 'password_authority_unavailable' }, 'password authority unavailable')
    throw new PasswordAdmissionError(503, 2, 'authority_failure')
  } finally {
    if (acquiredProcessGuard) busy = false
  }
}

/** Delete only fully expired terminal state; active and uncertain operations remain fenced. */
export async function cleanupPasswordIdentifierState(): Promise<number> {
  const result = await withTransaction(async db => {
    await useOutcomeAdmissionProtocol(db)
    return db.query(
      `DELETE FROM password_identifier_state
        WHERE retained_until_ms <= floor(extract(epoch FROM clock_timestamp()) * 1000)
          AND locked_until_ms <= floor(extract(epoch FROM clock_timestamp()) * 1000)
          AND legacy_hold_until_ms <= floor(extract(epoch FROM clock_timestamp()) * 1000)
          AND provisional_operation IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM unnest(attempts || failures || successes || uncertain) event(ts)
             WHERE ts > floor(extract(epoch FROM clock_timestamp()) * 1000) - $1)
        RETURNING identifier_key`,
      [policy.windowMs]
    )
  })
  return result.rowCount ?? 0
}
