import { type NextFunction, type Request, type Response, Router } from 'express'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { pool } from '../../db.js'
import {
  type AuthenticatedExternalSession,
  ExternalGfsAuthorityError,
  resolveExternalGfsAuthorityForSession,
} from '../../gfs/externalAuthority.js'
import { SESSION_BACKEND_RETRY_AFTER_SECONDS } from '../../middleware/externalSessionAuth.js'
import {
  createGfsWatchOpenRateLimitCheck,
  createGfsWatchPutRateLimitCheck,
  gfsWatchOpenBucketKey,
  gfsWatchPutBucketKey,
} from '../../middleware/externalWatchRateLimit.js'
import {
  type RateLimitCheck,
  type RateLimitDecision,
  writeRateLimitDecisionHeaders,
} from '../../middleware/rateLimitMiddleware.js'
import { type Logger, rootLogger } from '../../observability/logger.js'
import {
  type ExternalSessionAuthentication,
  authenticateExternalUserSession,
} from '../../services/auth/externalSessionAuthentication.js'
import {
  type GfsKey,
  MAX_KEYS_PER_SET,
  type Uuid,
  normUid,
  parseKeys,
  positiveGeneration,
} from '../../services/gfsWatch/keys.js'
import {
  GFS_WATCH_CMD_CHANNEL,
  WATCH_CMD_PAYLOAD_LIMIT_BYTES,
  serializeWatchCmd,
} from '../../services/gfsWatch/notifySchemas.js'
import { gfsWatchProcess } from '../../services/gfsWatch/process.js'
import type { GfsWatchRegistry, WatchSocket } from '../../services/gfsWatch/registry.js'
import { step } from '../../services/gfsWatch/runtime.js'
import { isTransientInfraError } from '../../services/gfsWatch/transientInfraError.js'
import {
  EXTERNAL_GFS_WATCH_PATH,
  attachExternalGfsRequestId,
  externalGfsIngressRateLimit,
} from './gfs.js'

/** Server deadline of an open: session, limiter, admission and the open op. */
export const GFS_WATCH_OPEN_SERVER_DEADLINE_MS = 12_000
/** Server deadline of a PUT: session, limiter, authority and the NOTIFY. */
export const GFS_WATCH_PUT_SERVER_DEADLINE_MS = 3_000
const MAX_SESSION_TOKEN_LENGTH = 4096
const RETRY_AFTER_SEC = 2

const log = rootLogger.child({ module: 'external-gfs-watch' })

type WatchRequest = Request & {
  gfsRequestId?: string
  /** Aborted by the server deadline, the response closing or the request aborting. */
  watchSignal?: AbortSignal
  /** Monotonic instant at which the server deadline expires, on the registry clock for an open. */
  srvDeadline?: number
}

/** A non-2xx answer of the watch; `code` travels in the body and in `x-watch-error`. */
export type WatchErrorReply = {
  status: 400 | 401 | 403 | 405 | 409 | 426 | 429 | 503
  code: string
  retryAfterSec?: number
  noStore?: boolean
  /** The limiter decision behind a 429 or 503; its writer owns those headers. */
  rateLimit?: RateLimitDecision
}

export type ClassifyOrigin = 'session' | 'authority' | 'limiter' | 'notify'

const watchReopen = (): WatchErrorReply => ({
  status: 503,
  code: 'watch_reopen',
  retryAfterSec: RETRY_AFTER_SEC,
})

/**
 * Maps an error thrown by one step of a watch handler to its reply. An
 * authority error keeps its own status and code, an outage of the session
 * database is the session's 503, and anything else is a 503 the client
 * retries: a defect must never become a 500 the client would treat as final,
 * so it is logged here at error level instead.
 */
export function classify(error: unknown, origin: ClassifyOrigin, logger: Logger): WatchErrorReply {
  if (error instanceof ExternalGfsAuthorityError) {
    if (error.status === 503) {
      logger.warn({ err: error.cause, origin }, 'gfs watch authority unavailable')
      return {
        status: 503,
        code: error.code,
        retryAfterSec: SESSION_BACKEND_RETRY_AFTER_SECONDS,
        noStore: true,
      }
    }
    return { status: error.status, code: error.code }
  }
  if (origin === 'session' && isTransientInfraError(error)) {
    logger.warn({ err: error, origin }, 'gfs watch session backend unavailable')
    return {
      status: 503,
      code: 'session_backend_unavailable',
      retryAfterSec: SESSION_BACKEND_RETRY_AFTER_SECONDS,
      noStore: true,
    }
  }
  if (isTransientInfraError(error)) logger.warn({ err: error, origin }, 'gfs watch step failed')
  else logger.error({ err: error, origin }, 'gfs watch step failed')
  return watchReopen()
}

function clientGone(req: Request, res: Response): boolean {
  return res.writableEnded || res.destroyed || req.socket?.destroyed === true
}

/**
 * The only writer of a non-2xx watch response. Writes nothing once the
 * headers went out or the client left, so a late failure after the stream
 * started, or after a deadline reply, cannot throw ERR_HTTP_HEADERS_SENT.
 */
export function reply(req: Request, res: Response, r: WatchErrorReply): void {
  if (res.headersSent || clientGone(req, res)) return
  if (r.rateLimit) writeRateLimitDecisionHeaders(res, r.rateLimit)
  if (r.retryAfterSec !== undefined) res.setHeader('Retry-After', String(r.retryAfterSec))
  if (r.noStore) res.setHeader('Cache-Control', 'no-store')
  res.setHeader('x-watch-error', r.code)
  res.status(r.status).json({ error: r.code })
}

/** The deadline or the client won the race with a step. */
function replyAborted(req: Request, res: Response): void {
  reply(req, res, watchReopen())
}

function limiterReply(decision: RateLimitDecision): WatchErrorReply | null {
  if (decision.outcome === 'unavailable') {
    return {
      status: 503,
      code: 'rate_limit_unavailable',
      retryAfterSec: decision.retryAfterSeconds,
      rateLimit: decision,
    }
  }
  if (decision.outcome === 'denied') {
    return { status: 429, code: 'rate_limited', rateLimit: decision }
  }
  return null
}

/**
 * Every handler is mounted through this: Express 4 does not catch the
 * rejection of an async handler, and an unhandled rejection would take the
 * replica down with all its streams.
 */
export function safe(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    void (async () => {
      try {
        await handler(req, res)
      } catch (err) {
        const logger = req.log ?? log
        logger.error(
          { err, requestId: (req as WatchRequest).gfsRequestId },
          'gfs watch handler failed'
        )
        try {
          reply(req, res, watchReopen())
        } catch (replyErr) {
          logger.error({ err: replyErr }, 'gfs watch fallback reply failed')
        }
      }
    })()
  }
}

/**
 * Synchronous: arms the server deadline and composes the request's abort
 * signal before the handler awaits anything. `now` is the clock the deadline
 * is measured on; the open uses the registry's, so its op deadlines and this
 * one agree.
 */
export function watchDeadline(ms: number, now: () => number = () => performance.now()) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let srvDeadline: number
    try {
      srvDeadline = now() + ms
    } catch (err) {
      // Express would turn a synchronous throw here into a 500.
      ;(req.log ?? log).error({ err }, 'gfs watch deadline setup failed')
      reply(req, res, watchReopen())
      return
    }
    const gone = new AbortController()
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), ms)
    timer.unref?.()
    const onGone = () => {
      clearTimeout(timer)
      gone.abort()
    }
    res.once('close', onGone)
    req.once('aborted', onGone)
    const watchReq = req as WatchRequest
    watchReq.watchSignal = AbortSignal.any([deadline.signal, gone.signal])
    watchReq.srvDeadline = srvDeadline
    next()
  }
}

type Authenticated = { a: AuthenticatedExternalSession; uid: Uuid; g: number }

/** The session token, or null when missing or over 4096 characters, the bound every session route applies. */
function sessionTokenOf(req: Request): string | null {
  const token = String(req.header('x-user-session-token') || '').trim()
  return token && token.length <= MAX_SESSION_TOKEN_LENGTH ? token : null
}

/**
 * Authentication and the V1 binding, shared by the open and the PUT. Returns
 * null once it has written the reply.
 */
async function authenticateWatch(
  req: WatchRequest,
  res: Response,
  token: string,
  authenticate: typeof authenticateExternalUserSession,
  logger: Logger
): Promise<Authenticated | null> {
  const sig = req.watchSignal!
  const r = await step(
    authenticate(token, {
      purpose: 'protected',
      client: { version: req.header('x-evenfire-client-version') || undefined },
    }),
    sig
  )
  if ('aborted' in r && r.aborted) {
    replyAborted(req, res)
    return null
  }
  if (!r.ok) {
    reply(req, res, classify((r as { error: unknown }).error, 'session', logger))
    return null
  }
  const a: ExternalSessionAuthentication = r.value
  if (a.status === 'upgrade_required') {
    reply(req, res, { status: 426, code: 'upgrade_required' })
    return null
  }
  if (a.status !== 'authenticated') {
    reply(req, res, { status: 401, code: 'session_invalid' })
    return null
  }
  // The watch binds a stream to (user, authorization generation), which only
  // a V1 session carries.
  if (a.contract !== 'v1' || a.authorityContext.contract !== 'v1') {
    reply(req, res, { status: 409, code: 'session_contract_unsupported' })
    return null
  }
  const uid = normUid(a.authorityContext.userId)
  const g = positiveGeneration(a.authorityContext.authGeneration)
  if (uid === null || g === null) {
    reply(req, res, { status: 401, code: 'session_invalid' })
    return null
  }
  return { a, uid, g }
}

/** Runs one limiter check; returns false once it has written the reply. */
async function passLimiter(
  req: WatchRequest,
  res: Response,
  check: RateLimitCheck,
  key: string,
  logger: Logger
): Promise<boolean> {
  const r = await step(check(key, logger), req.watchSignal!)
  if ('aborted' in r && r.aborted) {
    replyAborted(req, res)
    return false
  }
  if (!r.ok) {
    reply(req, res, classify((r as { error: unknown }).error, 'limiter', logger))
    return false
  }
  const denied = limiterReply(r.value)
  if (denied) {
    reply(req, res, denied)
    return false
  }
  return true
}

function watchSocketOf(req: Request, res: Response): WatchSocket {
  return {
    get headersSent() {
      return res.headersSent
    },
    get writableLength() {
      return res.writableLength
    },
    writeHead: (status, headers) => res.writeHead(status, { ...headers }),
    flushHeaders: () => res.flushHeaders(),
    write: chunk => res.write(chunk),
    end: () => res.end(),
    once: (event, listener) => res.once(event, listener),
    onGone: listener => {
      res.on('close', listener)
      res.on('error', listener)
      req.on('aborted', listener)
    },
  }
}

const putBodySchema = z.object({
  connId: z.string().regex(/^[0-9a-f]{32}$/),
  seq: z.number().int().safe().positive(),
  // A client sends a set of at most MAX_KEYS_PER_SET keys, so a longer array
  // is refused before parseKeys walks it element by element.
  keys: z.array(z.unknown()).max(MAX_KEYS_PER_SET),
})

export type ExternalGfsWatchRouterDeps = {
  /** The process registry; resolved per request so building the router opens nothing. */
  registry?: () => GfsWatchRegistry
  authenticate?: typeof authenticateExternalUserSession
  resolveAuthority?: typeof resolveExternalGfsAuthorityForSession
  openLimiter?: RateLimitCheck
  putLimiter?: RateLimitCheck
  /** Publishes one command payload on `gfs_watch_cmd`. */
  notify?: (payload: string) => Promise<unknown>
  openServerDeadlineMs?: number
  putServerDeadlineMs?: number
}

/**
 * GET and PUT /external/gfs/watch: one long-lived NDJSON stream per desktop
 * process, whose subscription set the PUT changes in place by routing a
 * command to whichever replica owns the connection.
 *
 * Mounted ahead of the GFS router, which would answer this path 404 after
 * running its session and authority chain. Session, limiter and authority are
 * plain calls inside one handler, not middleware, so each response has a
 * single writer and every await runs against the request's deadline.
 */
export function createExternalGfsWatchRouter(deps: ExternalGfsWatchRouterDeps = {}): Router {
  const registry = deps.registry ?? (() => gfsWatchProcess().registry)
  const authenticate = deps.authenticate ?? authenticateExternalUserSession
  const resolveAuthority = deps.resolveAuthority ?? resolveExternalGfsAuthorityForSession
  // Built on first use, still once per router: a router built by an app that
  // never serves the watch does not create the checks.
  let openLimiterCheck = deps.openLimiter
  let putLimiterCheck = deps.putLimiter
  const openLimiter: RateLimitCheck = (key, logger) =>
    (openLimiterCheck ??= createGfsWatchOpenRateLimitCheck())(key, logger)
  const putLimiter: RateLimitCheck = (key, logger) =>
    (putLimiterCheck ??= createGfsWatchPutRateLimitCheck())(key, logger)
  const notify =
    deps.notify ??
    ((payload: string) => pool.query('SELECT pg_notify($1, $2)', [GFS_WATCH_CMD_CHANNEL, payload]))
  const openDeadlineMs = deps.openServerDeadlineMs ?? GFS_WATCH_OPEN_SERVER_DEADLINE_MS
  const putDeadlineMs = deps.putServerDeadlineMs ?? GFS_WATCH_PUT_SERVER_DEADLINE_MS

  async function openHandler(req: Request, res: Response): Promise<void> {
    const watchReq = req as WatchRequest
    const logger = req.log ?? log
    const token = sessionTokenOf(req)
    if (token === null) {
      reply(req, res, { status: 401, code: 'session_invalid' })
      return
    }
    const keys = parseKeys(req.query.k)
    if (keys === null) {
      reply(req, res, { status: 400, code: 'bad_request' })
      return
    }
    const auth = await authenticateWatch(watchReq, res, token, authenticate, logger)
    if (auth === null) return
    const reg = registry()
    if (!reg.listenerReady()) {
      reply(req, res, {
        status: 503,
        code: 'watch_listener_unavailable',
        retryAfterSec: RETRY_AFTER_SEC,
      })
      return
    }
    if (!(await passLimiter(watchReq, res, openLimiter, gfsWatchOpenBucketKey(auth.uid), logger))) {
      return
    }
    req.setTimeout(0)
    const outcome = await reg.open({
      authentication: auth.a,
      keys,
      socket: watchSocketOf(req, res),
      srvDeadline: watchReq.srvDeadline!,
      watchSignal: watchReq.watchSignal!,
      requestId: watchReq.gfsRequestId ?? randomUUID(),
    })
    switch (outcome.kind) {
      case 'stream':
      case 'none':
        return
      case 'reply':
        reply(req, res, {
          status: outcome.status,
          code: outcome.code,
          ...(outcome.retryAfterSec === undefined ? {} : { retryAfterSec: outcome.retryAfterSec }),
        })
        return
      case 'classify':
        reply(req, res, classify(outcome.error, outcome.origin, logger))
        return
    }
  }

  async function putHandler(req: Request, res: Response): Promise<void> {
    const watchReq = req as WatchRequest
    const logger = req.log ?? log
    const sig = watchReq.watchSignal!
    const token = sessionTokenOf(req)
    if (token === null) {
      reply(req, res, { status: 401, code: 'session_invalid' })
      return
    }
    const body = putBodySchema.safeParse(req.body)
    const keys: Set<GfsKey> | null = body.success ? parseKeys(body.data.keys) : null
    if (!body.success || keys === null) {
      reply(req, res, { status: 400, code: 'bad_request' })
      return
    }
    const auth = await authenticateWatch(watchReq, res, token, authenticate, logger)
    if (auth === null) return
    // Before the authority: a denied PUT must not spend its two core-pool
    // queries, the same order the GFS router keeps.
    if (!(await passLimiter(watchReq, res, putLimiter, gfsWatchPutBucketKey(auth.uid), logger))) {
      return
    }
    const authority = await step(resolveAuthority(auth.a), sig)
    if ('aborted' in authority && authority.aborted) {
      replyAborted(req, res)
      return
    }
    if (!authority.ok) {
      reply(req, res, classify((authority as { error: unknown }).error, 'authority', logger))
      return
    }
    const payload = serializeWatchCmd({
      c: body.data.connId,
      s: body.data.seq,
      u: auth.uid,
      g: auth.g,
      // The owner derives the op id of the delta from it; gfsc refuses a non-uuid.
      r: normUid(watchReq.gfsRequestId) ?? (randomUUID() as Uuid),
      keys,
    })
    if (Buffer.byteLength(payload) >= WATCH_CMD_PAYLOAD_LIMIT_BYTES) {
      reply(req, res, { status: 400, code: 'bad_request' })
      return
    }
    // An abandoned NOTIFY keeps its connection until it finishes or its
    // statement_timeout ends it; the reply does not wait for that.
    const sent = await step(notify(payload), sig)
    if ('aborted' in sent && sent.aborted) {
      replyAborted(req, res)
      return
    }
    if (!sent.ok) {
      reply(req, res, classify((sent as { error: unknown }).error, 'notify', logger))
      return
    }
    if (res.headersSent || clientGone(req, res)) return
    // Accepted for routing, not applied: the owner answers on the stream.
    res.status(202).json({ seq: body.data.seq })
  }

  function methodNotAllowed(req: Request, res: Response): void {
    res.setHeader('Allow', 'GET, PUT')
    reply(req, res, { status: 405, code: 'method_not_allowed' })
  }

  const router = Router()
  // Express answers HEAD with the GET route; without this a HEAD would open a
  // full stream. Registered first for that reason.
  router.head(EXTERNAL_GFS_WATCH_PATH, externalGfsIngressRateLimit, methodNotAllowed)
  // The ingress limiter is the process-wide instance the GFS router mounts: a
  // second instance would give each IP a second budget. Every route here
  // terminates the response, so each request is charged exactly once.
  router.get(
    EXTERNAL_GFS_WATCH_PATH,
    externalGfsIngressRateLimit,
    attachExternalGfsRequestId,
    watchDeadline(openDeadlineMs, () => registry().now()),
    safe(openHandler)
  )
  router.put(
    EXTERNAL_GFS_WATCH_PATH,
    externalGfsIngressRateLimit,
    attachExternalGfsRequestId,
    watchDeadline(putDeadlineMs),
    safe(putHandler)
  )
  // Every other method ends here too. Without it Express answers OPTIONS on
  // its own with a 200 that skips the ingress limiter, and the rest would fall
  // through to the GFS router's session chain only to reach its 404.
  router.all(EXTERNAL_GFS_WATCH_PATH, externalGfsIngressRateLimit, methodNotAllowed)
  return router
}
