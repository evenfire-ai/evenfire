import type { NextFunction, Request, Response } from 'express'
import { isUpstreamTimeoutError } from './services/wakeAndHold.js'

/**
 * body-parser flags a request whose declared/streamed body crossed the parser's
 * `limit` with `type: 'entity.too.large'`. The terminal error handler below
 * would otherwise report it as a 500, which reads like a server fault for what
 * is a client-sized payload; mcp-host answers the same condition with 413.
 */
function isEntityTooLargeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: unknown }).type === 'entity.too.large'
  )
}

/**
 * The app's terminal Express error handler. It lives in its own module so route
 * tests mount this very function instead of a copy of its 504 mapping: a test
 * app that re-implements the mapping keeps passing after production changes it.
 */
export function apiErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (isUpstreamTimeoutError(err)) {
    res.status(504).json({ error: 'Gateway Timeout' })
    return
  }

  if (isEntityTooLargeError(err)) {
    res.status(413).json({ error: 'Payload Too Large' })
    return
  }

  res.status(500).json({
    error: 'Internal Server Error',
    message: err instanceof Error ? err.message : 'Unknown error',
  })
}
