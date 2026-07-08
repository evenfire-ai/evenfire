import type { Express, NextFunction, Request, Response } from 'express'
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
 *   GET  /healthz                                  — unauthenticated liveness
 */

export interface SdkRoutesOptions {
  workloadTokens: ReadonlyMap<string, string>
  promptBridgeHandler: PromptBridgeHandler
  clientNotificationsHandler: ClientNotificationsHandler
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
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true })
  })

  const auth = createWorkloadAuthMiddleware(opts.workloadTokens)
  const rateLimit = createRateLimitMiddleware({
    maxRequestsPerMinute: opts.maxRequestsPerMinutePerWorkload,
    maxConcurrent: opts.maxConcurrentPerWorkload,
  })

  app.post(
    '/sdk/v1/prompt-bridge',
    auth,
    rateLimit,
    (req: Request, res: Response, _next: NextFunction) => {
      void opts.promptBridgeHandler
        .handle(req.body, req.pluginWorkloadCallerRef!)
        .then(result => res.status(200).json(result))
        .catch(err => sendError(res, err))
    }
  )

  app.post(
    '/sdk/v1/client-notifications',
    auth,
    rateLimit,
    (req: Request, res: Response, _next: NextFunction) => {
      void opts.clientNotificationsHandler
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
      void opts.clientNotificationsHandler
        .listRecipients(req.pluginWorkloadCallerRef!)
        .then(recipients => res.status(200).json({ recipients }))
        .catch(err => sendError(res, err))
    }
  )
}
