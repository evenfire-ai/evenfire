import express, { type NextFunction, type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import type http from 'node:http'
import type { ConfigureResponse, PluginWorkloadSdkBootstrapRequest } from '../workflow/types'
import {
  requireWorkflowAuth,
  validateWorkflowBinding,
  workflowClaims,
} from '../workflow/workflowAuth'

const CONTROL_RATE_LIMIT_WINDOW_MS = 60_000
const CONTROL_RATE_LIMIT_MAX = 60
const CONTROL_RATE_LIMIT_MAX_BUCKETS = 10_000

export type PluginWorkloadSdkBootstrapHandler = (
  request: PluginWorkloadSdkBootstrapRequest
) => Promise<ConfigureResponse>

export interface PluginWorkloadSdkBootstrapServerOptions {
  port: number
  configure: PluginWorkloadSdkBootstrapHandler
}

/**
 * Minimal control surface for an sdk-only mcp-host. It intentionally does not
 * construct RPCServer or WorkflowService, so workflow execution, approval,
 * artifacts, coordinator configuration and standalone chat routes are absent.
 */
export class PluginWorkloadSdkBootstrapServer {
  private readonly app = express()
  private readonly rateLimitBuckets = new Map<string, { windowStart: number; count: number }>()
  private identityReady = false
  private server: http.Server | null = null

  constructor(private readonly opts: PluginWorkloadSdkBootstrapServerOptions) {
    this.app.disable('x-powered-by')
    // Bound invalid-token floods before Express parses request bodies. Scope
    // this guard to bootstrap so liveness/readiness cannot be starved by an
    // attacker exhausting an unrelated control bucket.
    this.app.use(
      '/api/v1/workflow/plugin-workload-sdk/bootstrap',
      rateLimit({
        windowMs: 60_000,
        limit: 600,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too Many Requests', retryable: true },
      })
    )
    this.app.use(express.json({ limit: '16kb' }))
    this.app.get('/v1/runtime/health', (_req, res) => {
      const ready = this.identityReady
      res.status(ready ? 200 : 503).json({
        status: ready ? 'healthy' : 'not_ready',
        mode: 'sdk-only',
        ready,
      })
    })
    // Kubernetes must be able to mark the Pod reachable before WRC can POST
    // the identity bootstrap. This probe proves that the bootstrap listener is
    // bound, not that the provider/policy identity has already been installed.
    // WRC uses the Ready transition to discover the Service endpoint and then
    // performs the authenticated bootstrap; `/health` remains the operational
    // post-bootstrap readiness signal for callers and diagnostics.
    this.app.get('/v1/runtime/bootstrap-ready', (_req, res) => {
      res.status(200).json({
        status: 'bootstrap_ready',
        mode: 'sdk-only',
        identityReady: this.identityReady,
      })
    })
    this.app.get('/v1/runtime/live', (_req, res) => {
      res.status(200).json({ status: 'alive', mode: 'sdk-only' })
    })
    this.app.post(
      '/api/v1/workflow/plugin-workload-sdk/bootstrap',
      requireWorkflowAuth('configure'),
      this.rateLimit,
      async (req, res) => {
        if (!validateWorkflowBinding(req, res, { expectedSub: 'wrc' })) return
        const raw = req.body as PluginWorkloadSdkBootstrapRequest
        // Identity-only projection: credential-shaped extras never cross the
        // handler boundary even if a caller includes them in the JSON object.
        const request: PluginWorkloadSdkBootstrapRequest = {
          capabilityFamily: raw?.capabilityFamily,
          provider: raw?.provider,
          model: raw?.model,
          ...(raw?.contractVersion === 2 || raw?.contractVersion === 3
            ? { contractVersion: raw.contractVersion }
            : {}),
          ...(raw?.codexBinding ? { codexBinding: raw.codexBinding } : {}),
        }
        try {
          const result = await this.opts.configure(request)
          this.identityReady = result.configured === true && result.ready !== false
          res.status(result.configured ? 200 : result.ready === false ? 503 : 400).json(result)
        } catch {
          this.identityReady = false
          res.status(503).json({
            configured: false,
            ready: false,
            contractVersion: 2,
            message: 'Plugin Workload SDK identity bootstrap contract is not ready',
          })
        }
      }
    )
    this.app.use((_req, res) => {
      res.status(404).json({ error: 'Not found' })
    })
  }

  private readonly rateLimit = (req: Request, res: Response, next: NextFunction): void => {
    const claims = workflowClaims(req)
    const key = claims
      ? `sdk-bootstrap:${claims.recipeNamespace}/${claims.recipeName}:${claims.sub}`
      : 'sdk-bootstrap:unauthenticated'
    const now = Date.now()
    const existing = this.rateLimitBuckets.get(key)
    const bucket =
      existing && now - existing.windowStart < CONTROL_RATE_LIMIT_WINDOW_MS
        ? existing
        : { windowStart: now, count: 0 }
    if (bucket.count >= CONTROL_RATE_LIMIT_MAX) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.windowStart + CONTROL_RATE_LIMIT_WINDOW_MS - now) / 1000)
      )
      res.setHeader('Retry-After', String(retryAfterSeconds))
      res.status(429).json({ error: 'Too Many Requests', retryAfterSeconds })
      return
    }
    bucket.count += 1
    this.rateLimitBuckets.set(key, bucket)
    if (this.rateLimitBuckets.size > CONTROL_RATE_LIMIT_MAX_BUCKETS) {
      const oldest = this.rateLimitBuckets.keys().next().value
      if (typeof oldest === 'string') this.rateLimitBuckets.delete(oldest)
    }
    next()
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('Plugin Workload SDK bootstrap server already started')
    await new Promise<void>((resolve, reject) => {
      const server = this.app.listen(this.opts.port, '0.0.0.0', () => resolve())
      server.once('error', reject)
      this.server = server
    })
    console.log(`[PluginWorkloadSdk] SDK-only bootstrap server started on port ${this.opts.port}`)
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
