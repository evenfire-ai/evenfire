import express, { type Express, type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { createServer, type Server } from 'node:http'
import { Registry, collectDefaultMetrics } from 'prom-client'
import { z } from 'zod'
import { verifyAdminPermit } from './auth/adminPermitVerifier.js'
import { verifyExecutionTicket } from './auth/executionTicketVerifier.js'
import { verifyPlatformJwt } from './auth/platformJwtVerifier.js'
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
  defaultAddressLookup,
  OriginDeniedError,
  type OriginPolicyOptions,
} from './originPolicy.js'
import { RequestLimitError, streamGate } from './requestLimits.js'

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
  logger.warn({ event: 'codex_proxy_denied', code }, 'request denied')
  res.status(status).json({ error: code })
}

function boundedErrorHandler(err: unknown, _req: Request, res: Response, _next: () => void): void {
  const typed = err as { type?: string; status?: number }
  if (typed?.type === 'entity.too.large' || typed?.status === 413) {
    reject(res, 413, 'payload_too_large')
    return
  }
  if (err instanceof SyntaxError) {
    reject(res, 400, 'invalid_request')
    return
  }
  logger.error({ event: 'codex_proxy_error', err }, 'unhandled request error')
  reject(res, 500, 'internal_error')
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

export function createProxyApps(config: CodexLlmProxyConfig, deps: ProxyRuntimeDeps = {}): ProxyServers {
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

  const runtimeApp = express()
  runtimeApp.use(express.json({ limit: config.maxBodyBytes }))
  runtimeApp.post('/internal/runtime/v1/codex/completions', runtimeRateLimit, (req, res) => {
    if (!req.is('application/json')) {
      reject(res, 415, 'unsupported_media_type')
      return
    }
    if (verifyAdminPermit(bearer(req), config)) {
      reject(res, 403, 'insufficient_scope')
      return
    }
    const platform = verifyPlatformJwt(bearer(req), config)
    if (!platform) {
      reject(res, 401, 'Unauthorized')
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
      // to req 'close' aborts the ChatGPT hop on every call (3–12ms canceled).
      // Abort only when the client drops the response before we finish writing.
      abortWhenClientDisconnects(req, res, abort)
      try {
        release = await streamGate.acquire()
        res.status(200)
        res.setHeader('content-type', 'text/event-stream')
        res.setHeader('cache-control', 'no-cache')
        const started = Date.now()
        const result = await streamCodexCompletion({
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
            res.write(`data: ${JSON.stringify(frame)}\n\n`)
          },
        })
        res.write(
          `data: ${JSON.stringify({ type: 'done', outcome: result.outcome, ...(result.usage ? { usage: result.usage } : {}) })}\n\n`
        )
        metrics.observeAttempt(result.outcome, 'completion_stream')
        metrics.observeStream(Date.now() - started)
        res.end()
      } catch (err) {
        const mapped = mapError(err)
        metrics.observeAttempt('error', 'completion_stream')
        if (res.headersSent) {
          res.write(`data: ${JSON.stringify({ type: 'error', code: mapped.code })}\n\n`)
          res.end()
          return
        }
        reject(res, mapped.status, mapped.code)
      } finally {
        release?.()
      }
    })()
  })
  runtimeApp.use((_req, res) => reject(res, 404, 'not_found'))
  runtimeApp.use(boundedErrorHandler)

  const adminApp = express()
  adminApp.use(express.json({ limit: config.maxBodyBytes }))
  const adminHandler = (kind: 'models' | 'test') => (req: Request, res: Response) => {
    if (!req.is('application/json')) {
      reject(res, 415, 'unsupported_media_type')
      return
    }
    if (verifyExecutionTicket(bearer(req), config)) {
      reject(res, 403, 'insufficient_scope')
      return
    }
    if (!verifyAdminPermit(bearer(req), config, kind === 'models' ? 'catalog_list' : 'connection_test')) {
      reject(res, 401, 'Unauthorized')
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
  adminApp.post('/internal/admin/v1/codex/models', adminRateLimit, adminHandler('models'))
  adminApp.post('/internal/admin/v1/codex/test', adminRateLimit, adminHandler('test'))
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

function mapError(err: unknown): { status: number; code: string } {
  if (err instanceof OriginDeniedError) return { status: 403, code: 'origin_denied' }
  if (err instanceof RequestLimitError) return { status: 503, code: 'provider_unavailable' }
  if (err instanceof CodexTransportError || err instanceof ControlApiClientError) {
    const statusByCode: Record<string, number> = {
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
      ticket_replayed: 409,
      connection_unavailable: 503,
      provider_unavailable: 503,
    }
    return { status: statusByCode[err.code] ?? 503, code: err.code }
  }
  return { status: 503, code: 'provider_unavailable' }
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
