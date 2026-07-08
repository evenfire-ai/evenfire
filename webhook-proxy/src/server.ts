import http, { IncomingMessage, Server, ServerResponse } from 'node:http'
import { RECIPE_NAME_RE, WEBHOOK_ID_RE, type ProxyConfig } from './config'
import { forward, forwardToBaseUrl } from './forwarder'
import type { RegistryClient } from './registry'

export interface ServerHandle {
  close: () => Promise<void>
}

export function start(config: ProxyConfig, registry: RegistryClient): ServerHandle {
  const httpServer = http.createServer((req, res) => {
    handle(req, res, config, registry).catch(err => {
      log({ msg: `unhandled: ${err instanceof Error ? err.stack : err}` })
      if (!res.headersSent) {
        respondJson(res, 500, { error: 'internal_error' })
      } else if (!res.writableEnded) {
        res.end()
      }
    })
  })
  httpServer.listen(config.httpPort)

  const metricsServer = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/readyz') {
      respondJson(res, 200, { ok: true })
      return
    }
    respondJson(res, 404, { error: 'not_found' })
  })
  metricsServer.listen(config.metricsPort)

  log({ msg: `listening: http=:${config.httpPort} metrics=:${config.metricsPort}` })
  return {
    close: async () => {
      await Promise.all([closeServer(httpServer), closeServer(metricsServer)])
    },
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
  registry: RegistryClient
): Promise<void> {
  if (req.url === '/healthz' || req.url === '/readyz') {
    respondJson(res, 200, { ok: true })
    return
  }
  if (isWorkflowApprovalReaderRoute(req.url || '')) {
    await forwardToBaseUrl(config.workflowApprovalReaderBaseUrl, req, res, {
      upstreamTimeoutMs: config.upstreamTimeoutMs,
    })
    return
  }
  // ANY /api/v1/webhook/:recipeNs/:recipeName/:webhookId
  const ids = parseRouteIds(req.url || '')
  if (!ids) {
    respondJson(res, 404, { error: 'not_found' })
    return
  }
  // Defense-in-depth: revalidate every segment before any registry lookup.
  // CORS headers are deliberately NOT applied on these pre-registry failures:
  // we don't yet know whether the webhook exists, and a 404 to a typoed URL
  // shouldn't leak an Allow-Origin echo.
  if (ids.recipeNs !== config.sandboxNamespace) {
    respondJson(res, 404, { error: 'webhook_not_found' })
    return
  }
  if (!RECIPE_NAME_RE.test(ids.recipeName)) {
    respondJson(res, 400, { error: 'invalid_recipe_name' })
    return
  }
  if (!WEBHOOK_ID_RE.test(ids.webhookId)) {
    respondJson(res, 400, { error: 'invalid_webhook_id' })
    return
  }
  const result = await registry.lookup(ids)
  if (!result.exists) {
    if (result.reason === 'recipe_not_found' || result.reason === 'webhook_not_found') {
      respondJson(res, 404, { error: 'webhook_not_found' })
      return
    }
    if (result.reason === 'invalid_request') {
      respondJson(res, 400, { error: 'invalid_request' })
      return
    }
    respondJson(res, 502, { error: 'registry_unavailable' })
    return
  }
  // The webhook is real — resolve CORS posture for this request.
  const requestOrigin = headerString(req.headers.origin)
  const allowedOrigin = pickAllowedOrigin(requestOrigin, result.allowedOrigins)

  const method = (req.method || 'POST').toUpperCase()

  // CORS preflight: answer here, never forward. OPTIONS is the browser
  // mechanism, not a recipe-configurable method, so it isn't checked against
  // result.methods.
  if (method === 'OPTIONS') {
    if (!allowedOrigin) {
      // Either no Origin, origin not in the allowlist, or no allowlist
      // configured. Without Allow-Origin headers the browser fails the
      // preflight, which is the correct outcome.
      respondJson(res, 403, { error: 'cors_origin_not_allowed' })
      return
    }
    setPreflightHeaders(
      res,
      allowedOrigin,
      result.methods,
      headerString(req.headers['access-control-request-headers'])
    )
    res.writeHead(204)
    res.end()
    return
  }

  // Real request: echo Allow-Origin on every response (including error
  // paths below) so the browser can read the response body.
  if (allowedOrigin) setCorsHeaders(res, allowedOrigin)

  // Method allow-list check (cheap reject before forward).
  if (!result.methods.includes(method as 'POST' | 'GET')) {
    respondJson(res, 405, { error: 'method_not_allowed' })
    return
  }
  // Body-size pre-check via Content-Length, when the client supplies it.
  // The gateway will also enforce this — pre-checking saves us reading.
  const declared = parseInt((req.headers['content-length'] ?? '0') as string, 10)
  const cap = Math.min(result.maxBodyBytes, config.maxBodyBytesCeiling)
  if (Number.isFinite(declared) && declared > cap) {
    respondJson(res, 413, { error: 'body_too_large' })
    return
  }
  // Stash the validated webhookId on the request for the forwarder.
  ;(req as IncomingMessage & { webhookId?: string }).webhookId = ids.webhookId
  await forward(result, req, res, { upstreamTimeoutMs: config.upstreamTimeoutMs })
}

function headerString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined
  return Array.isArray(v) ? v[0] : v
}

function pickAllowedOrigin(
  requestOrigin: string | undefined,
  allowed: ReadonlyArray<string> | undefined
): string | null {
  if (!requestOrigin || !allowed || allowed.length === 0) return null
  return allowed.includes(requestOrigin) ? requestOrigin : null
}

function setCorsHeaders(res: ServerResponse, origin: string): void {
  if (res.headersSent) return
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
}

function setPreflightHeaders(
  res: ServerResponse,
  origin: string,
  allowedMethods: ReadonlyArray<'POST' | 'GET'>,
  requestedHeaders: string | undefined
): void {
  if (res.headersSent) return
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin, Access-Control-Request-Headers')
  res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '))
  // Echo the browser's requested headers when reasonable; fall back to the
  // common pair the widget uses. Clamp length so a hostile/buggy client
  // can't inflate the response header size.
  const echo =
    requestedHeaders && requestedHeaders.length > 0 && requestedHeaders.length <= 256
      ? requestedHeaders
      : 'authorization, content-type'
  res.setHeader('Access-Control-Allow-Headers', echo)
  res.setHeader('Access-Control-Max-Age', '600')
}

function isWorkflowApprovalReaderRoute(url: string): boolean {
  const noQuery = url.split('?')[0].split('#')[0]
  return /^\/webhooks\/telegram\/?$/.test(noQuery) || /^\/webhooks\/slack\/[^/]+\/?$/.test(noQuery)
}

/**
 * Parse `/api/v1/webhook/:ns/:name/:id`. Anything else returns null and
 * the route handler responds 404.
 *
 * We do NOT URL-decode segments here — `decodeURIComponent` would let
 * `%2e%2e` pass through as `..` and then we'd re-validate against the
 * regex (which would reject it). To keep the rejection deterministic,
 * we accept only segments whose raw form already matches the regex.
 */
function parseRouteIds(url: string): { recipeNs: string; recipeName: string; webhookId: string } | null {
  const noQuery = url.split('?')[0].split('#')[0]
  const match = noQuery.match(/^\/api\/v1\/webhook\/([^/]+)\/([^/]+)\/([^/]+)\/?$/)
  if (!match) return null
  return { recipeNs: match[1], recipeName: match[2], webhookId: match[3] }
}

function respondJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve())
  })
}

function log(entry: { msg: string }): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'webhook-proxy', ...entry }))
}
