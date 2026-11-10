import type { PasswordAdmissionDenialReason } from '../../observability/metrics.js'

export class PasswordAdmissionError extends Error {
  constructor(
    readonly status: 429 | 503,
    readonly retryAfterSeconds: number,
    readonly reason: PasswordAdmissionDenialReason,
    readonly publicError:
      | 'rate_limited'
      | 'authority_unavailable'
      | 'recovery_outcome_unknown' = status === 429 ? 'rate_limited' : 'authority_unavailable'
  ) {
    super(status === 429 ? 'rate_limited' : 'authority_unavailable')
  }
}

/** Safe, non-retryable result for an unexpected password mutation callback failure. */
export class PasswordMutationInternalError extends Error {
  readonly code = 'internal_error'
  readonly cause: unknown

  constructor(cause?: unknown) {
    super('internal_error')
    this.name = 'PasswordMutationInternalError'
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false })
  }
}

export type PasswordMutationCauseKind =
  | 'type_error'
  | 'reference_error'
  | 'range_error'
  | 'syntax_error'
  | 'error'
  | 'non_error'

export function passwordMutationCauseKind(cause: unknown): PasswordMutationCauseKind {
  try {
    if (cause instanceof TypeError) return 'type_error'
    if (cause instanceof ReferenceError) return 'reference_error'
    if (cause instanceof RangeError) return 'range_error'
    if (cause instanceof SyntaxError) return 'syntax_error'
    if (cause instanceof Error) return 'error'
  } catch {
    // A hostile thrown value must not prevent the sanitized response path.
  }
  return 'non_error'
}
