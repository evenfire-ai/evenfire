import { Router } from 'express'
import { config } from '../../config.js'
import { adminSubscriptionReadRateLimits } from '../workflows/shared/rateLimit.js'

/** Feature availability only: this never grants account/model execution authority. */
export function createAdminSubscriptionCapabilitiesRouter(): Router {
  const router = Router()
  router.get(
    '/admin/llm/providers/capabilities',
    ...adminSubscriptionReadRateLimits(),
    (_req, res) => {
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({
        providers: {
          'codex-subscription': { enabled: config.codexSubscriptionEnabled },
          'grok-subscription': { enabled: config.grokSubscriptionEnabled },
        },
      })
    }
  )
  return router
}
