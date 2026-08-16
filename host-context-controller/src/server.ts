/**
 * HTTP REST API server for Context Mapper.
 */
import * as http from 'http'
import { config } from './config'
import { HostReconciler } from './hostReconciler'
import { McpServerProvider } from './k8sClient'
import { hccLogger } from './logger'
import {
  McpApiAuthenticationError,
  McpApiAuthenticator,
  type VerifiedMcpHostPrincipal,
} from './mcpApiAuthentication'
import {
  McpAuthorizationError,
  McpAuthorizationService,
  toPublicMcpTransport,
} from './mcpAuthorization'
import { mcpHostApiRequestsTotal, registry } from './metrics'
import { McpServersResponse } from './types'

const MCP_SELECTOR_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
const MCP_REQUEST_BODY_LIMIT = 1024
const mcpApiLog = hccLogger.child({ module: 'mcp-host-api' })
type McpHostApiAction = 'inventory' | 'credential'

type RateLimitEntry = { windowStartMs: number; count: number }

/** Per-Host, per-action fixed-window limiter applied only after JWT validation. */
export class McpHostApiRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>()

  constructor(
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now
  ) {}

  consume(
    hostUid: string,
    action: McpHostApiAction
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const nowMs = this.now()
    const key = `${hostUid}\u0000${action}`
    const existing = this.entries.get(key)
    if (!existing || nowMs - existing.windowStartMs >= 60_000) {
      this.entries.set(key, { windowStartMs: nowMs, count: 1 })
      this.prune(nowMs)
      return { allowed: true }
    }
    if (existing.count >= this.maxPerMinute) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((60_000 - (nowMs - existing.windowStartMs)) / 1000)
        ),
      }
    }
    existing.count += 1
    return { allowed: true }
  }

  private prune(nowMs: number): void {
    if (this.entries.size <= 10_000) return
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.windowStartMs >= 60_000) this.entries.delete(key)
    }
    while (this.entries.size > 10_000) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }
}

export class ContextMapperServer {
  private server: http.Server | null = null
  private provider: McpServerProvider
  private port: number
  private hostReconciler: HostReconciler | null
  private hasDesktopFn: ((hostRef: string) => boolean) | null
  private mcpAuthenticator: McpApiAuthenticator | null
  private mcpAuthorization: McpAuthorizationService | null
  private mcpRateLimiter: McpHostApiRateLimiter
  private ready = false

  constructor(
    provider: McpServerProvider,
    port: number = config.port,
    hostReconciler?: HostReconciler,
    hasDesktopFn?: (hostRef: string) => boolean,
    mcpAuthenticator?: McpApiAuthenticator,
    mcpAuthorization?: McpAuthorizationService
  ) {
    this.provider = provider
    this.port = port
    this.hostReconciler = hostReconciler ?? null
    this.hasDesktopFn = hasDesktopFn ?? null
    this.mcpAuthenticator = mcpAuthenticator ?? null
    this.mcpAuthorization = mcpAuthorization ?? null
    this.mcpRateLimiter = new McpHostApiRateLimiter(config.mcpHostApiRateLimitPerMinute)
  }

  /**
   * Mark the server as ready once the provider warm-up has completed.
   */
  setReady(ready: boolean): void {
    this.ready = ready
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`)
    const isLegacyHostSelectedMcpRoute =
      url.pathname.startsWith('/api/v1/mcpservers/context/') ||
      (url.pathname.startsWith('/api/v1/mcpservers/') && url.pathname.endsWith('/auth'))
    const isProtectedMcpRoute =
      url.pathname.startsWith('/api/v2/hosts/self/mcpservers') || isLegacyHostSelectedMcpRoute

    // The Host credential surface is service-to-service and deliberately has
    // no browser wildcard CORS grant. Preserve the historical public CORS
    // behavior only for unrelated/legacy endpoints.
    if (!isProtectedMcpRoute) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    }

    // Retire caller-selected Context/credential routes at the application
    // boundary for every method, including preflight, and independently of
    // readiness. This remains a defense if a caller bypasses the gateway.
    if (isLegacyHostSelectedMcpRoute) {
      this.sendProtectedJson(res, 410, { error: 'gone' })
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Root path - API information
    if (req.method === 'GET' && url.pathname === '/') {
      this.handleRoot(res)
      return
    }

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      this.sendJson(res, 200, { status: 'ok', ready: this.ready })
      return
    }

    // Readiness check
    if (req.method === 'GET' && url.pathname === '/ready') {
      this.sendJson(res, this.ready ? 200 : 503, {
        status: this.ready ? 'ready' : 'starting',
        ready: this.ready,
      })
      return
    }

    // Prometheus metrics
    if (req.method === 'GET' && url.pathname === '/metrics') {
      const metrics = await registry.metrics()
      res.writeHead(200, { 'Content-Type': registry.contentType })
      res.end(metrics)
      return
    }

    if (!this.ready) {
      if (isProtectedMcpRoute) {
        this.sendProtectedJson(res, 503, { error: 'authorization_unavailable' })
        return
      }
      this.sendJson(res, 503, {
        error: 'Service Unavailable',
        message: 'Context mapper is still starting',
      })
      return
    }

    if (url.pathname === '/api/v2/hosts/self/mcpservers') {
      if (req.method === 'GET') {
        await this.handleHostMcpServers(req, res)
      } else {
        this.sendProtectedJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' })
      }
      return
    }

    if (url.pathname === '/api/v2/hosts/self/mcpservers/credential') {
      if (req.method === 'POST') {
        await this.handleHostMcpCredential(req, res)
      } else {
        this.sendProtectedJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' })
      }
      return
    }

    // List all McpServers (temporary PR 2 compatibility residual).
    if (req.method === 'GET' && url.pathname === '/api/v1/mcpservers') {
      await this.handleListAll(req, res, url)
      return
    }

    // Desktop status (requires service token)
    if (req.method === 'GET' && url.pathname.startsWith('/api/v1/desktop/')) {
      if (!this.checkDesktopAuth(req, res)) return
      const hostRef = url.pathname.replace('/api/v1/desktop/', '')
      await this.handleDesktopStatus(res, hostRef)
      return
    }

    // 404
    if (isProtectedMcpRoute) {
      this.sendProtectedJson(res, 404, { error: 'not_found' })
      return
    }
    this.sendJson(res, 404, { error: 'Not Found', message: 'Endpoint not found' })
  }

  /**
   * Verify the desktop API token from the Authorization header.
   * Skips check when desktopApiToken is empty (dev mode).
   */
  private checkDesktopAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const token = config.desktopApiToken
    if (!token) return true // skip auth in dev mode
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      this.sendJson(res, 401, {
        error: 'Unauthorized',
        message: 'Invalid or missing service token',
      })
      return false
    }
    return true
  }

  private authenticateMcpHost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    action: McpHostApiAction
  ): VerifiedMcpHostPrincipal | null {
    if (!this.mcpAuthenticator || !this.mcpAuthorization) {
      mcpApiLog.error('MCP authorization authority unavailable', {
        reason: 'verifier_not_configured',
      })
      mcpHostApiRequestsTotal.inc({ action, outcome: 'error', reason: 'unconfigured' }, 1)
      this.sendProtectedJson(res, 503, { error: 'authorization_unavailable' })
      return null
    }
    try {
      return this.mcpAuthenticator.authenticate(req.headers, req.rawHeaders)
    } catch (error) {
      const reason =
        error instanceof McpApiAuthenticationError ? 'invalid_bearer' : 'verifier_error'
      mcpApiLog.info('MCP request denied', { reason })
      mcpHostApiRequestsTotal.inc({ action, outcome: 'denied', reason }, 1)
      this.sendProtectedJson(
        res,
        401,
        { error: 'unauthorized' },
        { 'WWW-Authenticate': 'Bearer realm="host-context-controller"' }
      )
      return null
    }
  }

  private async handleHostMcpServers(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const principal = this.authenticateMcpHost(req, res, 'inventory')
    if (!principal || !this.mcpAuthorization) return
    if (!this.enforceMcpRateLimit(principal, 'inventory', res)) return
    try {
      const servers = await this.mcpAuthorization.listServers(principal)
      mcpHostApiRequestsTotal.inc({ action: 'inventory', outcome: 'success', reason: 'ok' }, 1)
      this.sendProtectedJson(res, 200, { servers, timestamp: new Date().toISOString() })
    } catch (error) {
      this.sendMcpAuthorizationError(res, error, 'inventory')
    }
  }

  private async handleHostMcpCredential(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const principal = this.authenticateMcpHost(req, res, 'credential')
    if (!principal || !this.mcpAuthorization) return
    if (!this.enforceMcpRateLimit(principal, 'credential', res)) return
    const contentType = String(req.headers['content-type'] ?? '')
      .split(';', 1)[0]
      .trim()
    if (contentType !== 'application/json') {
      this.sendProtectedJson(res, 415, { error: 'unsupported_media_type' })
      return
    }

    let body: unknown
    try {
      body = await this.readBoundedJsonBody(req)
    } catch (error) {
      const status = error instanceof Error && error.message === 'body_too_large' ? 413 : 400
      this.sendProtectedJson(res, status, {
        error: status === 413 ? 'payload_too_large' : 'bad_request',
      })
      return
    }
    const bodyKeys =
      body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : []
    const serverName =
      bodyKeys.length === 1 && bodyKeys[0] === 'serverName'
        ? (body as { serverName?: unknown }).serverName
        : undefined
    if (
      typeof serverName !== 'string' ||
      serverName.length > 253 ||
      serverName.trim() !== serverName ||
      !MCP_SELECTOR_RE.test(serverName)
    ) {
      this.sendProtectedJson(res, 400, { error: 'bad_request' })
      return
    }

    try {
      const credential = await this.mcpAuthorization.getCredential(principal, serverName)
      mcpHostApiRequestsTotal.inc({ action: 'credential', outcome: 'success', reason: 'ok' }, 1)
      this.sendProtectedJson(res, 200, credential)
    } catch (error) {
      this.sendMcpAuthorizationError(res, error, 'credential')
    }
  }

  private async readBoundedJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const declared = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > MCP_REQUEST_BODY_LIMIT) {
      throw new Error('body_too_large')
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MCP_REQUEST_BODY_LIMIT) throw new Error('body_too_large')
      chunks.push(buffer)
    }
    if (size === 0) throw new Error('invalid_json')
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  private sendMcpAuthorizationError(
    res: http.ServerResponse,
    error: unknown,
    action: McpHostApiAction
  ): void {
    const code = error instanceof McpAuthorizationError ? error.code : 'authorization_unavailable'
    mcpApiLog.info('MCP request denied', { action, reason: code })
    mcpHostApiRequestsTotal.inc({ action, outcome: 'denied', reason: code }, 1)
    if (code === 'unauthorized') {
      this.sendProtectedJson(
        res,
        401,
        { error: 'unauthorized' },
        { 'WWW-Authenticate': 'Bearer realm="host-context-controller"' }
      )
      return
    }
    if (code === 'not_found') {
      this.sendProtectedJson(res, 404, { error: 'not_found' })
      return
    }
    if (code === 'credential_unavailable') {
      this.sendProtectedJson(res, 503, { error: 'credential_unavailable' })
      return
    }
    this.sendProtectedJson(res, 503, { error: 'authorization_unavailable' })
  }

  private enforceMcpRateLimit(
    principal: VerifiedMcpHostPrincipal,
    action: McpHostApiAction,
    res: http.ServerResponse
  ): boolean {
    const result = this.mcpRateLimiter.consume(principal.hostUid, action)
    if (result.allowed) return true
    mcpApiLog.info('MCP request denied', { action, reason: 'rate_limited' })
    mcpHostApiRequestsTotal.inc({ action, outcome: 'denied', reason: 'rate_limited' }, 1)
    this.sendProtectedJson(
      res,
      429,
      { error: 'rate_limited' },
      { 'Retry-After': String(result.retryAfterSeconds) }
    )
    return false
  }

  private sendProtectedJson(
    res: http.ServerResponse,
    status: number,
    data: unknown,
    headers: Record<string, string> = {}
  ): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, private',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    })
    res.end(JSON.stringify(data))
  }

  /**
   * Start the server.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          console.error('[Server] Request handler failed:', err)
          if (!res.headersSent) {
            this.sendJson(res, 500, {
              error: 'Internal Server Error',
              message: 'Unhandled server error',
            })
          } else {
            res.end()
          }
        })
      })

      this.server.on('error', err => {
        console.error('[Server] Error:', err)
        reject(err)
      })

      this.server.listen(this.port, () => {
        console.log(`[Server] Context Mapper listening on port ${this.port}`)
        console.log(`[Server] Endpoints:`)
        console.log(`[Server]   GET / - API information`)
        console.log(`[Server]   GET /health - Health check`)
        console.log(`[Server]   GET /ready - Readiness check`)
        console.log(`[Server]   GET /api/v1/mcpservers - List all McpServers`)
        console.log(`[Server]   GET /api/v2/hosts/self/mcpservers - Host-scoped MCP inventory`)
        console.log(
          `[Server]   POST /api/v2/hosts/self/mcpservers/credential - Host-scoped MCP credential`
        )
        console.log(`[Server]   GET /api/v1/desktop/:hostRef - Desktop status`)
        resolve()
      })
    })
  }

  /**
   * Handle GET / - Root endpoint with API information
   */
  private handleRoot(res: http.ServerResponse): void {
    const info = {
      name: 'Context Mapper',
      description:
        'Kubernetes operator and REST API service for McpServer CRDs. ' +
        'In production, it watches McpServer CRDs and automatically manages Deployments, ' +
        'Services, and validates secrets for each MCP server. It also provides a REST API ' +
        'for mcp-host to discover available MCP servers. ' +
        'In dev mode, it reads server configurations from environment variables.',
      version: '1.0.0',
      mode: config.devMode ? 'development' : 'production',
      endpoints: {
        'GET /': 'This information page',
        'GET /health': "Health check endpoint - returns { status: 'ok', ready: boolean }",
        'GET /ready': 'Readiness endpoint - returns 200 only after warm-up completes',
        'GET /api/v1/mcpservers': 'List all McpServer resources',
        'GET /api/v2/hosts/self/mcpservers': 'List MCP servers for the authenticated Host',
        'POST /api/v2/hosts/self/mcpservers/credential':
          'Get an authorized credential for the authenticated Host',
      },
      examples: {
        listAll: `curl http://localhost:${this.port}/api/v1/mcpservers`,
      },
      stats: {
        totalServers: this.provider.getAllServerInfos().length,
      },
    }

    this.sendJson(res, 200, info)
  }

  /**
   * Handle GET /api/v1/mcpservers
   */
  private async handleListAll(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    console.log(`[Server] GET /api/v1/mcpservers`)

    const servers = this.provider.getAllServerInfos().map(server => ({
      name: server.name,
      contextRef: server.contextRef,
      transport: toPublicMcpTransport(server.transport),
      enabled: server.enabled,
      status: {
        deployed: server.status.deployed,
        ready: server.status.ready,
      },
    }))
    const response: McpServersResponse = {
      servers,
      contextRef: '*',
      timestamp: new Date().toISOString(),
    }

    this.sendProtectedJson(res, 200, response)
  }

  /**
   * Send JSON response.
   */
  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  /**
   * Handle GET /api/v1/desktop/:hostRef — Desktop status
   */
  private async handleDesktopStatus(res: http.ServerResponse, hostRef: string): Promise<void> {
    if (!hostRef) {
      this.sendJson(res, 400, { error: 'Bad Request', message: 'hostRef is required' })
      return
    }
    if (!this.hostReconciler) {
      this.sendJson(res, 200, { status: 'inactive', message: 'Host reconciler not available' })
      return
    }
    // Verify the host actually has spec.desktop enabled
    if (this.hasDesktopFn && !this.hasDesktopFn(hostRef)) {
      this.sendJson(res, 200, {
        status: 'inactive',
        hostRef,
        message: 'Host does not have desktop enabled',
      })
      return
    }
    const status = this.hostReconciler.getStatus(hostRef)
    if (status.deployed && status.ready) {
      this.sendJson(res, 200, { status: 'running', hostRef })
    } else {
      this.sendJson(res, 200, { status: 'inactive', hostRef, message: status.message })
    }
  }

  /**
   * Stop the server.
   */
  stop(): Promise<void> {
    return new Promise(resolve => {
      if (this.server) {
        this.server.close(() => {
          console.log('[Server] Context Mapper stopped')
          resolve()
        })
      } else {
        resolve()
      }
    })
  }
}
