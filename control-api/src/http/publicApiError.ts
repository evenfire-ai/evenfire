import type { Request, Response } from 'express'

export type PublicApiErrorCode =
  | 'invalid_session'
  | 'session_expired'
  | 'session_revoked'
  | 'forbidden'
  | 'not_found'
  | 'access_path_required'
  | 'access_path_stale'
  | 'authority_unavailable'
  | 'invalid_request'
  | 'rate_limited'

function fallbackCorrelationId(): string {
  return Math.random().toString(36).slice(2, 12)
}

export function publicApiErrorBody(
  correlationId: string,
  code: PublicApiErrorCode,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>
) {
  return {
    error: {
      code,
      message,
      correlationId,
      retryable,
      ...(details && Object.keys(details).length > 0 ? { details } : {}),
    },
  }
}

export function sendPublicApiError(
  req: Request,
  res: Response,
  status: number,
  code: PublicApiErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): void {
  res
    .status(status)
    .json(
      publicApiErrorBody(
        req.correlationId ?? fallbackCorrelationId(),
        code,
        message,
        retryable,
        details
      )
    )
}
