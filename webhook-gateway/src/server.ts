import http, { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readRawBody } from './bodyReader'
import { WEBHOOK_ID_RE, type RuntimeBudgets, type ServerOptions } from './config'
import { forwardVerified } from './forwarder'
import {
  type HandshakeOutcome,
  handleHandshakePostVerify,
  handleHandshakePreVerify,
} from './handshake'
import { buildForwardHeaders } from './headers'
import type { Metrics } from './metrics'
import type { GatewayConfig, WebhookConfigEntry } from './types'
import { verify } from './verifier'

export interface ServerContext {
  config: GatewayConfig
  metrics: Metrics
  recipeNamespace: string
  recipeName: string
  budgets: RuntimeBudgets
  options: ServerOptions
}

/** Bind both HTTP listeners. Returns close() that stops them cleanly. */
export function start(ctx: ServerContext): { close: () => Promise<void> } {
  const httpServer = createHttpServer(ctx)
  const metricsServer = createMetricsServer(ctx)
  httpServer.listen(ctx.options.httpPort)
  metricsServer.listen(ctx.options.metricsPort)
  log(ctx, `listening: http=:${ctx.options.httpPort} metrics=:${ctx.options.metricsPort}`)
  return {
    close: async () => {
      await Promise.all([closeServer(httpServer), closeServer(metricsServer)])
    },
  }
}

function createHttpServer(ctx: ServerContext): Server {
  const server = http.createServer((req, res) => {
    handleHttp(ctx, req, res).catch(err => {
      log(ctx, `unhandled error: ${err instanceof Error ? err.stack : err}`)
      if (!res.headersSent) {
        respondJson(res, 500, { error: 'internal_error' })
      } else if (!res.writableEnded) {
        res.end()
      }
    })
  })
  // Apply slowloris budgets at the server level so they fire even when no
  // route handler is invoked (e.g. attacker holds the headers indefinitely).
  server.headersTimeout = ctx.budgets.headerTimeoutMs
  server.requestTimeout = ctx.budgets.totalTimeoutMs
  // Keep-alive timeout matches body-idle; idle keep-alive connections shouldn't
  // be holding our in-flight slots open.
  server.keepAliveTimeout = ctx.budgets.bodyIdleTimeoutMs
  return server
}

function createMetricsServer(ctx: ServerContext): Server {
  return http.createServer((req, res) => {
    const url = req.url || '/'
    if (url === '/healthz' || url === '/readyz') {
      respondJson(res, 200, { ok: true })
      return
    }
    if (url === '/metrics' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      res.end(ctx.metrics.toPrometheus())
      return
    }
    respondJson(res, 404, { error: 'not_found' })
  })
}

async function handleHttp(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // /healthz also lives on the http port for k8s probes that don't separate ports.
  if (req.url === '/healthz' || req.url === '/readyz') {
    respondJson(res, 200, { ok: true })
    return
  }

  // Route shape: ANY /:webhookId
  const webhookId = parseWebhookIdFromUrl(req.url || '')
  if (webhookId === null || !WEBHOOK_ID_RE.test(webhookId)) {
    // must-fix #2: revalidate webhookId regex BEFORE any config lookup.
    ctx.metrics.recordRequest(webhookId ?? '<bad>', 400)
    respondJson(res, 400, { error: 'invalid_webhook_id' })
    return
  }

  const entry = ctx.config.webhooks[webhookId]
  if (!entry) {
    ctx.metrics.recordRequest(webhookId, 404)
    respondJson(res, 404, { error: 'webhook_not_found' })
    return
  }

  // Dormant short-circuit (Phase 2 / §4.1.1 equivalent for webhooks): the
  // recipe marked this webhook `optional: true` and the referenced Secret
  // was missing at reconcile time. Reply 410 Gone — terminal for providers
  // like Meta/Fireflies so they don't fill our logs with retry storms —
  // plus a state header so curl-based diagnostics can see the intent. The
  // verifier and forwarder are never reached.
  if (entry.dormant) {
    ctx.metrics.recordRequest(webhookId, 410)
    if (!res.headersSent) {
      res.setHeader('X-Clerum-Webhook-State', 'dormant')
    }
    respondJson(res, 410, {
      error: 'integration_not_configured',
      integration: entry.id,
      hint: entry.dormantSecretName
        ? `create Secret ${entry.dormantSecretName} to activate this webhook`
        : 'create the referenced Secret to activate this webhook',
    })
    return
  }

  // In-flight cap (Q3): per-pod rate limiter. We count per-webhook in the
  // gauge but enforce the cap globally because the pod's resources are shared.
  const totalInFlight = ctx.metrics.totalInFlight()
  if (totalInFlight >= ctx.budgets.maxInFlight) {
    ctx.metrics.recordRequest(webhookId, 503)
    respondJson(res, 503, { error: 'gateway_busy' })
    return
  }

  ctx.metrics.incInFlight(webhookId)
  try {
    await processVerifiedRequest(ctx, req, res, entry)
  } finally {
    ctx.metrics.decInFlight(webhookId)
  }
}

async function processVerifiedRequest(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  entry: WebhookConfigEntry
): Promise<void> {
  const method = (req.method || 'POST').toUpperCase() as 'POST' | 'GET' | string
  if (method !== 'POST' && method !== 'GET') {
    finish(ctx, entry.id, 405)
    respondJson(res, 405, { error: 'method_not_allowed' })
    return
  }
  if (!entry.methods.includes(method as 'POST' | 'GET')) {
    finish(ctx, entry.id, 405)
    respondJson(res, 405, { error: 'method_not_allowed' })
    return
  }

  // Pre-check Content-Length when the client supplies it; saves us reading.
  const declared = parseInt((req.headers['content-length'] ?? '0') as string, 10)
  if (Number.isFinite(declared) && declared > entry.maxBodyBytes) {
    finish(ctx, entry.id, 413)
    respondJson(res, 413, { error: 'body_too_large' })
    return
  }

  const bodyResult = await readRawBody(req, entry.maxBodyBytes, ctx.budgets.bodyIdleTimeoutMs)
  if (bodyResult.kind === 'too_large') {
    finish(ctx, entry.id, 413)
    respondJson(res, 413, { error: 'body_too_large' })
    return
  }
  if (bodyResult.kind === 'idle_timeout') {
    finish(ctx, entry.id, 408)
    if (!res.headersSent) respondJson(res, 408, { error: 'request_timeout' })
    return
  }
  if (bodyResult.kind === 'aborted') {
    // Synthetic 499 — never sent on the wire (client already gone), only logged + counted.
    finish(ctx, entry.id, 499)
    if (!res.writableEnded) res.destroy()
    return
  }

  ctx.metrics.recordBodyBytes(entry.id, bodyResult.body.length)

  if (entry.setupHandshake) {
    const pre = handleHandshakePreVerify(entry.setupHandshake, req)
    if (handshakeAnswered(ctx, entry, pre, res, 'pre')) return
  }

  const verdict = verify(entry, req.headers, bodyResult.body)
  ctx.metrics.recordVerify(entry.id, entry.verification.scheme, verdict.kind)
  switch (verdict.kind) {
    case 'ok':
      break
    case 'invalid_signature':
      finish(ctx, entry.id, 401)
      respondJson(res, 401, { error: 'invalid_signature' })
      return
    case 'timestamp_skew':
      finish(ctx, entry.id, 408)
      respondJson(res, 408, { error: 'timestamp_skew' })
      return
    case 'method_not_allowed':
      finish(ctx, entry.id, 405)
      respondJson(res, 405, { error: 'method_not_allowed' })
      return
    case 'body_too_large':
      finish(ctx, entry.id, 413)
      respondJson(res, 413, { error: 'body_too_large' })
      return
    case 'verifier_misconfigured':
      finish(ctx, entry.id, 500)
      log(ctx, `verifier misconfigured for ${entry.id}: ${verdict.detail}`)
      respondJson(res, 500, { error: 'verifier_misconfigured' })
      return
    case 'invalid_webhook_id':
    case 'webhook_not_found':
      // These outcomes are only produced upstream of the verifier; if we
      // ever see them from a verifier, that's a code bug.
      finish(ctx, entry.id, 500)
      respondJson(res, 500, { error: 'verifier_misconfigured' })
      return
  }

  if (entry.setupHandshake) {
    const post = handleHandshakePostVerify(entry.setupHandshake, req, bodyResult.body)
    if (handshakeAnswered(ctx, entry, post, res, 'post')) return
  }

  // Sanitised forward.
  const headers = buildForwardHeaders(entry, req.headers, ctx.recipeNamespace, ctx.recipeName)
  const result = await forwardVerified(
    entry,
    {
      body: bodyResult.body,
      headers,
      method: method as 'POST' | 'GET',
      upstreamTimeoutMs: ctx.budgets.totalTimeoutMs,
    },
    res
  )
  finish(ctx, entry.id, result.status)
}

function finish(ctx: ServerContext, webhookId: string, status: number): void {
  ctx.metrics.recordRequest(webhookId, status)
}

/**
 * Handle a handshake outcome. Returns true when the request has been answered
 * (matched or misconfigured) so the caller skips the rest of the pipeline;
 * false means no_match → continue.
 */
function handshakeAnswered(
  ctx: ServerContext,
  entry: WebhookConfigEntry,
  outcome: HandshakeOutcome,
  res: ServerResponse,
  stage: 'pre' | 'post',
): boolean {
  if (outcome.kind === 'no_match') return false
  if (outcome.kind === 'misconfigured') {
    finish(ctx, entry.id, 500)
    log(ctx, `setupHandshake misconfigured (${stage}-verify) for ${entry.id}: ${outcome.detail}`)
    respondJson(res, 500, { error: 'verifier_misconfigured' })
    return true
  }
  finish(ctx, entry.id, outcome.status)
  if (!res.headersSent) {
    res.writeHead(outcome.status, { 'content-type': outcome.contentType })
    res.end(outcome.body)
  }
  return true
}

function respondJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Extract the first path segment as the webhookId. We deliberately
 * accept ONLY `/<id>` and `/<id>/...` (the latter is rejected later
 * because verifier never receives anything past the id — webhook-proxy
 * forwards `/<id>` only, so receiving more here means tampering).
 *
 * Returns null on:
 *   - empty path
 *   - leading char is not `/`
 *   - the path has more segments than `/<id>` allows
 */
function parseWebhookIdFromUrl(url: string): string | null {
  // Strip query/fragment if any — we never use them.
  const noQuery = url.split('?')[0].split('#')[0]
  if (!noQuery.startsWith('/')) return null
  // After the leading '/', everything up to the next '/' or end is the id.
  const rest = noQuery.slice(1)
  if (rest.length === 0) return null
  const slashIndex = rest.indexOf('/')
  if (slashIndex < 0) return rest
  // Accept only "/<id>"; "/<id>/anything" is webhook-proxy doing something it shouldn't.
  if (slashIndex !== rest.length - 1) return null
  return rest.slice(0, slashIndex)
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve())
  })
}

function log(ctx: ServerContext, msg: string): void {
  // Single-line structured logs so promtail/fluentbit pick them up cleanly.
  // We deliberately do NOT log request bodies, signatures, or secrets — only
  // outcomes. URLs are considered safe to log per project precedent.
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      svc: 'webhook-gateway',
      ns: ctx.recipeNamespace,
      recipe: ctx.recipeName,
      msg,
    })
  )
}
