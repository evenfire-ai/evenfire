import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { ControlApiError } from '../controlApiClient.js'

const SAFE_PUBLIC_CORRELATION_ID = /^[A-Za-z0-9_-]{1,128}$/

export function selectPublicCorrelationId(...candidates: readonly unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    if (SAFE_PUBLIC_CORRELATION_ID.test(candidate)) return candidate
  }
  return randomUUID()
}

const PUBLIC_CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'invalid_request',
  401: 'invalid_session',
  403: 'forbidden',
  404: 'not_found',
  408: 'request_timeout',
  409: 'conflict',
  410: 'gone',
  411: 'length_required',
  412: 'precondition_failed',
  413: 'payload_too_large',
  422: 'invalid_request',
  425: 'too_early',
  429: 'rate_limited',
  500: 'internal_error',
  502: 'upstream_unavailable',
  503: 'authority_unavailable',
  504: 'upstream_timeout',
  507: 'insufficient_storage',
}

const SUPPORTED_CONTROL_API_PUBLIC_STATUSES = new Set(
  Object.keys(PUBLIC_CODE_BY_STATUS).map(Number)
)

const PUBLIC_MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  invalid_request: 'The request is not valid.',
  invalid_session: 'The session is not valid.',
  session_revoked: 'The session is not valid.',
  forbidden: 'The requested operation is not allowed.',
  not_found: 'The resource was not found.',
  request_timeout: 'The request timed out.',
  conflict: 'The request conflicts with current state.',
  access_path_required: 'Choose an access path for this operation.',
  access_path_stale: 'The access path is stale; refresh access before retrying.',
  gone: 'The resource is no longer available.',
  length_required: 'A content length is required.',
  precondition_failed: 'The request precondition did not match current state.',
  payload_too_large: 'The request payload is too large.',
  too_early: 'The request is not ready to be processed.',
  rate_limited: 'Too many requests; retry later.',
  internal_error: 'The request could not be completed.',
  upstream_unavailable: 'The upstream service is temporarily unavailable.',
  authority_unavailable: 'Authorization is temporarily unavailable.',
  member_registration_unavailable: 'Member registration is temporarily unavailable.',
  member_registration_misconfigured: 'Member registration is not configured correctly.',
  upstream_timeout: 'The upstream service timed out.',
  insufficient_storage: 'The requested operation cannot be completed because storage is full.',
}

const ALLOWED_CODES_BY_STATUS: Readonly<Record<number, ReadonlySet<string>>> = {
  400: new Set(['invalid_request']),
  401: new Set(['invalid_session', 'session_revoked']),
  403: new Set(['forbidden']),
  404: new Set(['not_found']),
  408: new Set(['request_timeout']),
  409: new Set(['conflict', 'access_path_required', 'access_path_stale']),
  410: new Set(['gone']),
  411: new Set(['length_required']),
  412: new Set(['precondition_failed']),
  413: new Set(['payload_too_large']),
  422: new Set(['invalid_request']),
  425: new Set(['too_early']),
  429: new Set(['rate_limited']),
  500: new Set(['internal_error']),
  502: new Set(['upstream_unavailable']),
  503: new Set([
    'authority_unavailable',
    'member_registration_unavailable',
    'member_registration_misconfigured',
  ]),
  504: new Set(['upstream_timeout']),
  507: new Set(['insufficient_storage']),
}

type PublicPathDescriptor = { id: string; kind: 'direct' | 'team'; teamId?: string }
export type SanitizedControlApiPublicError = {
  status: number
  body: Record<string, unknown>
  headers: Record<string, string>
}

const SAFE_DOMAIN_REASONS = new Set([
  'agent_manager_forbidden',
  'managed_agent_permission_forbidden',
  'foreign_agent_forbidden',
  'subjects_invalid',
  'escalation_rejected',
  'manage_acl_required',
  'desktop_requires_team',
  'no_permitted_scopes',
])

const PUBLIC_RATE_LIMIT_HEADERS = [
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
] as const

function safePublicRateLimitHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of PUBLIC_RATE_LIMIT_HEADERS) {
    const raw = headers[name]
    if (!raw || !/^\d{1,10}$/.test(raw)) continue
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 0) continue
    if (name === 'retry-after' && (value < 1 || value > 86_400)) continue
    result[name] = String(value)
  }
  return result
}

function safeUnsignedIntegerHeader(
  headers: Record<string, string>,
  name: string
): Record<string, string> {
  const raw = headers[name]
  if (!raw || !/^\d{1,16}$/.test(raw)) return {}
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? { [name]: String(value) } : {}
}

function safeInvalidIndexes(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return undefined
  const indexes = value.filter(
    (item): item is number => Number.isSafeInteger(item) && item >= 0 && item <= 10_000
  )
  return indexes.length === value.length ? indexes : undefined
}

function safePathDescriptors(value: unknown): PublicPathDescriptor[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return undefined
  const paths: PublicPathDescriptor[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : ''
    const kind = row.kind === 'direct' || row.kind === 'team' ? row.kind : null
    const teamId = typeof row.teamId === 'string' ? row.teamId : undefined
    if (!/^ap1_[A-Za-z0-9_-]{43}$/.test(id) || !kind) return undefined
    if (kind === 'team' && !teamId) return undefined
    paths.push({ id, kind, ...(teamId ? { teamId } : {}) })
  }
  return paths
}

export function sanitizeControlApiPublicError(
  error: unknown,
  propagatedStatuses: ReadonlySet<number>,
  fallbackCorrelationId = ''
): SanitizedControlApiPublicError | null {
  if (!(error instanceof ControlApiError) || !propagatedStatuses.has(error.status)) return null
  const rawBody =
    error.body && typeof error.body === 'object'
      ? (error.body as Record<string, unknown>)
      : undefined
  const rawError =
    rawBody && Object.prototype.hasOwnProperty.call(rawBody, 'error') ? rawBody.error : undefined
  const rawEnvelope = rawError && typeof rawError === 'object' ? rawError : undefined
  const suppliedCode =
    rawEnvelope && typeof (rawEnvelope as { code?: unknown }).code === 'string'
      ? String((rawEnvelope as { code: string }).code)
      : error.status === 503 && typeof rawError === 'string'
        ? rawError
        : ''
  const fallbackCode = PUBLIC_CODE_BY_STATUS[error.status] || 'internal_error'
  const code = ALLOWED_CODES_BY_STATUS[error.status]?.has(suppliedCode)
    ? suppliedCode
    : fallbackCode
  const rawCorrelationId =
    rawEnvelope && typeof (rawEnvelope as { correlationId?: unknown }).correlationId === 'string'
      ? String((rawEnvelope as { correlationId: string }).correlationId)
      : ''
  const correlationId = selectPublicCorrelationId(rawCorrelationId, fallbackCorrelationId)
  const retryable = [408, 425, 429, 502, 503, 504].includes(error.status)
  const rawDetails =
    rawEnvelope && typeof (rawEnvelope as { details?: unknown }).details === 'object'
      ? ((rawEnvelope as { details: Record<string, unknown> }).details ?? undefined)
      : undefined
  const paths = code === 'access_path_required' ? safePathDescriptors(rawDetails?.paths) : undefined
  const rawReason =
    typeof rawError === 'string'
      ? rawError
      : typeof rawDetails?.reason === 'string'
        ? rawDetails.reason
        : ''
  const reason = SAFE_DOMAIN_REASONS.has(rawReason) ? rawReason : undefined
  const invalidIndexes =
    reason === 'subjects_invalid'
      ? safeInvalidIndexes(rawDetails?.invalidIndexes ?? rawBody?.invalidIndexes)
      : undefined
  const responseHeaders = error.responseHeaders ?? {}
  const headerRetryAfterSeconds = Number(responseHeaders['retry-after'])
  const rawRetryAfterSeconds =
    rawDetails?.retryAfterSeconds ??
    rawBody?.retryAfterSeconds ??
    (Number.isSafeInteger(headerRetryAfterSeconds) ? headerRetryAfterSeconds : undefined)
  const retryAfterSeconds =
    code === 'rate_limited' &&
    typeof rawRetryAfterSeconds === 'number' &&
    Number.isSafeInteger(rawRetryAfterSeconds) &&
    rawRetryAfterSeconds >= 1 &&
    rawRetryAfterSeconds <= 86_400
      ? rawRetryAfterSeconds
      : undefined
  const details = paths
    ? { paths }
    : reason || invalidIndexes || retryAfterSeconds
      ? {
          ...(reason ? { reason } : {}),
          ...(invalidIndexes ? { invalidIndexes } : {}),
          ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
        }
      : undefined
  const safeHeaders = safePublicRateLimitHeaders(responseHeaders)
  const publicHeaders =
    code === 'rate_limited'
      ? safeHeaders
      : error.status === 413
        ? safeUnsignedIntegerHeader(responseHeaders, 'upload-length')
        : retryable && safeHeaders['retry-after']
          ? { 'retry-after': safeHeaders['retry-after'] }
          : {}

  return {
    status: error.status,
    headers: publicHeaders,
    body: {
      error: {
        code,
        message: PUBLIC_MESSAGE_BY_CODE[code] || PUBLIC_MESSAGE_BY_CODE[fallbackCode],
        correlationId,
        retryable,
        ...(details ? { details } : {}),
      },
    },
  }
}

export function sanitizeSupportedControlApiPublicError(
  error: unknown,
  fallbackCorrelationId = ''
): SanitizedControlApiPublicError | null {
  return sanitizeControlApiPublicError(
    error,
    SUPPORTED_CONTROL_API_PUBLIC_STATUSES,
    fallbackCorrelationId
  )
}

export function sendSanitizedControlApiPublicError(
  res: Response,
  sanitized: SanitizedControlApiPublicError
): void {
  for (const [name, value] of Object.entries(sanitized.headers)) {
    res.setHeader(name, value)
  }
  res.status(sanitized.status).json(sanitized.body)
}

export function publicCorrelationId(req: Request): string {
  return selectPublicCorrelationId(req.header('x-correlation-id'))
}

export function sendPublicApiError(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): void {
  res.status(status).json({
    error: {
      code,
      message,
      correlationId: publicCorrelationId(req),
      retryable,
      ...(details && Object.keys(details).length ? { details } : {}),
    },
  })
}
