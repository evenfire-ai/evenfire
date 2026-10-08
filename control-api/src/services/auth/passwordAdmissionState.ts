import { createHash } from 'node:crypto'

// Spec 043: capacity and abuse policy. Changing these requires owner policy approval.
export const PASSWORD_ADMISSION_POLICY = Object.freeze({
  sourceAttemptsPerMinute: 5,
  identifierAttempts: 5,
  windowMs: 15 * 60_000,
  failures: 5,
  cooldownMs: 15 * 60_000,
  paceMs: 7_500,
  concurrency: 1,
  evaluationMs: 15 * 60_000,
  bcryptCost: 12,
})

export type PasswordIdentifierState = {
  attempts: number[]
  failures: number[]
  lockedUntil: number
}

export function passwordIdentifierKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

export function settledPasswordState(state: PasswordIdentifierState, now: number) {
  const cutoff = now - PASSWORD_ADMISSION_POLICY.windowMs
  return {
    attempts: state.attempts.filter(time => time > cutoff),
    failures: state.failures.filter(time => time > cutoff),
    lockedUntil: state.lockedUntil > now ? state.lockedUntil : 0,
  }
}

export function admitPasswordIdentifier(
  state: PasswordIdentifierState,
  now: number,
  chargeAttempt: boolean
): { state: PasswordIdentifierState; retryMs: number } {
  const settled = settledPasswordState(state, now)
  const budgetEnd =
    chargeAttempt && settled.attempts.length >= PASSWORD_ADMISSION_POLICY.identifierAttempts
      ? settled.attempts[0] + PASSWORD_ADMISSION_POLICY.windowMs
      : 0
  const retryMs = Math.max(0, settled.lockedUntil - now, budgetEnd - now)
  if (retryMs > 0) return { state: settled, retryMs }
  if (chargeAttempt) settled.attempts.push(now)
  return { state: settled, retryMs: 0 }
}

export function finishPasswordState(state: PasswordIdentifierState, now: number, success: boolean) {
  const settled = settledPasswordState(state, now)
  if (success) return { ...settled, failures: [], lockedUntil: 0 }
  if (settled.lockedUntil > now) return settled
  settled.failures.push(now)
  if (settled.failures.length >= PASSWORD_ADMISSION_POLICY.failures)
    settled.lockedUntil = now + PASSWORD_ADMISSION_POLICY.cooldownMs
  return settled
}
