/**
 * Shared, duck-typed error classification helpers.
 *
 * These helpers work on any error whose shape matches HttpErrorLike — no
 * instanceof checks, so OpenAI/Anthropic/ZAI/Bailian/future providers all
 * share the same status-code branch.
 *
 * See docs/superpowers/specs/2026-04-10-llm-error-handling-design.md — Layer B.
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

  // Body-level signals take precedence over raw HTTP status. To add new
  // body-code mappings (e.g., "rate_limit_exceeded", "context_length_exceeded"),
  // extend this if-block — do NOT add them to the switch below, which only
  // considers HTTP status.
  if (bodyCode === 'insufficient_quota' || bodyType === 'insufficient_quota') {
    return { code: LlmErrorCode.InsufficientQuota, retryable: false, message: rawMsg }
  }

  switch (e.status) {
    case 401:
    case 403:
      return { code: LlmErrorCode.AuthenticationFailed, retryable: false, message: rawMsg }
    case 402:
      return { code: LlmErrorCode.InsufficientQuota, retryable: false, message: rawMsg }
    case 429:
      return { code: LlmErrorCode.RateLimited, retryable: true, message: rawMsg }
    case 503:
    case 529:
      return { code: LlmErrorCode.ModelOverloaded, retryable: true, message: rawMsg }
  }

  if (typeof e.status === 'number' && e.status >= 500 && e.status < 600) {
    return { code: LlmErrorCode.ModelOverloaded, retryable: true, message: rawMsg }
  }
  if (e.status === 400) {
    return { code: LlmErrorCode.ApiCallFailed, retryable: false, message: rawMsg }
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
