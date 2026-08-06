import http, { IncomingMessage, Server, ServerResponse } from 'node:http'
import { AuthProxyConfig } from './config'

export interface ServerHandle {
  close: () => Promise<void>
  httpPort: () => number
  metricsPort: () => number
}

type CallbackRoute =
  | { kind: 'oauth'; oauthClientId: string; query: string }
  | { kind: 'identity-provider'; query: string }

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const RESPONSE_HEADERS_TO_RELAY = new Set(['cache-control', 'content-type', 'location'])

class UpstreamResponseTooLargeError extends Error {
  constructor() {
    super('upstream response exceeded auth-proxy response limit')
    this.name = 'UpstreamResponseTooLargeError'
  }
}

export function start(config: AuthProxyConfig): ServerHandle {
  const httpServer = http.createServer((req, res) => {
    handle(req, res, config).catch(err => {
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
    httpPort: () => serverPort(httpServer),
    metricsPort: () => serverPort(metricsServer),
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: AuthProxyConfig
): Promise<void> {
  if (req.url === '/healthz' || req.url === '/readyz') {
    respondJson(res, 200, { ok: true })
    return
  }

  const route = parseCallbackRoute(req.url || '')
  if (!route) {
    respondJson(res, 404, { error: 'not_found' })
    return
  }

  if ((req.method || '').toUpperCase() !== 'GET') {
    respondJson(res, 405, { error: 'method_not_allowed' })
    return
  }

  await forwardCallback(route, res, config)
}

async function forwardCallback(
  route: CallbackRoute,
  res: ServerResponse,
  config: AuthProxyConfig
): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs)
  try {
    const upstream = buildUpstreamUrl(config.controlApiBaseUrl, route)
    const response = await fetch(upstream, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        accept: 'text/html, application/json;q=0.9, text/plain;q=0.8, */*;q=0.5',
        authorization: `Bearer ${config.controlApiServiceToken}`,
        'x-service-token': config.controlApiServiceName,
      },
      signal: controller.signal,
    })
    const body = await readLimitedResponseBody(response, config.maxResponseBytes)
    relayHeaders(response, res)
    res.writeHead(response.status)
    res.end(body)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      respondJson(res, 504, { error: 'upstream_timeout' })
      return
    }
    if (err instanceof UpstreamResponseTooLargeError) {
      respondJson(res, 502, { error: 'upstream_response_too_large' })
      return
    }
    log({ msg: `upstream_failed: ${err instanceof Error ? err.message : String(err)}` })
    respondJson(res, 502, { error: 'upstream_unavailable' })
  } finally {
    clearTimeout(timeout)
  }
}

function relayHeaders(response: Response, res: ServerResponse): void {
  response.headers.forEach((value, key) => {
    const normalized = key.toLowerCase()
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(normalized)) return
    if (!RESPONSE_HEADERS_TO_RELAY.has(normalized)) return
    res.setHeader(key, value)
  })
}

async function readLimitedResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new UpstreamResponseTooLargeError()
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  return Buffer.concat(chunks, total)
}

export function buildUpstreamUrl(baseUrl: string, route: CallbackRoute): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (route.kind === 'oauth') {
    return `${base}/internal/auth-callback/oauth-callback/` + `${route.oauthClientId}${route.query}`
  }
  return `${base}/internal/auth-callback/identity-provider-callback/microsoft${route.query}`
}

export function parseCallbackRoute(url: string): CallbackRoute | null {
  const queryStart = url.indexOf('?')
  const path = queryStart >= 0 ? url.slice(0, queryStart) : url
  const query = queryStart >= 0 ? url.slice(queryStart) : ''
  const oauthMatch = path.match(/^\/api\/v1\/oauth-callback\/([^/]+)\/?$/)
  if (oauthMatch) return { kind: 'oauth', oauthClientId: oauthMatch[1], query }
  if (/^\/api\/v1\/identity-provider-callback\/microsoft\/?$/.test(path)) {
    return { kind: 'identity-provider', query }
  }
  return null
}

function respondJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function serverPort(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') return 0
  return address.port
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve())
  })
}

function log(entry: { msg: string }): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'auth-proxy', ...entry }))
}
