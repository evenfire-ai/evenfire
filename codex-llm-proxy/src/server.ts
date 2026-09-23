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
import {
  CodexTransportError,
  listCodexModels,
  streamCodexCompletion,
  testCodexConnection,
} from './codexTransport.js'
import type { CodexLlmProxyConfig } from './config.js'
import { ControlApiClient, ControlApiClientError } from './controlApiClient.js'
import { logger } from './logger.js'
import { createProxyMetrics } from './metrics.js'
import {
  OriginDeniedError,
  type OriginPolicyOptions,
  defaultAddressLookup,
} from './originPolicy.js'
import {
  LIMITS,
  SCHEMA_VERSION_V2,
  measureNonImageCompletionBytes,
  requestBodyLimitBytes,
} from '@clerum/llm-provider-attempt-contract'
import {
  BODY_READ_DEADLINE_MS,
  BodyBudget,
  ENVELOPE_ALLOWANCE_BYTES,
  IN_FLIGHT_BODY_BUDGET_BODIES,
  RequestLimitError,
  streamGate,
  visualStreamGate,
} from './requestLimits.js'

type GatedRequest = Request & {
  codexStreamRelease?: () => void
  /** Set by the platform gate before body admission (R9-M-B). */
  codexPlatform?: PlatformJwtClaims
}

const COMPLETION_KEYS = new Set(['executionTicket', 'requestHash', 'request', 'deadlineMs'])
const ADMIN_KEYS = new Set(['accessToken'])
const COMPLETION_PATH = '/internal/runtime/v1/codex/completions'

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

function contentLengthBytes(req: Request): number | null {
  const header = req.headers['content-length']
  if (typeof header !== 'string' || !/^[0-9]+$/.test(header)) return null
  const value = Number(header)
  return Number.isSafeInteger(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function reject(res: Response, status: number, code: string): void {
  if (res.headersSent) return
  logger.warn({ event: 'codex_proxy_denied', code }, 'request denied')
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
  logger.error({ event: 'codex_proxy_error', err }, 'unhandled request error')
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
 * without a reservation: on the admin app express.json answers 413 from the
 * header without buffering them, and on the runtime app
 * `selectTransportBudget` either answers 413 or admits them through the visual
 * gate. A granted body must be read and parsed within `readDeadlineMs` of the
 * grant, or it is answered 408 `request_timeout`, its reservation released and
 * its connection closed. Otherwise the reservation is held until the response
 * closes, which for a completion is the whole stream (up to
 * `maxStreamDurationMs`). A queued waiter is dropped if the client leaves
 * first; a full queue gets the stream gate's overload response.
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
   * chatgpt.com origin check runs without live DNS. The URL freeze in
   * `assertAllowedUpstreamUrl` is unaffected by this seam.
   */
  lookup?: OriginPolicyOptions['lookup']
  /** Test seam: hang or observe a stream without contacting ChatGPT. */
  streamCompletion?: typeof streamCodexCompletion
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
  config: CodexLlmProxyConfig,
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
  // R9-1: `inflate: false` on every parser. The budgets count the declared wire
  // length, so an encoded body is refused (415) instead of inflated past it.
  const ordinaryJson = express.json({ limit: config.maxBodyBytes, inflate: false })
  const visualJson = express.json({ limit: config.maxVisualBodyBytes, inflate: false })
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
    req.codexPlatform = platform
    next()
  }
  // The parser behind body admission. Every request here carries a verified
  // platform JWT.
  //
  // schemaVersion is not known until the body is parsed, so the visual gate
  // must not be taken for every platform JWT. Only a declared Content-Length
  // above the ordinary cap can be a visual envelope. Those bodies take the
  // 2-wide gate (the image bytes stay resident for the ChatGPT stream). Every
  // smaller body, including every valid V1, stays on the ordinary parser and
  // later the 8-wide stream gate. A missing length cannot be upgraded: it is
  // parsed at the ordinary cap, so a chunked caller cannot occupy a visual slot.
  const selectTransportBudget = (req: GatedRequest, res: Response, next: NextFunction): void => {
    const declared = contentLengthBytes(req)
    if (declared !== null && declared > config.maxVisualBodyBytes) {
      reject(res, 413, 'payload_too_large')
      return
    }
    if (declared === null || declared <= config.maxBodyBytes) {
      ordinaryJson(req, res, next)
      return
    }
    void (async () => {
      let release: (() => void) | undefined
      const parseAbort = new AbortController()
      const abortParse = (): void => parseAbort.abort()
      req.once('aborted', abortParse)
      try {
        release = await visualStreamGate.acquire(parseAbort.signal)
      } catch (err) {
        req.off('aborted', abortParse)
        if (err instanceof RequestLimitError) {
          reject(res, 503, err.code)
          return
        }
        next()
        return
      }
      req.off('aborted', abortParse)
      req.codexStreamRelease = release
      visualJson(req, res, err => {
        if (err) {
          req.codexStreamRelease?.()
          req.codexStreamRelease = undefined
          next(err)
          return
        }
        next()
      })
    })()
  }
  // Order: rate limit, token, body admission around the parser, handler.
  const runtimeAdmission = bodyAdmission(
    bodyBudget,
    config.maxBodyBytes,
    bodyReadDeadlineMs,
    selectTransportBudget
  )
  runtimeApp.post(COMPLETION_PATH, runtimeRateLimit, platformGate, runtimeAdmission, (req, res) => {
    const gated = req as GatedRequest
    const releaseAdmission = (): void => {
      gated.codexStreamRelease?.()
      gated.codexStreamRelease = undefined
    }
    const platform = gated.codexPlatform
    if (!platform) {
      releaseAdmission()
      throw new Error('the completion route was reached without the platform gate')
    }
    if (!req.is('application/json')) {
      releaseAdmission()
      reject(res, 415, 'unsupported_media_type')
      return
    }
    const request = isRecord(req.body) ? req.body.request : undefined
    const visualDeclared = isRecord(request) && request.schemaVersion === SCHEMA_VERSION_V2
    const configuredLimit = visualDeclared ? config.maxVisualBodyBytes : config.maxBodyBytes
    const wholeBodyBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8')
    // A V1 envelope carries the ticket, the hash and the deadline beside a
    // request that may itself sit at the contract cap (#731), so its limit adds
    // the envelope allowance. A V2 envelope stays on the contract's visual
    // ceiling, the same one buildCodexProxyEnvelope enforces.
    const envelopeLimit = visualDeclared
      ? requestBodyLimitBytes(request)
      : requestBodyLimitBytes(request) + ENVELOPE_ALLOWANCE_BYTES
    // Declaring V2 raises only the image budget. Text, tools and wrapper
    // fields stay on the contract's maxRequestBodyBytes non-image ceiling, plus
    // the same envelope allowance control-api's authorizer grants its wrapper.
    if (
      wholeBodyBytes > Math.min(configuredLimit, envelopeLimit) ||
      measureNonImageCompletionBytes(req.body) > LIMITS.maxRequestBodyBytes + ENVELOPE_ALLOWANCE_BYTES
    ) {
      releaseAdmission()
      reject(res, 413, 'payload_too_large')
      return
    }
    const extra = Object.keys(req.body ?? {}).find(key => !COMPLETION_KEYS.has(key))
    if (extra) {
      releaseAdmission()
      reject(res, 400, 'unknown_field')
      return
    }
    const parsed = completionBodySchema.safeParse(req.body)
    if (!parsed.success) {
      releaseAdmission()
      reject(res, 400, 'invalid_request')
      return
    }
    if (parsed.data.deadlineMs !== undefined && parsed.data.deadlineMs > config.maxDeadlineMs) {
      releaseAdmission()
      reject(res, 400, 'invalid_request')
      return
    }
    const ticket = verifyExecutionTicket(parsed.data.executionTicket, config)
    if (!ticket) {
      releaseAdmission()
      reject(res, 403, 'ticket_invalid')
      return
    }
    if (platform.hostRefs.includes('*') || !platform.hostRefs.includes(ticket.hostRef)) {
      releaseAdmission()
      reject(res, 403, 'host_binding_mismatch')
      return
    }
    if (!config.executionEnabled) {
      releaseAdmission()
      reject(res, 404, 'disabled')
      return
    }

    void (async () => {
      let release: (() => void) | undefined
      const abort = new AbortController()
      // After express.json() the incoming request is already complete. Listening
      // to req 'close' aborts the ChatGPT hop on every call (3–12ms canceled).
      // Abort only when the client drops the response before we finish writing.
      abortWhenClientDisconnects(req, res, abort)
      const visualRequest =
        (parsed.data.request as { schemaVersion?: unknown }).schemaVersion === SCHEMA_VERSION_V2
      // One `codex_proxy_attempt_finished` line per attempt. Identifiers and
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
        // A visual slot exists only when Content-Length exceeded the ordinary
        // cap. Keep it for the ChatGPT stream only when the parsed V2 body still
        // exceeds that cap (image bytes stay resident). Padding, V1, and small
        // V2 release it and take the 8-wide gate.
        if (visualRequest && wholeBodyBytes > config.maxBodyBytes) {
          release = gated.codexStreamRelease
          gated.codexStreamRelease = undefined
        } else {
          releaseAdmission()
        }
        if (!release) {
          release = await streamGate.acquire(abort.signal)
        }
        res.status(200)
        res.setHeader('content-type', 'text/event-stream')
        res.setHeader('cache-control', 'no-cache')
        const started = Date.now()
        const stream = deps.streamCompletion ?? streamCodexCompletion
        const result = await stream({
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
          event: 'codex_proxy_attempt_finished',
          ...attempt,
          outcome: result.outcome,
          deliveredAs: 'sse_done',
          toolCalls,
          textChunks,
          durationMs: Date.now() - attemptStarted,
          ...(result.usage ? { usage: result.usage } : {}),
        }
        if (result.outcome === 'success') logger.info(finished, 'codex attempt finished')
        else logger.warn(finished, 'codex attempt finished')
        res.end()
      } catch (err) {
        const mapped = mapError(err)
        metrics.observeAttempt('error', 'completion_stream')
        metrics.observeAttemptFailure(failureLabel(mapped.code))
        const deliveredAs = res.headersSent ? 'sse_error' : 'http_status'
        logger.warn(
          {
            event: 'codex_proxy_attempt_finished',
            ...attempt,
            outcome: 'failed',
            code: mapped.code,
            // An invalid_request message is the contract parser's, which
            // names caller-supplied fields; the code alone is logged for it.
            ...(err instanceof CodexTransportError && err.code !== 'invalid_request'
              ? { reason: err.message, ...(err.details ? { details: err.details } : {}) }
              : {}),
            deliveredAs,
            ...(deliveredAs === 'http_status' ? { httpStatus: mapped.status } : {}),
            toolCalls,
            textChunks,
            durationMs: Date.now() - attemptStarted,
          },
          'codex attempt finished'
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
          const listed = await listCodexModels({
            accessToken: parsed.data.accessToken,
            fetchFn,
            lookup,
          })
          res.status(200).json(listed)
          return
        }
        const tested = await testCodexConnection({
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
    '/internal/admin/v1/codex/models',
    adminRateLimit,
    adminGate('catalog_list'),
    adminAdmission,
    adminHandler('models')
  )
  adminApp.post(
    '/internal/admin/v1/codex/test',
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

export function startProxy(config: CodexLlmProxyConfig): ProxyServers {
  const servers = createProxyApps(config)
  servers.runtime.listen(config.runtimePort)
  servers.admin.listen(config.adminPort)
  servers.probe.listen(config.probePort)
  logger.info(
    {
      event: 'codex_proxy_listen',
      runtimePort: config.runtimePort,
      adminPort: config.adminPort,
      probePort: config.probePort,
    },
    'codex-llm-proxy listeners ready'
  )
  return servers
}

// Every code the proxy or control-api is known to send. The failure metric
// uses this as its label allowlist because a control-api error body is not
// bounded by the proxy.
const ATTEMPT_ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  // The upstream's own status class for a request over the context window (#731).
  context_length_exceeded: 400,
  payload_too_large: 413,
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
  invalid_tool_arguments: 422,
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
  if (err instanceof CodexTransportError || err instanceof ControlApiClientError) {
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
