import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { ControlApiError } from '../controlApiClient.js'

const PUBLIC_CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'invalid_request',
  401: 'invalid_session',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  412: 'precondition_failed',
  422: 'invalid_request',
  429: 'rate_limited',
  500: 'internal_error',
  502: 'upstream_unavailable',
  503: 'authority_unavailable',
  504: 'upstream_timeout',
}

const PUBLIC_MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  invalid_request: 'The request is not valid.',
  invalid_session: 'The session is not valid.',
  session_revoked: 'The session is not valid.',
  forbidden: 'The requested operation is not allowed.',
  not_found: 'The resource was not found.',
  conflict: 'The request conflicts with current state.',
  access_path_required: 'Choose an access path for this operation.',
  access_path_stale: 'The access path is stale; refresh access before retrying.',
  gone: 'The resource is no longer available.',
  precondition_failed: 'The request precondition did not match current state.',
  rate_limited: 'Too many requests; retry later.',
  internal_error: 'The request could not be completed.',
  upstream_unavailable: 'The upstream service is temporarily unavailable.',
  authority_unavailable: 'Authorization is temporarily unavailable.',
  upstream_timeout: 'The upstream service timed out.',
}

const ALLOWED_CODES_BY_STATUS: Readonly<Record<number, ReadonlySet<string>>> = {
  400: new Set(['invalid_request']),
  401: new Set(['invalid_session', 'session_revoked']),
  403: new Set(['forbidden']),
  404: new Set(['not_found']),
  409: new Set(['conflict', 'access_path_required', 'access_path_stale']),
  410: new Set(['gone']),
  412: new Set(['precondition_failed']),
  422: new Set(['invalid_request']),
  429: new Set(['rate_limited']),
  500: new Set(['internal_error']),
  502: new Set(['upstream_unavailable']),
  503: new Set(['authority_unavailable']),
  504: new Set(['upstream_timeout']),
}

type PublicPathDescriptor = { id: string; kind: 'direct' | 'team'; teamId?: string }

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
  propagatedStatuses: ReadonlySet<number>
): { status: number; body: Record<string, unknown> } | null {
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
      : ''
  const fallbackCode = PUBLIC_CODE_BY_STATUS[error.status] || 'internal_error'
  const code = ALLOWED_CODES_BY_STATUS[error.status]?.has(suppliedCode)
    ? suppliedCode
    : fallbackCode
  const rawCorrelationId =
    rawEnvelope && typeof (rawEnvelope as { correlationId?: unknown }).correlationId === 'string'
      ? String((rawEnvelope as { correlationId: string }).correlationId)
      : ''
  const correlationId = /^[A-Za-z0-9_-]{1,128}$/.test(rawCorrelationId)
    ? rawCorrelationId
    : randomUUID()
  const retryable = [429, 502, 503, 504].includes(error.status)
  const rawDetails =
    rawEnvelope && typeof (rawEnvelope as { details?: unknown }).details === 'object'
      ? ((rawEnvelope as { details: Record<string, unknown> }).details ?? undefined)
      : undefined
  const paths = code === 'access_path_required' ? safePathDescriptors(rawDetails?.paths) : undefined
  const rawRetryAfterSeconds = rawDetails?.retryAfterSeconds ?? rawBody?.retryAfterSeconds
  const retryAfterSeconds =
    code === 'rate_limited' &&
    typeof rawRetryAfterSeconds === 'number' &&
    Number.isSafeInteger(rawRetryAfterSeconds) &&
    rawRetryAfterSeconds >= 1 &&
    rawRetryAfterSeconds <= 86_400
      ? rawRetryAfterSeconds
      : undefined

  return {
    status: error.status,
    body: {
      error: {
        code,
        message: PUBLIC_MESSAGE_BY_CODE[code] || PUBLIC_MESSAGE_BY_CODE[fallbackCode],
        correlationId,
        retryable,
        ...(paths
          ? { details: { paths } }
          : retryAfterSeconds
            ? { details: { retryAfterSeconds } }
            : {}),
      },
    },
  }
}

export function publicCorrelationId(req: Request): string {
  return (
    String(req.header('x-correlation-id') || '').trim() || Math.random().toString(36).slice(2, 12)
  )
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
