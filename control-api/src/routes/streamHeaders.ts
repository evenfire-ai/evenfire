import type { Response } from 'express'

/**
 * Commits the 200 and the headers of a long-lived NDJSON stream. Proxies must
 * neither buffer (`x-accel-buffering`) nor transform it, or frames arrive late
 * and heartbeats stop proving liveness.
 */
export function setStreamHeaders(res: Response): void {
  res.status(200)
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-accel-buffering', 'no')
  res.flushHeaders?.()
}
