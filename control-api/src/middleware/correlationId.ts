import { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { type Logger, rootLogger } from '../observability/logger.js'

/**
 * x-correlation-id propagation middleware.
 *
 * Behaviour:
 *  - Reads incoming `x-correlation-id` header; if absent, generates a UUIDv4.
 *  - Exposes the id on `req.correlationId` for downstream handlers.
 *  - Echoes the id on the response via `res.setHeader('x-correlation-id', id)`.
 *  - Builds a child logger `req.log` so every log line in the request scope
 *    carries the correlation id.
 *
 * Outbound propagation:
 *  - Downstream axios/fetch clients should forward `req.correlationId` as the
 *    `x-correlation-id` header when calling other services.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId?: string
      log?: Logger
    }
  }
}

// UUIDv4 regex. Accept any v1-v5 UUID loosely; reject anything else to avoid
// propagating attacker-controlled arbitrary strings.
const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const headerValue = req.header('x-correlation-id')
  const trimmed = typeof headerValue === 'string' ? headerValue.trim() : ''
  const incoming = trimmed && UUID_ANY_RE.test(trimmed) ? trimmed : null

  const id = incoming ?? randomUUID()
  req.correlationId = id
  res.setHeader('x-correlation-id', id)

  req.log = rootLogger.child({ correlationId: id })
  next()
}
