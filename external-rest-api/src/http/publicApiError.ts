import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'

const SAFE_PUBLIC_CORRELATION_ID = /^[A-Za-z0-9_-]{1,128}$/

export function selectPublicCorrelationId(...candidates: readonly unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    if (SAFE_PUBLIC_CORRELATION_ID.test(candidate)) return candidate
  }
  return randomUUID()
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
  retryable = false
): void {
  res.status(status).json({
    error: {
      code,
      message,
      correlationId: publicCorrelationId(req),
      retryable,
    },
  })
}
