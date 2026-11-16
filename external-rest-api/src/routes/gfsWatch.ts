import { type Request, type Response, Router } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { config } from '../config.js'
import {
  ControlApiError,
  ControlApiNonJsonResponseError,
  ControlApiTransportError,
  controlApiRequestWithStatus,
  controlApiStreamRequest,
} from '../controlApiClient.js'
import { extractAuthToken, requireAuth } from '../middleware/auth.js'
import {
  type GfsAuthedRequest,
  attachGfsRequestId,
  createGfsEdgeLimiter,
  relayControlApiError,
  withGfsRequestId,
} from './gfs.js'

export const GFS_WATCH_PATH = '/me/gfs/watch'
const CONTROL_API_WATCH_PATH = '/external/gfs/watch'
export const GFS_EDGE_WATCH_USER_PER_MIN = 240
const RETRY_AFTER_SEC = 2

// The statuses the watch contract gives a meaning to; every 5xx is relayed too
// so a 503's own code and Retry-After reach the client. Anything else (a 3xx,
// 404, 405, 406, 415, ...) comes from something other than the watch route and
// becomes a 503 the client retries.
const PROPAGATED = new Set([400, 401, 403, 409, 426, 429])

function isPropagated(status: number): boolean {
  return PROPAGATED.has(status) || (status >= 500 && status <= 599)
}

function clientGone(req: Request, res: Response): boolean {
  return res.writableEnded || res.destroyed || req.socket?.destroyed === true
}

/** Writes a watch error answered by this edge, in the shape control-api uses. */
function watchError(
  req: Request,
  res: Response,
  status: number,
  code: string,
  retryAfterSec?: number
): void {
  if (res.headersSent || clientGone(req, res)) return
  if (retryAfterSec !== undefined) res.setHeader('Retry-After', String(retryAfterSec))
  res.setHeader('x-watch-error', code)
  res.status(status).json({ error: code })
}

function watchReopen(req: Request, res: Response): void {
  watchError(req, res, 503, 'watch_reopen', RETRY_AFTER_SEC)
}

/**
 * The expected failures of a call to control-api. Returns false for anything
 * else, which is a defect left to `safe`. Never hands an error to Express: its
 * global handler turns a transport error into a 500 and a 3xx into a 3xx.
 */
function answerControlApiFailure(
  error: unknown,
  req: Request,
  res: Response,
  isTransport: (error: unknown) => boolean
): boolean {
  // A body that is not JSON was not written by the watch route (an HTML error
  // page of the funnel, a redirect), so its synthetic 502 is not relayed.
  if (error instanceof ControlApiNonJsonResponseError) {
    watchReopen(req, res)
    return true
  }
  if (error instanceof ControlApiError) {
    if (isPropagated(error.status)) {
      if (!res.headersSent && !clientGone(req, res)) relayControlApiError(error, res)
    } else {
      watchReopen(req, res)
    }
    return true
  }
  if (isTransport(error)) {
    watchReopen(req, res)
    return true
  }
  return false
}

/**
 * Express 4 does not catch an async handler's rejection, and forwarding it
 * would reach the global handler's 500. No path of the watch may answer 500:
 * every failure must carry a code the client knows how to handle.
 */
function safe(handler: (req: GfsAuthedRequest, res: Response) => Promise<void>) {
  return (req: GfsAuthedRequest, res: Response): void => {
    void handler(req, res).catch((error: unknown) => {
      // This service has no structured logger. Only the error's class is
      // written: a message can carry upstream URLs or request data.
      console.error(
        JSON.stringify({
          msg: 'gfs watch handler failed',
          requestId: req.gfsRequestId,
          error: error instanceof Error ? error.name : typeof error,
        })
      )
      if (res.headersSent) {
        res.destroy()
        return
      }
      watchReopen(req, res)
    })
  }
}

/**
 * fetch rejects with `TypeError('fetch failed', {cause})` when the funnel
 * cannot be reached. A TypeError that carries a `cause` (an unparsable base
 * URL among them) is treated the same way; one without it is a defect.
 */
function isFetchTransportError(error: unknown): boolean {
  return (
    error instanceof TypeError && (error.message === 'fetch failed' || error.cause !== undefined)
  )
}

/** `k` as an ordered list of strings, or null for any other shape of the query. */
function watchKeysOf(k: unknown): string[] | null {
  if (k === undefined) return []
  if (typeof k === 'string') return [k]
  if (Array.isArray(k) && k.every(item => typeof item === 'string')) return k
  return null
}

async function openHandler(req: GfsAuthedRequest, res: Response): Promise<void> {
  const keys = watchKeysOf(req.query.k)
  if (keys === null) {
    watchError(req, res, 400, 'bad_request')
    return
  }
  const abortController = new AbortController()
  const abort = () => abortController.abort()
  req.on('aborted', abort)
  const abortIfPremature = () => {
    if (!res.writableEnded) abort()
  }
  res.on('close', abortIfPremature)
  try {
    // The client may have left while the limiters ran, before the listeners
    // above existed to see it.
    if (clientGone(req, res)) return
    let upstream: globalThis.Response
    try {
      upstream = await controlApiStreamRequest(
        'GET',
        CONTROL_API_WATCH_PATH,
        withGfsRequestId(req, {
          query: { k: keys },
          userSessionToken: extractAuthToken(req),
          signal: abortController.signal,
          // A followed redirect would reach another route with the user's
          // session token and come back as its 200.
          redirect: 'manual',
        })
      )
    } catch (error) {
      if (abortController.signal.aborted || res.destroyed) return
      if (answerControlApiFailure(error, req, res, isFetchTransportError)) return
      throw error
    }
    if (!upstream.body) {
      watchReopen(req, res)
      return
    }
    res.status(upstream.status)
    res.setHeader(
      'content-type',
      upstream.headers.get('content-type') || 'application/x-ndjson; charset=utf-8'
    )
    res.setHeader(
      'cache-control',
      upstream.headers.get('cache-control') || 'no-cache, no-transform'
    )
    res.setHeader('connection', 'keep-alive')
    res.setHeader('x-accel-buffering', 'no')
    res.flushHeaders()
    try {
      await pipeline(
        Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>),
        res,
        { signal: abortController.signal }
      )
    } catch (error) {
      if (abortController.signal.aborted || res.destroyed) return
      throw error
    }
  } finally {
    req.off('aborted', abort)
    res.off('close', abortIfPremature)
  }
}

async function putHandler(req: GfsAuthedRequest, res: Response): Promise<void> {
  let result: { data: unknown; status: number }
  try {
    result = await controlApiRequestWithStatus<unknown>(
      'PUT',
      CONTROL_API_WATCH_PATH,
      withGfsRequestId(req, {
        body: req.body,
        userSessionToken: extractAuthToken(req),
        redirect: 'manual',
      })
    )
  } catch (error) {
    if (answerControlApiFailure(error, req, res, e => e instanceof ControlApiTransportError)) {
      return
    }
    throw error
  }
  if (res.headersSent || clientGone(req, res)) return
  res.status(result.status).json(result.data)
}

function methodNotAllowed(req: Request, res: Response): void {
  res.setHeader('Allow', 'GET, PUT')
  watchError(req, res, 405, 'method_not_allowed')
}

/**
 * GET and PUT /me/gfs/watch, relayed to control-api's watch.
 *
 * Mounted ahead of the GFS router so it does not inherit that router's
 * `/me/gfs` buckets: the process-wide aggregate one would make tab switches
 * and the reopens of a rollout compete with GFS reads and writes. Its own
 * per-IP bucket runs before the JWT work, as there; control-api keeps the
 * authoritative per-principal budgets.
 */
export function createGfsWatchRouter(): Router {
  const router = Router()
  const ipLimiter = createGfsEdgeLimiter(config.externalGfsEdgeAuthenticatedIpRlPerMin, 'watch-ip')
  const userLimiter = createGfsEdgeLimiter(GFS_EDGE_WATCH_USER_PER_MIN, 'watch-user', {
    keyGenerator: req => (req as GfsAuthedRequest).auth!.userId,
  })
  // Express answers HEAD with the GET route, which would open a full stream
  // upstream. Registered first for that reason.
  router.head(GFS_WATCH_PATH, attachGfsRequestId, ipLimiter, methodNotAllowed)
  router.get(
    GFS_WATCH_PATH,
    attachGfsRequestId,
    ipLimiter,
    requireAuth,
    userLimiter,
    safe(openHandler)
  )
  router.put(
    GFS_WATCH_PATH,
    attachGfsRequestId,
    ipLimiter,
    requireAuth,
    userLimiter,
    safe(putHandler)
  )
  // Any other method would otherwise fall through to the GFS router's chain.
  router.all(GFS_WATCH_PATH, attachGfsRequestId, ipLimiter, methodNotAllowed)
  return router
}
