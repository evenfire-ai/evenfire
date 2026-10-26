import { createHash } from 'node:crypto'

// BUG-192 capacity controls remain unchanged. Policy changes require owner approval.
export const PASSWORD_ADMISSION_POLICY = Object.freeze({
  sourceAttemptsPerMinute: 5,
  successesPerIdentifier: 40,
  windowMs: 15 * 60_000,
  failures: 5,
  cooldownMs: 15 * 60_000,
  paceMs: 7_500,
  busyRetryMs: 8_000,
  concurrency: 1,
  evaluationMs: 15 * 60_000,
  bcryptCost: 12,
})

export type PasswordVerificationScope = 'public_login' | 'authenticated_reverification'
export type PasswordOperationPhase = 'reserved' | 'running'
export type PasswordAdmissionReason =
  | 'identifier_attempts'
  | 'identifier_cooldown'
  | 'identifier_migration_hold'
  | 'identifier_operation_busy'

export type PasswordProvisionalOperation = {
  operation: string
  phase: PasswordOperationPhase
  expiresAt: number
}

export type PasswordIdentifierState = {
  /** All-attempt timestamps are retained only as conservative pre-v2 evidence. */
  attempts: number[]
  failures: number[]
  successes: number[]
  uncertain: number[]
  lockedUntil: number
  legacyHoldUntil: number
  provisional: PasswordProvisionalOperation | null
}

export function passwordIdentifierKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

function prune(times: number[], cutoff: number): number[] {
  return times.filter(time => time > cutoff).sort((a, b) => a - b)
}

export function settledPasswordState(state: PasswordIdentifierState, now: number) {
  const cutoff = now - PASSWORD_ADMISSION_POLICY.windowMs
  const provisional =
    state.provisional?.phase === 'reserved' && state.provisional.expiresAt <= now
      ? null
      : state.provisional
  return {
    attempts: prune(state.attempts, cutoff),
    failures: prune(state.failures, cutoff),
    successes: prune(state.successes, cutoff),
    uncertain: prune(state.uncertain, cutoff),
    lockedUntil: state.lockedUntil > now ? state.lockedUntil : 0,
    legacyHoldUntil: state.legacyHoldUntil > now ? state.legacyHoldUntil : 0,
    provisional,
  }
}

export type PasswordAdmissionDecision = {
  state: PasswordIdentifierState
  retryMs: number
  reason: PasswordAdmissionReason | null
  quotaMasked: boolean
  reservesPublicSuccess: boolean
}

/**
 * Reserve both possible outcomes before password verification. A full public success window does
 * not reject the request: it selects dummy-only verification so account existence remains hidden.
 */
export function evaluatePasswordAdmission(
  state: PasswordIdentifierState,
  now: number,
  scope: PasswordVerificationScope
): PasswordAdmissionDecision {
  const settled = settledPasswordState(state, now)
  const risk = [...settled.failures, ...settled.uncertain].sort((a, b) => a - b)
  const riskEnd =
    risk.length >= PASSWORD_ADMISSION_POLICY.failures
      ? risk[0] + PASSWORD_ADMISSION_POLICY.windowMs
      : 0
  const retryMs = Math.max(
    0,
    settled.lockedUntil - now,
    settled.legacyHoldUntil - now,
    riskEnd - now
  )
  if (settled.lockedUntil > now)
    return {
      state: settled,
      retryMs,
      reason: 'identifier_cooldown',
      quotaMasked: false,
      reservesPublicSuccess: false,
    }
  if (settled.legacyHoldUntil > now)
    return {
      state: settled,
      retryMs,
      reason: 'identifier_migration_hold',
      quotaMasked: false,
      reservesPublicSuccess: false,
    }
  if (risk.length >= PASSWORD_ADMISSION_POLICY.failures)
    return {
      state: settled,
      retryMs,
      reason: 'identifier_attempts',
      quotaMasked: false,
      reservesPublicSuccess: false,
    }
  if (settled.provisional)
    return {
      state: settled,
      retryMs: PASSWORD_ADMISSION_POLICY.busyRetryMs,
      reason: 'identifier_operation_busy',
      quotaMasked: false,
      reservesPublicSuccess: false,
    }

  const quotaMasked =
    scope === 'public_login' &&
    settled.successes.length >= PASSWORD_ADMISSION_POLICY.successesPerIdentifier
  return {
    state: settled,
    retryMs: 0,
    reason: null,
    quotaMasked,
    reservesPublicSuccess: scope === 'public_login' && !quotaMasked,
  }
}

export function finishPasswordState(
  state: PasswordIdentifierState,
  now: number,
  result: {
    outcome: 'success' | 'failure' | 'uncertain'
    scope: PasswordVerificationScope
    reservesPublicSuccess?: boolean
  }
): PasswordIdentifierState {
  const settled = settledPasswordState(state, now)
  if (result.outcome === 'success') {
    if (result.scope === 'public_login') settled.successes.push(now)
    return settled
  }
  if (result.outcome === 'uncertain') {
    settled.uncertain.push(now)
    if (result.scope === 'public_login' && result.reservesPublicSuccess) {
      settled.successes.push(now)
    }
    return settled
  }
  settled.failures.push(now)
  settled.failures.sort((a, b) => a - b)
  if (settled.failures.length >= PASSWORD_ADMISSION_POLICY.failures)
    settled.lockedUntil = now + PASSWORD_ADMISSION_POLICY.cooldownMs
  return settled
}

export function passwordRiskRetryMs(state: PasswordIdentifierState, now: number): number {
  const settled = settledPasswordState(state, now)
  const risk = [...settled.failures, ...settled.uncertain].sort((a, b) => a - b)
  if (risk.length < PASSWORD_ADMISSION_POLICY.failures) return 0
  return Math.max(1, risk[0] + PASSWORD_ADMISSION_POLICY.windowMs - now)
}
