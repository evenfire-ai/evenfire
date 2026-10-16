import type { PasswordAdmissionDenialReason } from '../../observability/metrics.js'

export class PasswordAdmissionError extends Error {
  constructor(
    readonly status: 429 | 503,
    readonly retryAfterSeconds: number,
    readonly reason: PasswordAdmissionDenialReason,
    readonly publicError:
      'rate_limited' | 'authority_unavailable' | 'recovery_outcome_unknown' = status === 429
      ? 'rate_limited'
      : 'authority_unavailable'
  ) {
    super(status === 429 ? 'rate_limited' : 'authority_unavailable')
  }
}

/** Safe, non-retryable result for an unexpected password mutation callback failure. */
export class PasswordMutationInternalError extends Error {
  readonly code = 'internal_error'

  constructor() {
    super('internal_error')
    this.name = 'PasswordMutationInternalError'
  }
}
