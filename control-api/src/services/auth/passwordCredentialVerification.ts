import bcrypt from 'bcryptjs'
import { type DbTransactionClient, pool, withTransaction } from '../../db.js'
import { rootLogger } from '../../observability/logger.js'
import { acquireRateLimitConcurrencyLease } from '../rateLimiterService.js'
import {
  type PasswordIdentifierState,
  admitPasswordIdentifier,
  finishPasswordState,
  passwordIdentifierKey,
  PASSWORD_ADMISSION_POLICY as policy,
} from './passwordAdmissionState.js'

// Synthetic, repository-controlled cost-12 hash, precomputed once, never per request.
export const PASSWORD_DUMMY_HASH = '$2b$12$DdpJSFUb/dYx43plh72Ia.k9RJ8krESZ/DtTRUbdQq/ngzfJuyCUu'
const logger = rootLogger.child({ module: 'password-admission' })

export class PasswordAdmissionError extends Error {
  constructor(
    readonly status: 429 | 503,
    readonly retryAfterSeconds: number
  ) {
    super(status === 429 ? 'rate_limited' : 'authority_unavailable')
  }
}
function denied(retryMs: number): never {
  throw new PasswordAdmissionError(429, Math.min(900, Math.max(1, Math.ceil(retryMs / 1000))))
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
  expiresAt: number
  user: PasswordUser | null
}
type StateRow = {
  instance: string
  revision: string
  attempts: string[]
  failures: string[]
  locked_until_ms: string
}
function stateOf(row: StateRow): PasswordIdentifierState {
  return {
    attempts: row.attempts.map(Number),
    failures: row.failures.map(Number),
    lockedUntil: Number(row.locked_until_ms),
  }
}
async function databaseNow(db: Pick<DbTransactionClient, 'query'>): Promise<number> {
  const result = await db.query(
    'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms'
  )
  return Number((result.rows[0] as { now_ms: string }).now_ms)
}

export async function capturePasswordEvaluation(
  email: string,
  chargeAttempt: boolean
): Promise<PasswordCapture> {
  const normalized = email.trim().toLowerCase()
  const key = passwordIdentifierKey(normalized)
  const snapshot = await withTransaction(async db => {
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
    const decision = admitPasswordIdentifier(stateOf(row), now, chargeAttempt)
    // A denied request never writes: it cannot move the rolling denial horizon.
    if (decision.retryMs) return { retryMs: decision.retryMs, row }
    const expiresAt = now + policy.evaluationMs
    await db.query(
      'UPDATE password_identifier_state SET attempts = $2, failures = $3, locked_until_ms = $4, retained_until_ms = greatest(retained_until_ms, $5) WHERE identifier_key = $1',
      [key, decision.state.attempts, decision.state.failures, decision.state.lockedUntil, expiresAt]
    )
    return { retryMs: 0, row, expiresAt }
  })
  if (snapshot.retryMs) denied(snapshot.retryMs)
  // No transaction or row lock survives into bcrypt.
  const users = await pool.query(
    `SELECT id, email, name, picture, password_hash, lifecycle_state,
    lifecycle_version, password_auth_generation FROM users WHERE email = $1 LIMIT 1`,
    [normalized]
  )
  return {
    email: normalized,
    key,
    instance: snapshot.row.instance,
    revision: String(snapshot.row.revision),
    expiresAt: snapshot.expiresAt!,
    user: (users.rows[0] as PasswordUser) ?? null,
  }
}

export async function reservePasswordPace(): Promise<void> {
  const result = await pool.query(
    `INSERT INTO password_verification_pace(singleton, next_permit)
    VALUES (TRUE, clock_timestamp() + $1 * interval '1 millisecond')
    ON CONFLICT (singleton) DO UPDATE SET next_permit = clock_timestamp() + $1 * interval '1 millisecond'
    WHERE password_verification_pace.next_permit <= clock_timestamp()
    RETURNING singleton`,
    [policy.paceMs]
  )
  if (!result.rows.length) {
    const remaining = await pool.query(
      `SELECT greatest(1, ceil(extract(epoch FROM next_permit - clock_timestamp()) * 1000)) AS retry_ms FROM password_verification_pace WHERE singleton`
    )
    denied(Number(remaining.rows[0]?.retry_ms ?? policy.paceMs))
  }
}

export async function completePasswordEvaluation(
  capture: PasswordCapture,
  success: boolean
): Promise<boolean> {
  return withTransaction(async db => {
    // Credential writers lock users then identifier state (via the trigger).
    // This same order fences completion without a deadlock or a lock across bcrypt.
    const current = await db.query(
      `SELECT id, password_auth_generation FROM users WHERE email = $1 FOR SHARE`,
      [capture.email]
    )
    const user = current.rows[0] as { id: string; password_auth_generation: string } | undefined
    if (
      capture.user
        ? !user ||
          user.id !== capture.user.id ||
          String(user.password_auth_generation) !== String(capture.user.password_auth_generation)
        : !!user
    )
      return false
    const result = await db.query(
      'SELECT * FROM password_identifier_state WHERE identifier_key = $1 FOR UPDATE',
      [capture.key]
    )
    const row = result.rows[0] as StateRow | undefined
    // Instance makes cleanup/recreation ABA-safe; revision fences stale results after success.
    if (!row || row.instance !== capture.instance || String(row.revision) !== capture.revision)
      return false
    const now = await databaseNow(db)
    if (now >= capture.expiresAt) return false
    const state = finishPasswordState(stateOf(row), now, success)
    await db.query(
      `UPDATE password_identifier_state SET failures = $2, locked_until_ms = $3,
      revision = revision + $4, user_id = $5 WHERE identifier_key = $1`,
      [capture.key, state.failures, state.lockedUntil, success ? 1 : 0, capture.user?.id ?? null]
    )
    return true
  })
}

let busy = false
export async function verifyMemberPassword(
  email: string,
  password: string,
  options: { publicLogin: boolean; userId?: string }
): Promise<PasswordUser | null> {
  try {
    const capture = await capturePasswordEvaluation(email, options.publicLogin)
    await reservePasswordPace()
    // The pace permit is deliberately not refunded on a busy lease.
    if (busy) denied(policy.paceMs)
    busy = true
    try {
      const lease = await acquireRateLimitConcurrencyLease(
        [{ bucketKey: 'password-verification-global', maxConcurrent: policy.concurrency }],
        { releaseIdleClient: true }
      )
      if (!lease.backendAvailable) throw new PasswordAdmissionError(503, 2)
      if (!lease.allowed) denied(policy.paceMs)
      const user = capture.user
      let authenticated = false
      try {
        const eligible =
          !!user &&
          user.lifecycle_state === 'active' &&
          (!options.userId || options.userId === user.id)
        let supported = false
        if (eligible && user.password_hash) {
          try {
            supported =
              /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/.test(user.password_hash) &&
              bcrypt.getRounds(user.password_hash) === policy.bcryptCost
          } catch {
            supported = false
          }
          if (!supported)
            logger.info(
              { event: 'password_credential_reset_required' },
              'unsupported member credential'
            )
        }
        const match = await bcrypt.compare(
          password,
          supported ? user!.password_hash! : PASSWORD_DUMMY_HASH
        )
        authenticated = eligible && supported && match
      } finally {
        await lease.release()
      }
      // Bcrypt is finished. Release its pool session before completion borrows a client.
      const current = await completePasswordEvaluation(capture, authenticated)
      return current && authenticated ? user : null
    } finally {
      busy = false
    }
  } catch (error) {
    if (error instanceof PasswordAdmissionError) throw error
    // Do not log SQL, identifiers, hashes, submitted credentials or backend messages.
    logger.warn({ event: 'password_authority_unavailable' }, 'password authority unavailable')
    throw new PasswordAdmissionError(503, 2)
  }
}

/** Independent retention; old token-bucket cleanup never owns these rows. */
export async function cleanupPasswordIdentifierState(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM password_identifier_state
    WHERE retained_until_ms <= floor(extract(epoch FROM clock_timestamp()) * 1000)
      AND locked_until_ms <= floor(extract(epoch FROM clock_timestamp()) * 1000)
      AND NOT EXISTS (SELECT 1 FROM unnest(attempts || failures) t
        WHERE t > floor(extract(epoch FROM clock_timestamp()) * 1000) - $1)`,
    [policy.windowMs]
  )
  return result.rowCount ?? 0
}
