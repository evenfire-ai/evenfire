import type { Response } from 'express'

/**
 * Headers of a long-lived NDJSON stream. Proxies must neither buffer
 * (`x-accel-buffering`) nor transform it, or frames arrive late and heartbeats
 * stop proving liveness.
 */
export const STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
})

/** Commits the 200 and the stream headers. */
export function setStreamHeaders(res: Response): void {
  res.status(200)
  for (const [name, value] of Object.entries(STREAM_HEADERS)) res.setHeader(name, value)
  res.flushHeaders?.()
}
