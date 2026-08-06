import type { Express, NextFunction, Request, Response } from 'express'
import type { PluginWorkloadSdkCapability } from '../../config'
import type { ClientNotificationsHandler } from '../clientNotifications/handler'
import { PluginWorkloadError } from '../domain/errors'
import type { PromptBridgeHandler } from '../promptBridge/handler'
import { createRateLimitMiddleware } from './middleware/rateLimit'
import { createWorkloadAuthMiddleware } from './middleware/workloadAuth'

/**
 * SDK route surface exposed to plugin workloads (plan §3.1):
 *
 *   POST /sdk/v1/prompt-bridge                      — one-shot LLM call
 *   POST /sdk/v1/client-notifications              — notification intent
 *   GET  /sdk/v1/client-notifications/recipients   — list allowed recipients
 *   GET  /live                                     — unauthenticated liveness
 *   GET  /health                                   — unauthenticated readiness
 *
 * Route families are projected by WRC. A host never exposes a capability that
 * is absent from that projection, even when the caller has a valid workload
 * token for another family.
 */

export interface PluginWorkloadSdkReadiness {
  ready: boolean
  reason?: string
}

export interface SdkRoutesOptions {
  capabilities: readonly PluginWorkloadSdkCapability[]
  workloadTokens: ReadonlyMap<string, string>
  promptBridgeHandler?: PromptBridgeHandler
  clientNotificationsHandler?: ClientNotificationsHandler
  readiness: () => PluginWorkloadSdkReadiness
  maxRequestsPerMinutePerWorkload: number
  maxConcurrentPerWorkload: number
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof PluginWorkloadError) {
    res.status(err.httpStatus).json(err.toBody())
    return
  }
  // Never leak internals to the workload (spec §17). Interpolate the error
  // into the message so the structured logger (src/logger.ts) preserves it —
  // a raw Error passed as a separate arg serializes to "{}".
  console.error(
    `[PluginWorkloadSdk] unexpected handler error: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }`
  )
  res.status(500).json({ error: 'internal_error', message: 'internal error', retryable: true })
}

export function registerSdkRoutes(app: Express, opts: SdkRoutesOptions): void {
  app.get('/live', (_req, res) => {
    res.status(200).json({ status: 'live' })
  })
  // Keep the old probe spelling as an observability alias only; it does not
  // restore any legacy workload route or authorization behavior.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'live' })
  })
  app.get('/health', (_req, res) => {
    const readiness = opts.readiness()
    res.status(readiness.ready ? 200 : 503).json({
      status: readiness.ready ? 'ready' : 'not_ready',
      ...(readiness.reason ? { reason: readiness.reason } : {}),
    })
  })

  const auth = createWorkloadAuthMiddleware(opts.workloadTokens)
  const rateLimit = createRateLimitMiddleware({
    maxRequestsPerMinute: opts.maxRequestsPerMinutePerWorkload,
    maxConcurrent: opts.maxConcurrentPerWorkload,
  })

  const capabilities = new Set(opts.capabilities)
  if (capabilities.has('promptBridge')) {
    if (!opts.promptBridgeHandler) {
      throw new Error('promptBridge route declared without a promptBridge handler')
    }
    const promptBridgeHandler = opts.promptBridgeHandler
    app.post(
      '/sdk/v1/prompt-bridge',
      auth,
      rateLimit,
      (req: Request, res: Response, _next: NextFunction) => {
        void promptBridgeHandler
          .handle(req.body, req.pluginWorkloadCallerRef!)
          .then(result => res.status(200).json(result))
          .catch(err => sendError(res, err))
      }
    )
  }

  if (capabilities.has('clientNotifications')) {
    if (!opts.clientNotificationsHandler) {
      throw new Error('clientNotifications routes declared without a notifications handler')
    }
    const notificationsHandler = opts.clientNotificationsHandler
    app.post(
      '/sdk/v1/client-notifications',
      auth,
      rateLimit,
      (req: Request, res: Response, _next: NextFunction) => {
        void notificationsHandler
          .handle(req.body, req.pluginWorkloadCallerRef!)
          .then(result => res.status(200).json(result))
          .catch(err => sendError(res, err))
      }
    )

    app.get(
      '/sdk/v1/client-notifications/recipients',
      auth,
      rateLimit,
      (req: Request, res: Response, _next: NextFunction) => {
        void notificationsHandler
          .listRecipients(req.pluginWorkloadCallerRef!)
          .then(recipients => res.status(200).json({ recipients }))
          .catch(err => sendError(res, err))
      }
    )
  }
}
