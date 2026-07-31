/**
 * HTTP REST API server for Context Mapper.
 */
import * as http from 'http'
import { config } from './config'
import { HostReconciler } from './hostReconciler'
import { McpServerProvider } from './k8sClient'
import { registry } from './metrics'
import { ErrorResponse, McpServersResponse } from './types'

type ReadinessState =
  | { ready: true; status: 'ready' }
  | { ready: false; status: 'starting' | 'degraded'; message: string }

export class ContextMapperServer {
  private server: http.Server | null = null
  private provider: McpServerProvider
  private port: number
  private hostReconciler: HostReconciler | null
  private hasDesktopFn: ((hostRef: string) => boolean) | null
  private providerAuthoritativeFn: () => boolean
  private ready = false

  constructor(
    provider: McpServerProvider,
    port: number = config.port,
    hostReconciler?: HostReconciler,
    hasDesktopFn?: (hostRef: string) => boolean,
    // Fails closed. /ready is the assertion that no stale allow is live, and a
    // caller that omits this gate gets no type error, so the default must
    // withhold readiness rather than grant it.
    providerAuthoritativeFn: () => boolean = () => false
  ) {
    this.provider = provider
    this.port = port
    this.hostReconciler = hostReconciler ?? null
    this.hasDesktopFn = hasDesktopFn ?? null
    this.providerAuthoritativeFn = providerAuthoritativeFn
  }

  /**
   * Mark the server as ready once the provider warm-up has completed.
   */
  setReady(ready: boolean): void {
    this.ready = ready
  }

  private getReadinessState(): ReadinessState {
    if (!this.ready) {
      return {
        ready: false,
        status: 'starting',
        message: 'Context mapper is still starting',
      }
    }

    try {
      if (this.providerAuthoritativeFn()) {
        return { ready: true, status: 'ready' }
      }
    } catch (err) {
      console.error('[Server] Provider authority readiness check failed:', err)
    }

    return {
      ready: false,
      status: 'degraded',
      message: 'Context mapper provider inventory is not authoritative',
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://localhost:${this.port}`)

    // Root path - API information
    if (req.method === 'GET' && url.pathname === '/') {
      this.handleRoot(res)
      return
    }

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      const readiness = this.getReadinessState()
      this.sendJson(res, 200, {
        status: 'ok',
        ready: readiness.ready,
      })
      return
    }

    // Readiness check
    if (req.method === 'GET' && url.pathname === '/ready') {
      const readiness = this.getReadinessState()
      this.sendJson(res, readiness.ready ? 200 : 503, {
        status: readiness.status,
        ready: readiness.ready,
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

    const readiness = this.getReadinessState()
    if (!readiness.ready) {
      this.sendJson(res, 503, {
        error: 'Service Unavailable',
        message: readiness.message,
      })
      return
    }

    // List all McpServers
    if (req.method === 'GET' && url.pathname === '/api/v1/mcpservers') {
      await this.handleListAll(req, res, url)
      return
    }

    // List McpServers by context
    if (req.method === 'GET' && url.pathname.startsWith('/api/v1/mcpservers/context/')) {
      const contextRef = url.pathname.replace('/api/v1/mcpservers/context/', '')
      await this.handleListByContext(req, res, contextRef)
      return
    }

    // Get auth token for a server
    if (
      req.method === 'GET' &&
      url.pathname.startsWith('/api/v1/mcpservers/') &&
      url.pathname.endsWith('/auth')
    ) {
      const serverName = url.pathname.replace('/api/v1/mcpservers/', '').replace('/auth', '')
      await this.handleGetAuth(req, res, serverName)
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
        console.log(
          `[Server]   GET /api/v1/mcpservers/context/:contextRef - List McpServers by context`
        )
        console.log(`[Server]   GET /api/v1/mcpservers/:name/auth - Get auth token for McpServer`)
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
        'GET /ready':
          'Readiness endpoint - returns 200 after warm-up while provider inventory is authoritative',
        'GET /api/v1/mcpservers': 'List all McpServer resources',
        'GET /api/v1/mcpservers/context/:contextRef':
          'List McpServers filtered by contextRef (only enabled servers)',
        'GET /api/v1/mcpservers/:name/auth': 'Get authentication token for a specific McpServer',
      },
      examples: {
        listAll: `curl http://localhost:${this.port}/api/v1/mcpservers`,
        listByContext: `curl http://localhost:${this.port}/api/v1/mcpservers/context/dev-context`,
        getAuth: `curl http://localhost:${this.port}/api/v1/mcpservers/github/auth`,
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

    const servers = this.provider.getAllServerInfos()
    const response: McpServersResponse = {
      servers,
      contextRef: '*',
      timestamp: new Date().toISOString(),
    }

    this.sendJson(res, 200, response)
  }

  /**
   * Handle GET /api/v1/mcpservers/context/:contextRef
   */
  private async handleListByContext(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    contextRef: string
  ): Promise<void> {
    console.log(`[Server] GET /api/v1/mcpservers/context/${contextRef}`)

    if (!contextRef) {
      this.sendJson(res, 400, { error: 'Bad Request', message: 'contextRef is required' })
      return
    }

    const servers = await this.provider.getServerInfosByContext(contextRef)
    const response: McpServersResponse = {
      servers,
      contextRef,
      timestamp: new Date().toISOString(),
    }

    this.sendJson(res, 200, response)
  }

  /**
   * Handle GET /api/v1/mcpservers/:name/auth
   */
  private async handleGetAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    serverName: string
  ): Promise<void> {
    console.log(`[Server] GET /api/v1/mcpservers/${serverName}/auth`)

    if (!serverName) {
      this.sendJson(res, 400, { error: 'Bad Request', message: 'serverName is required' })
      return
    }

    // Find the server
    const servers = this.provider.getAllServerInfos()
    const server = servers.find(s => s.name === serverName)

    if (!server) {
      this.sendJson(res, 404, { error: 'Not Found', message: `McpServer ${serverName} not found` })
      return
    }

    // Get the auth token via provider
    const token = await this.provider.getAuthToken(serverName)

    if (!token) {
      // Check if auth was configured but not found vs not configured at all
      if (server.auth?.secretRef) {
        this.sendJson(res, 404, {
          error: 'Not Found',
          message: `Auth token for ${serverName} not found`,
        })
      } else {
        this.sendJson(res, 200, { token: null, message: 'No auth configured for this server' })
      }
      return
    }

    this.sendJson(res, 200, { token })
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
    this.ready = false
    const activeServer = this.server
    this.server = null
    return new Promise(resolve => {
      if (activeServer) {
        activeServer.close(() => {
          console.log('[Server] Context Mapper stopped')
          resolve()
        })
      } else {
        resolve()
      }
    })
  }
}
