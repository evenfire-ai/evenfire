import http, { IncomingMessage, ServerResponse } from 'node:http'
import { proxyLogger } from './logger'
import { HccAuthorizationError, HccClient, type HccForwardAuthorization } from './hccClient'
import { Health } from './health'
import { HttpForwarder, HttpForwarderError, validateInternalTarget } from './httpForwarder'
import { Metrics } from './metrics'
import { Router } from './router'
import { ProxyConfig } from './types'

const SERVER_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
const BEARER_SCHEME = 'Bearer'
const HARD_BODY_LIMIT = 8 * 1024 * 1024

export class ProxyServer {
  private httpServer: http.Server | null = null

  constructor(
    private readonly router: Router,
    private readonly forwarder: HttpForwarder,
    private readonly metrics: Metrics,
    private readonly health: Health,
    private readonly config: ProxyConfig,
    private readonly hccClient: HccClient = new HccClient(config)
  ) {}

  getPort(): number {
    const addr = this.httpServer?.address()
    if (addr && typeof addr !== 'string') return addr.port
    return this.config.port
  }

  start(): Promise<void> {
    return new Promise(resolve => {
      this.httpServer = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(error => {
          proxyLogger.error('request_handler_failed', {
            reason: error instanceof Error ? error.name : 'unknown',
          })
          if (!res.headersSent) {
            this.sendError(res, 500, 'internal_error')
          } else {
            res.end()
          }
        })
      })

      this.httpServer.listen(this.config.port, () => {
        proxyLogger.info('proxy_started', { port: this.getPort() })
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    this.health.setAlive(false)
    const activeServer = this.httpServer
    this.httpServer = null
    return new Promise(resolve => {
      if (!activeServer) {
        resolve()
        return
      }
      activeServer.close(() => {
        proxyLogger.info('proxy_stopped')
        resolve()
      })
      setTimeout(resolve, 10_000)
    })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = new URL(req.url || '/', 'http://mcp-proxy.local')
    if (parsed.pathname === '/health' && req.method === 'GET') {
      this.health.handleHealth(res)
      return
    }
    if (parsed.pathname === '/ready' && req.method === 'GET') {
      this.health.handleReady(res)
      return
    }
    if (parsed.pathname === '/metrics' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(this.metrics.toPrometheus())
      return
    }

    const match = /^\/servers\/([^/]+)\/mcp$/.exec(parsed.pathname)
    if (match && (req.method === 'GET' || req.method === 'POST')) {
      await this.handleForward(req, res, match[1])
      return
    }

    this.sendError(res, 404, 'not_found')
  }

  private async handleForward(
    req: IncomingMessage,
    res: ServerResponse,
    serverName: string
  ): Promise<void> {
    if (!this.config.forwardingEnabled) {
      this.sendError(res, 503, 'forwarding_disabled')
      return
    }
    if (!SERVER_NAME_RE.test(serverName) || serverName.length > 253) {
      this.sendError(res, 400, 'bad_request')
      return
    }

    let body: Buffer
    try {
      body = await this.readBoundedBody(req)
    } catch (error) {
      if (error instanceof Error && error.message === 'body_too_large') {
        this.sendError(res, 413, 'payload_too_large')
      } else {
        this.sendError(res, 400, 'bad_request')
      }
      return
    }

    let hostBearer: string
    try {
      hostBearer = this.readHostBearer(req)
    } catch {
      this.sendError(res, 401, 'unauthorized')
      return
    }

    let authorization: HccForwardAuthorization
    try {
      authorization = await this.hccClient.authorizeForward(serverName, hostBearer)
    } catch (error) {
      if (error instanceof HccAuthorizationError && error.code === 'bad_request') {
        this.sendError(res, 400, 'bad_request')
      } else if (error instanceof HccAuthorizationError && error.code === 'unauthorized') {
        this.sendError(res, 401, 'unauthorized')
      } else if (error instanceof HccAuthorizationError && error.code === 'forbidden') {
        this.sendError(res, 403, 'forbidden')
      } else {
        this.sendError(res, 503, 'authorization_unavailable')
      }
      return
    }

    try {
      validateInternalTarget(authorization.targetUrl, this.config.allowLoopbackTargets)
    } catch {
      this.sendError(res, 503, 'authorization_unavailable')
      return
    }

    const startedAt = Date.now()
    this.metrics.incrementActive(serverName)
    try {
      await this.forwarder.forward(req, res, authorization.targetUrl, body)
      this.metrics.recordRequest({
        server: serverName,
        method: req.method || 'GET',
        status: res.statusCode || 502,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      if (error instanceof HttpForwarderError && error.code === 'invalid_headers') {
        this.sendError(res, 400, 'bad_request')
      } else if (error instanceof HttpForwarderError) {
        this.sendError(res, 503, 'authorization_unavailable')
      } else if (!res.headersSent) {
        this.sendError(res, 502, 'upstream_error')
      }
    } finally {
      this.metrics.decrementActive(serverName)
    }
  }

  private async readBoundedBody(req: IncomingMessage): Promise<Buffer> {
    const declaredHeader = req.headers['content-length']
    if (Array.isArray(declaredHeader)) throw new Error('invalid_content_length')
    const declared = declaredHeader === undefined ? 0 : Number(declaredHeader)
    if (!Number.isSafeInteger(declared) || declared < 0) throw new Error('invalid_content_length')
    const limit = Math.min(Math.max(this.config.requestBodyLimit, 1), HARD_BODY_LIMIT)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > HARD_BODY_LIMIT) throw new Error('body_too_large')
      if (size > limit || declared > limit) throw new Error('body_too_large')
      chunks.push(buffer)
    }
    if (declared !== 0 && declared !== size) throw new Error('invalid_content_length')
    return Buffer.concat(chunks)
  }

  private readHostBearer(req: IncomingMessage): string {
    let count = 0
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index]?.toLowerCase() === 'proxy-authorization') count += 1
    }
    const value = req.headers['proxy-authorization']
    if (count !== 1 || Array.isArray(value) || typeof value !== 'string') {
      throw new Error('invalid_proxy_identity')
    }
    const match = new RegExp(`^${BEARER_SCHEME} ([^\\s,]+)$`).exec(value)
    if (!match) throw new Error('invalid_proxy_identity')
    return match[1]
  }

  private sendError(res: ServerResponse, status: number, error: string): void {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, private',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(JSON.stringify({ error }))
  }
}
