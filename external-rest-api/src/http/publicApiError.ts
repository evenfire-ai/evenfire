import type { Request, Response } from 'express'

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
