import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'
import { rateLimit } from 'express-rate-limit'
import { type Server, createServer } from 'node:http'
import { Registry, collectDefaultMetrics } from 'prom-client'
import { z } from 'zod'
import { verifyAdminPermit } from './auth/adminPermitVerifier.js'
import { verifyExecutionTicket } from './auth/executionTicketVerifier.js'
import { type PlatformJwtClaims, verifyPlatformJwt } from './auth/platformJwtVerifier.js'
import type { GrokLlmProxyConfig } from './config.js'
import { ControlApiClient, ControlApiClientError } from './controlApiClient.js'
import {
  GrokTransportError,
  listGrokModels,
  streamGrokCompletion,
  testGrokConnection,
} from './grokTransport.js'
import { logger } from './logger.js'
import { createProxyMetrics } from './metrics.js'
import {
  OriginDeniedError,
  type OriginPolicyOptions,
  defaultAddressLookup,
} from './originPolicy.js'
import {
  BODY_READ_DEADLINE_MS,
  BodyBudget,
  IN_FLIGHT_BODY_BUDGET_BODIES,
  RequestLimitError,
  streamGate,
} from './requestLimits.js'

type GatedRequest = Request & {
  /** Set by the platform gate before body admission (R9-M-B). */
  grokPlatform?: PlatformJwtClaims
}

const COMPLETION_PATH = '/internal/runtime/v1/grok/completions'
const COMPLETION_KEYS = new Set(['executionTicket', 'requestHash', 'request', 'deadlineMs'])
const ADMIN_KEYS = new Set(['accessToken'])

const completionBodySchema = z
  .object({
    executionTicket: z.string().min(1),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    request: z.object({}).passthrough(),
    deadlineMs: z.number().int().positive().optional(),
  })
  .strict()

const adminBodySchema = z.object({ accessToken: z.string().min(1) }).strict()

function bearer(req: Request): string {
  const raw = String(req.header('authorization') || '')
  return raw.replace(/^bearer\s+/i, '').trim()
}

function reject(res: Response, status: number, code: string): void {
  if (res.headersSent) return
  logger.warn({ event: 'grok_proxy_denied', code }, 'request denied')
  res.status(status).json({ error: code })
}

function boundedErrorHandler(err: unknown, _req: Request, res: Response, _next: () => void): void {
  const typed = err as { type?: string; status?: number }
  if (typed?.type === 'entity.too.large' || typed?.status === 413) {
    reject(res, 413, 'payload_too_large')
    return
  }
  // R9-1: the parsers run with `inflate: false`, so body-parser refuses an
  // encoded body before reading it.
  if (typed?.type === 'encoding.unsupported') {
    reject(res, 415, 'unsupported_media_type')
    return
  }
  if (err instanceof SyntaxError) {
    reject(res, 400, 'invalid_request')
    return
  }
  logger.error({ event: 'grok_proxy_error', err }, 'unhandled request error')
  reject(res, 500, 'internal_error')
}

/**
 * #731 R3-2 — memory-bounded admission around the body parser `parse`. It runs
 * after the caller's token was checked (R9-M-B), so an anonymous caller never
 * takes budget. A body is read only once its declared `Content-Length` fits
 * the shared byte budget, so the bodies in memory are bounded by bytes rather
 * than by the stream gate's request count. A `Transfer-Encoding` body is
 * refused with 411 instead of being read unbounded; a non-numeric
 * `Content-Length` is refused with 400. Bodies over the limit go to `parse`
 * without a reservation, so express.json answers 413 from the header without
 * buffering them. A granted body must be read and parsed within
 * `readDeadlineMs` of the grant, or it is answered 408 `request_timeout`, its
 * reservation released and its connection closed. Otherwise the reservation is
 * held until the response closes, which for a completion is the whole stream
 * (up to `maxStreamDurationMs`). A queued waiter is dropped if the client
 * leaves first; a full queue gets the stream gate's overload response.
 */
function bodyAdmission(
  budget: BodyBudget,
  maxBodyBytes: number,
  readDeadlineMs: number,
  parse: RequestHandler
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.headers['transfer-encoding'] !== undefined) {
      reject(res, 411, 'length_required')
      return
    }
    const declared = req.headers['content-length']
    if (declared === undefined) {
      parse(req, res, next)
      return
    }
    if (!/^\d+$/.test(declared)) {
      reject(res, 400, 'invalid_request')
      return
    }
    const bytes = Number(declared)
    if (bytes === 0 || bytes > maxBodyBytes) {
      parse(req, res, next)
      return
    }
    const abort = new AbortController()
    let release: (() => void) | undefined
    let readDeadline: ReturnType<typeof setTimeout> | undefined
    res.once('close', () => {
      clearTimeout(readDeadline)
      if (release) release()
      else abort.abort()
    })
    budget.acquire(bytes, abort.signal).then(
      granted => {
        if (abort.signal.aborted) {
          granted()
          return
        }
        release = granted
        let expired = false
        readDeadline = setTimeout(() => {
          expired = true
          granted()
          if (res.headersSent) return
          // The rest of the body is never read, so the connection cannot be reused.
          res.setHeader('connection', 'close')
          reject(res, 408, 'request_timeout')
        }, readDeadlineMs)
        parse(req, res, err => {
          clearTimeout(readDeadline)
          // The 408 already answered this request; the parser's late error
          // (the body aborted by the closed connection) has no one to reach.
          if (expired) return
          next(err)
        })
      },
      (err: unknown) => {
        if (!(err instanceof RequestLimitError)) {
          next(err)
          return
        }
        if (!abort.signal.aborted) reject(res, 503, 'provider_unavailable')
      }
    )
  }
}

export type ProxyRuntimeDeps = {
  controlApiClient?: ControlApiClient
  fetchFn?: typeof fetch
  /**
   * Test seam for the DNS half of the origin policy. Production always uses
   * `defaultAddressLookup`; hermetic e2e injects a resolver so the frozen
   * cli-chat-proxy.grok.com origin check runs without live DNS. The URL freeze in
   * `assertAllowedUpstreamUrl` is unaffected by this seam.
   */
  lookup?: OriginPolicyOptions['lookup']
  /** Test seam for the body-read deadline. Production uses `BODY_READ_DEADLINE_MS`. */
  bodyReadDeadlineMs?: number
}

export type ProxyServers = {
  runtime: Server
  admin: Server
  probe: Server
  runtimeApp: Express
  adminApp: Express
  probeApp: Express
  close: () => Promise<void>
}

export function createProxyApps(
  config: GrokLlmProxyConfig,
  deps: ProxyRuntimeDeps = {}
): ProxyServers {
  const metricsRegistry = new Registry()
  collectDefaultMetrics({ register: metricsRegistry })
  const metrics = createProxyMetrics(metricsRegistry)
  const client =
    deps.controlApiClient ??
    new ControlApiClient({
      baseUrl: config.controlApiBaseUrl,
      serviceName: config.controlApiServiceName,
      serviceToken: config.controlApiServiceToken,
    })
  const fetchFn = deps.fetchFn ?? fetch
  const lookup = deps.lookup ?? defaultAddressLookup
  const runtimeRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  const adminRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })

  // One budget for both apps: every body this process reads counts against it.
  const bodyBudget = new BodyBudget(IN_FLIGHT_BODY_BUDGET_BODIES * config.maxBodyBytes)
  const bodyReadDeadlineMs = deps.bodyReadDeadlineMs ?? BODY_READ_DEADLINE_MS

  const runtimeApp = express()
  // R9-M-B: the token is checked from the header before any budget is taken or
  // any body byte is read, so an anonymous caller cannot hold a reservation.
  // It runs after the rate limiter, so it cannot be forced ahead of the limit.
  const platformGate = (req: GatedRequest, res: Response, next: NextFunction): void => {
    const token = bearer(req)
    if (verifyAdminPermit(token, config)) {
      reject(res, 403, 'insufficient_scope')
      return
    }
    const platform = verifyPlatformJwt(token, config)
    if (!platform) {
      reject(res, 401, 'Unauthorized')
      return
    }
    req.grokPlatform = platform
    next()
  }
  // Order: rate limit, token, body admission around the parser, handler.
  // R9-1: `inflate: false` on every parser. The budget counts the declared wire
  // length, so an encoded body is refused (415) instead of inflated past it.
  const runtimeAdmission = bodyAdmission(
    bodyBudget,
    config.maxBodyBytes,
    bodyReadDeadlineMs,
    express.json({ limit: config.maxBodyBytes, inflate: false })
  )
  runtimeApp.post(COMPLETION_PATH, runtimeRateLimit, platformGate, runtimeAdmission, (req, res) => {
    const platform = (req as GatedRequest).grokPlatform
    if (!platform) {
      throw new Error('the completion route was reached without the platform gate')
    }
    if (!req.is('application/json')) {
      reject(res, 415, 'unsupported_media_type')
      return
    }
    const extra = Object.keys(req.body ?? {}).find(key => !COMPLETION_KEYS.has(key))
    if (extra) {
      reject(res, 400, 'unknown_field')
      return
    }
    const parsed = completionBodySchema.safeParse(req.body)
    if (!parsed.success) {
      reject(res, 400, 'invalid_request')
      return
    }
    if (parsed.data.deadlineMs !== undefined && parsed.data.deadlineMs > config.maxDeadlineMs) {
      reject(res, 400, 'invalid_request')
      return
    }
    const ticket = verifyExecutionTicket(parsed.data.executionTicket, config)
    if (!ticket) {
      reject(res, 403, 'ticket_invalid')
      return
    }
    if (platform.hostRefs.includes('*') || !platform.hostRefs.includes(ticket.hostRef)) {
      reject(res, 403, 'host_binding_mismatch')
      return
    }
    if (!config.executionEnabled) {
      reject(res, 404, 'disabled')
      return
    }

    void (async () => {
      let release: (() => void) | undefined
      const abort = new AbortController()
      // After express.json() the incoming request is already complete. Listening
      // to req 'close' aborts the Grok hop on every call (3–12ms canceled).
      // Abort only when the client drops the response before we finish writing.
      abortWhenClientDisconnects(req, res, abort)
      // One `grok_proxy_attempt_finished` line per attempt. Identifiers and
      // counts only: never the body, ticket, frames, tool names or arguments.
      const attempt = {
        providerAttemptId: ticket.providerAttemptId,
        hostRef: ticket.hostRef,
        model: ticket.model,
        requestHash: ticket.requestHash,
      }
      const attemptStarted = Date.now()
      let toolCalls = 0
      let textChunks = 0
      try {
        release = await streamGate.acquire(abort.signal)
        res.status(200)
        res.setHeader('content-type', 'text/event-stream')
        res.setHeader('cache-control', 'no-cache')
        const started = Date.now()
        const result = await streamGrokCompletion({
          executionTicket: parsed.data.executionTicket,
          requestHash: parsed.data.requestHash,
          request: parsed.data.request,
          deadlineMs: parsed.data.deadlineMs,
          maxDeadlineMs: Math.min(config.maxDeadlineMs, config.maxStreamDurationMs),
          ticket: {
            jti: ticket.jti,
            hostRef: ticket.hostRef,
            model: ticket.model,
            requestHash: ticket.requestHash,
            providerAttemptId: ticket.providerAttemptId,
          },
          signal: abort.signal,
          redeem: input => client.redeem(input),
          finalize: input => client.finalize(input),
          fetchFn,
          lookup,
          onFrame: frame => {
            if (frame.type === 'tool_call') toolCalls += 1
            else textChunks += 1
            return writeSseChunk(res, `data: ${JSON.stringify(frame)}\n\n`, abort.signal)
          },
        })
        res.write(
          `data: ${JSON.stringify({ type: 'done', outcome: result.outcome, ...(result.usage ? { usage: result.usage } : {}) })}\n\n`
        )
        metrics.observeAttempt(result.outcome, 'completion_stream')
        metrics.observeStream(Date.now() - started)
        const finished = {
          event: 'grok_proxy_attempt_finished',
          ...attempt,
          outcome: result.outcome,
          deliveredAs: 'sse_done',
          toolCalls,
          textChunks,
          durationMs: Date.now() - attemptStarted,
          ...(result.usage ? { usage: result.usage } : {}),
        }
        if (result.outcome === 'success') logger.info(finished, 'grok attempt finished')
        else logger.warn(finished, 'grok attempt finished')
        res.end()
      } catch (err) {
        const mapped = mapError(err)
        metrics.observeAttempt('error', 'completion_stream')
        metrics.observeAttemptFailure(failureLabel(mapped.code))
        const deliveredAs = res.headersSent ? 'sse_error' : 'http_status'
        logger.warn(
          {
            event: 'grok_proxy_attempt_finished',
            ...attempt,
            outcome: 'failed',
            code: mapped.code,
            // An invalid_request message is the contract parser's, which
            // names caller-supplied fields; the code alone is logged for it.
            ...(err instanceof GrokTransportError && err.code !== 'invalid_request'
              ? { reason: err.message, ...(err.details ? { details: err.details } : {}) }
              : {}),
            deliveredAs,
            ...(deliveredAs === 'http_status' ? { httpStatus: mapped.status } : {}),
            toolCalls,
            textChunks,
            durationMs: Date.now() - attemptStarted,
          },
          'grok attempt finished'
        )
        if (deliveredAs === 'sse_error') {
          res.write(`data: ${JSON.stringify({ type: 'error', code: mapped.code })}\n\n`)
          res.end()
          return
        }
        // Nothing was written yet, so the staged SSE headers can still be
        // replaced; res.json() keeps an existing content-type.
        res.removeHeader('cache-control')
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.status(mapped.status).json({ error: mapped.code })
      } finally {
        release?.()
      }
    })()
  })
  runtimeApp.use((_req, res) => reject(res, 404, 'not_found'))
  runtimeApp.use(boundedErrorHandler)

  const adminApp = express()
  // R9-M-B: the admin permit is checked before any budget is taken, exactly as
  // the platform JWT is on the runtime app.
  const adminGate =
    (operation: 'catalog_list' | 'connection_test') =>
    (req: Request, res: Response, next: NextFunction): void => {
      const token = bearer(req)
      if (verifyExecutionTicket(token, config)) {
        reject(res, 403, 'insufficient_scope')
        return
      }
      if (!verifyAdminPermit(token, config, operation)) {
        reject(res, 401, 'Unauthorized')
        return
      }
      next()
    }
  const adminAdmission = bodyAdmission(
    bodyBudget,
    config.maxBodyBytes,
    bodyReadDeadlineMs,
    express.json({ limit: config.maxBodyBytes, inflate: false })
  )
  const adminHandler = (kind: 'models' | 'test') => (req: Request, res: Response) => {
    if (!req.is('application/json')) {
      reject(res, 415, 'unsupported_media_type')
      return
    }
    if (!config.executionEnabled) {
      reject(res, 404, 'disabled')
      return
    }
    const extra = Object.keys(req.body ?? {}).find(key => !ADMIN_KEYS.has(key))
    if (extra) {
      reject(res, 400, 'unknown_field')
      return
    }
    const parsed = adminBodySchema.safeParse(req.body)
    if (!parsed.success) {
      reject(res, 400, 'invalid_request')
      return
    }
    void (async () => {
      try {
        if (kind === 'models') {
          const listed = await listGrokModels({
            accessToken: parsed.data.accessToken,
            fetchFn,
            lookup,
          })
          res.status(200).json(listed)
          return
        }
        const tested = await testGrokConnection({
          accessToken: parsed.data.accessToken,
          fetchFn,
          lookup,
        })
        res.status(200).json(tested)
      } catch (err) {
        const mapped = mapError(err)
        reject(res, mapped.status, mapped.code)
      }
    })()
  }
  adminApp.post(
    '/internal/admin/v1/grok/models',
    adminRateLimit,
    adminGate('catalog_list'),
    adminAdmission,
    adminHandler('models')
  )
  adminApp.post(
    '/internal/admin/v1/grok/test',
    adminRateLimit,
    adminGate('connection_test'),
    adminAdmission,
    adminHandler('test')
  )
  adminApp.use((_req, res) => reject(res, 404, 'not_found'))
  adminApp.use(boundedErrorHandler)

  const probeApp = express()
  probeApp.get('/healthz', (_req, res) => res.status(200).json({ ok: true }))
  probeApp.get('/readyz', (_req, res) => res.status(200).json({ ok: true }))
  probeApp.get('/metrics', async (_req, res) => {
    res.set('content-type', metricsRegistry.contentType)
    res.status(200).send(await metricsRegistry.metrics())
  })
  probeApp.use((_req, res) => reject(res, 404, 'not_found'))

  const runtime = createServer(runtimeApp)
  const admin = createServer(adminApp)
  const probe = createServer(probeApp)

  return {
    runtime,
    admin,
    probe,
    runtimeApp,
    adminApp,
    probeApp,
    close: async () => {
      await Promise.all([runtime, admin, probe].map(server => closeServer(server)))
    },
  }
}

export function startProxy(config: GrokLlmProxyConfig): ProxyServers {
  const servers = createProxyApps(config)
  servers.runtime.listen(config.runtimePort)
  servers.admin.listen(config.adminPort)
  servers.probe.listen(config.probePort)
  logger.info(
    {
      event: 'grok_proxy_listen',
      runtimePort: config.runtimePort,
      adminPort: config.adminPort,
      probePort: config.probePort,
    },
    'grok-llm-proxy listeners ready'
  )
  return servers
}

// Every code the proxy or control-api is known to send. The failure metric
// uses this as its label allowlist because a control-api error body is not
// bounded by the proxy.
const ATTEMPT_ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  Unauthorized: 401,
  origin_denied: 403,
  request_hash_mismatch: 403,
  ticket_invalid: 403,
  ticket_expired: 403,
  no_grant: 403,
  host_binding_mismatch: 403,
  model_not_allowed: 403,
  insufficient_scope: 403,
  disabled: 404,
  // A reserved body that was not read within BODY_READ_DEADLINE_MS (R9-M-B).
  request_timeout: 408,
  ticket_replayed: 409,
  tool_call_limit_exceeded: 422,
  tool_call_arguments_exceeded: 422,
  invalid_tool_arguments: 422,
  client_upgrade_required: 426,
  connection_unavailable: 503,
  provider_unavailable: 503,
  sse_buffer_exceeded: 503,
  invalid_receipt: 503,
  conflict: 503,
}

// A control-api code is an unbounded string, so both readers of the table must
// ignore inherited names: `ATTEMPT_ERROR_STATUS['constructor']` is a function,
// not undefined, and `??` would pass it straight to `res.status()`.
function attemptErrorStatus(code: string): number {
  return Object.hasOwn(ATTEMPT_ERROR_STATUS, code) ? ATTEMPT_ERROR_STATUS[code]! : 503
}

function failureLabel(code: string): string {
  return Object.hasOwn(ATTEMPT_ERROR_STATUS, code) ? code : 'other'
}

function mapError(err: unknown): { status: number; code: string } {
  if (err instanceof OriginDeniedError) return { status: 403, code: 'origin_denied' }
  if (err instanceof RequestLimitError) return { status: 503, code: 'provider_unavailable' }
  if (err instanceof GrokTransportError || err instanceof ControlApiClientError) {
    return { status: attemptErrorStatus(err.code), code: err.code }
  }
  return { status: 503, code: 'provider_unavailable' }
}

/**
 * Write one SSE chunk and honor socket backpressure. Returns undefined when
 * the chunk was accepted (hot path stays synchronous); otherwise a promise that
 * settles on 'drain', or when the client closes / the stream aborts so a
 * departed consumer never pins the stream slot.
 */
export function writeSseChunk(
  res: Response,
  chunk: string,
  signal: AbortSignal
): Promise<void> | undefined {
  if (res.write(chunk)) return undefined
  return new Promise<void>(resolve => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      signal.removeEventListener('abort', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted || res.destroyed) done()
  })
}

export function abortWhenClientDisconnects(
  req: Request,
  res: Response,
  abort: AbortController
): void {
  const cancel = () => {
    if (!res.writableEnded) abort.abort()
  }
  res.on('close', cancel)
  req.on('aborted', cancel)
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve())
  })
}
