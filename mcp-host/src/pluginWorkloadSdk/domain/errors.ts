/**
 * Plugin Workload SDK — structured error model (spec §15).
 *
 * Every failure surfaced to a plugin workload is a PluginWorkloadError with
 * a stable machine-readable code, an HTTP status, and a retryable hint.
 * Internal control-api response details never pass through verbatim — the
 * anti-corruption layer maps them here.
 */

export const PLUGIN_WORKLOAD_ERROR_CODES = [
  'capability_not_declared',
  'caller_not_allowed',
  'scope_denied',
  'target_not_allowed',
  'event_type_not_allowed',
  'quota_exceeded',
  'provider_policy_denied',
  'provider_unavailable',
  'payload_too_large',
  'idempotency_conflict',
  'invalid_request',
  'unauthorized',
] as const
export type PluginWorkloadErrorCode = (typeof PLUGIN_WORKLOAD_ERROR_CODES)[number]

const ERROR_HTTP_STATUS: Record<PluginWorkloadErrorCode, number> = {
  capability_not_declared: 403,
  caller_not_allowed: 403,
  scope_denied: 403,
  target_not_allowed: 403,
  event_type_not_allowed: 403,
  quota_exceeded: 429,
  provider_policy_denied: 403,
  provider_unavailable: 503,
  payload_too_large: 413,
  idempotency_conflict: 422,
  invalid_request: 400,
  unauthorized: 401,
}

const ERROR_CODE_SET = new Set<string>(PLUGIN_WORKLOAD_ERROR_CODES)

export class PluginWorkloadError extends Error {
  readonly code: PluginWorkloadErrorCode
  readonly retryable: boolean
  readonly httpStatus: number

  constructor(code: PluginWorkloadErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'PluginWorkloadError'
    this.code = code
    this.retryable = retryable
    this.httpStatus = ERROR_HTTP_STATUS[code]
  }

  toBody(): { error: PluginWorkloadErrorCode; message: string; retryable: boolean } {
    return { error: this.code, message: this.message, retryable: this.retryable }
  }
}

export function isKnownPluginWorkloadErrorCode(code: string): code is PluginWorkloadErrorCode {
  return ERROR_CODE_SET.has(code)
}
