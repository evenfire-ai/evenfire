/**
 * Shared, duck-typed error classification helpers.
 *
 * These helpers work on any error whose shape matches HttpErrorLike — no
 * instanceof checks, so OpenAI/Anthropic/ZAI/Bailian/future providers all
 * share the same status-code branch.
 */
import { LlmErrorCode } from '../core/errors'
import type { ClassifiedError } from './index'

export interface HttpErrorLike {
  status?: number
  error?: { code?: string; type?: string; message?: string }
  message?: string
}

function isHttpErrorLike(err: unknown): err is HttpErrorLike {
  return typeof err === 'object' && err !== null && ('status' in err || 'error' in err)
}

export function classifyByHttpStatus(err: unknown): ClassifiedError | null {
  if (!isHttpErrorLike(err)) return null
  const e = err as HttpErrorLike
  const rawMsg = e.error?.message ?? e.message ?? 'Unknown LLM error'
  const bodyCode = e.error?.code
  const bodyType = e.error?.type
  // Additive diagnostics threaded onto every classification (spec 02, Pieza A).
  const diag: Pick<ClassifiedError, 'httpStatus' | 'providerCode'> = {
    httpStatus: typeof e.status === 'number' ? e.status : undefined,
    providerCode: bodyCode ?? bodyType,
  }

  // Body-level signals take precedence over raw HTTP status. To add new
  // body-code mappings (e.g., "rate_limit_exceeded", "context_length_exceeded"),
  // extend this if-block — do NOT add them to the switch below, which only
  // considers HTTP status.
  if (bodyCode === 'insufficient_quota' || bodyType === 'insufficient_quota') {
    return { code: LlmErrorCode.InsufficientQuota, retryable: false, message: rawMsg, ...diag }
  }
  // Model retired OR not accessible to this account — providers surface it as a
  // body code even on a non-404 status. Ambiguous by design (the runtime never
  // concludes the catalog is stale — see spec 02 §3.1); it only reports "not
  // available". Non-retryable and NOT a failover trigger.
  if (bodyCode === 'model_not_found' || bodyType === 'model_not_found') {
    return { code: LlmErrorCode.ModelNotAvailable, retryable: false, message: rawMsg, ...diag }
  }
  // A genuinely invalid credential (distinct from a 403 access/billing denial).
  if (bodyCode === 'invalid_api_key' || bodyType === 'invalid_api_key') {
    return { code: LlmErrorCode.AuthenticationFailed, retryable: false, message: rawMsg, ...diag }
  }

  switch (e.status) {
    case 401:
      // A rotatable bad credential — kept on `auth` failover class.
      return { code: LlmErrorCode.AuthenticationFailed, retryable: false, message: rawMsg, ...diag }
    case 403:
      // 403 ≠ 401: not a bad key value but account access / billing / permission.
      // Split off AuthenticationFailed so a forbidden model/account does not
      // masquerade as a rotatable-credential failure (spec 02 §3.1).
      return { code: LlmErrorCode.InsufficientQuota, retryable: false, message: rawMsg, ...diag }
    case 402:
      return { code: LlmErrorCode.InsufficientQuota, retryable: false, message: rawMsg, ...diag }
    case 404:
      // Retired or inaccessible model — indistinguishable by API (spec 02 §3.1).
      // Non-retryable so the loop does not retry, and mapped to `null` failover
      // class so it does not silently divert cross-provider.
      return { code: LlmErrorCode.ModelNotAvailable, retryable: false, message: rawMsg, ...diag }
    case 429:
      return { code: LlmErrorCode.RateLimited, retryable: true, message: rawMsg, ...diag }
    case 503:
    case 529:
      return { code: LlmErrorCode.ModelOverloaded, retryable: true, message: rawMsg, ...diag }
  }

  if (typeof e.status === 'number' && e.status >= 500 && e.status < 600) {
    return { code: LlmErrorCode.ModelOverloaded, retryable: true, message: rawMsg, ...diag }
  }
  if (e.status === 400) {
    return { code: LlmErrorCode.ApiCallFailed, retryable: false, message: rawMsg, ...diag }
  }
  return null
}

/**
 * Fallback classifier for errors whose shape does not match HttpErrorLike.
 *
 * Defaults to `retryable: true` because the common cause is a transport
 * failure (network down, DNS failure, socket closed, timeout) which may
 * succeed on retry. Providers with a non-HTTP SDK error shape MUST
 * intercept those shapes in their own `classifyError` before falling
 * through to this helper — otherwise permanent errors would be
 * misclassified as transient. See ClaudeProvider.classifyError for the
 * Anthropic credit-balance quirk that demonstrates this pattern.
 */
export function classifyUnknown(err: unknown): ClassifiedError {
  const msg = err instanceof Error ? err.message : String(err)
  return { code: LlmErrorCode.ApiCallFailed, retryable: true, message: msg }
}
