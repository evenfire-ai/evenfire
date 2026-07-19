/**
 * Provider-fallback (R5) — error classification.
 *
 * Maps the real `(LlmErrorCode, retryable)` tuples of `core/errors` +
 * `errorClassification` onto the closed {@link FailoverClass} catalogue (spec
 * §3-R5.2). This is the ONLY place the tuple→class mapping lives, shared by the
 * engine's eligibility check and by callers that want to filter classes.
 */
import { LlmErrorCode } from '../../core/errors'
import type { FailoverClass } from './types'

/** The default `triggerOn` set — all four classes (spec §3-R5.2). */
export const ALL_FAILOVER_CLASSES: readonly FailoverClass[] = [
  'insufficient_quota',
  'auth',
  'provider_unavailable',
  'rate_limited',
]

/**
 * Classify a provider error tuple into a {@link FailoverClass}, or `null` when
 * the error is NOT eligible for fallback under any policy.
 *
 * Deliberate mapping (spec §3-R5.2):
 *   - `InsufficientQuota`    → insufficient_quota (402 / credit balance)
 *   - `AuthenticationFailed` → auth               (401 and 403 collapse)
 *   - `RateLimited`          → rate_limited        (429)
 *   - `ModelOverloaded`      → provider_unavailable (5xx / 529)
 *   - `ApiCallFailed ∧ retryable` → provider_unavailable (timeout / network;
 *     also `classifyUnknown`'s default bucket — restrict `triggerOn` to avoid
 *     firing on unrecognised errors)
 *   - `ApiCallFailed ∧ !retryable` → null (400 / validation / content-policy —
 *     never trigger; masking these would hide bugs)
 *   - everything else (InvalidResponse, ContextLengthExceeded, ContentFiltered,
 *     ModelNotAvailable) → null
 */
export function classifyFailoverClass(
  code: LlmErrorCode,
  retryable: boolean
): FailoverClass | null {
  switch (code) {
    case LlmErrorCode.InsufficientQuota:
      return 'insufficient_quota'
    case LlmErrorCode.AuthenticationFailed:
      return 'auth'
    case LlmErrorCode.RateLimited:
      return 'rate_limited'
    case LlmErrorCode.ModelOverloaded:
      return 'provider_unavailable'
    case LlmErrorCode.ApiCallFailed:
      return retryable ? 'provider_unavailable' : null
    default:
      return null
  }
}
