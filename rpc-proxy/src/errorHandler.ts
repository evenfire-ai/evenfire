import type { NextFunction, Request, Response } from 'express'
import { respondAuthenticationFailure } from './routes/rpc.js'
import { respondControlApiAuthorityUnavailable } from './services/hostAccessDenial.js'
import { UpstreamBodyReadError } from './services/upstreamBody.js'
import { describeErrorForLog, isUpstreamTimeoutError } from './services/wakeAndHold.js'

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
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (respondControlApiAuthorityUnavailable(res, err)) return
  if (respondAuthenticationFailure(res, err)) return

  if (isUpstreamTimeoutError(err)) {
    res.status(504).json({ error: 'Gateway Timeout' })
    return
  }

  // The upstream answered with headers and its body then failed: a gateway
  // failure on a request the host received, never an rpc-proxy fault (500).
  if (err instanceof UpstreamBodyReadError) {
    res.status(502).json({ error: 'Upstream host unavailable' })
    return
  }

  if (isEntityTooLargeError(err)) {
    res.status(413).json({ error: 'Payload Too Large' })
    return
  }

  // An unclassified error is an rpc-proxy fault. Its message can carry an
  // upstream body (UpstreamHostError embeds up to 300 characters of the Host
  // answer) or a parser excerpt of the request, so it reaches neither the
  // client nor the log: the log line names the declared route and the error by
  // name, status and code only.
  const route = (req.route as { path?: unknown } | undefined)?.path
  console.error(
    `[RPC_PROXY] unhandled route error method=${req.method} route=${
      typeof route === 'string' ? route : 'unmatched'
    } error=${describeErrorForLog(err)}`
  )
  res.status(500).json({ error: 'Internal Server Error' })
}
