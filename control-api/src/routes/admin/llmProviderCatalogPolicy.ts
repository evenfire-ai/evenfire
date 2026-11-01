import { type Request, type Response, Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../http/asyncHandler.js'
import type { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import { rootLogger } from '../../observability/logger.js'
import {
  CatalogPolicyLockTimeoutError,
  isCatalogPolicyProvider,
  listProviderCatalogPolicy,
  setProviderAutoEnable,
} from '../../services/llmProviderCatalogSettings.js'

// `null` resets the provider to its code default; the key itself is required
// so an empty body cannot be read as a reset.
const setCatalogPolicySchema = z.object({ auto_enable: z.boolean().nullable() }).strict()

/** Sent verbatim; control-ui's tests read them from the generated wire contract. */
export const CATALOG_SYNC_IN_PROGRESS_STATUS = 503
export const CATALOG_SYNC_IN_PROGRESS_BODY = {
  error: 'catalog_sync_in_progress',
  message: 'a catalog sync is running and holds the policy lock; nothing was saved — retry shortly',
} as const

export const CATALOG_POLICY_NOT_FOUND_STATUS = 404
export const CATALOG_POLICY_NOT_FOUND_BODY = {
  error: 'not_found',
  message: 'provider has no catalog auto-enable policy',
} as const

const fallbackLog = rootLogger.child({ module: 'admin-llm-provider-catalog-policy' })

function sendZodError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: 'invalid_request',
    details: error.issues.map(issue => ({
      field: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  })
}

// Inherits the `/admin/*` control-ui admin auth gate (app.ts). The policy only
// decides whether NEWLY discovered models start enabled; existing rows and the
// runtime ConfigMap are untouched, so no re-materialization follows a toggle.
export function createAdminLlmProviderCatalogPolicyRouter(): Router {
  const router = Router()

  router.get(
    '/admin/llm-providers/catalog-policy',
    asyncHandler(async (_req: Request, res: Response) => {
      const providers = await listProviderCatalogPolicy()
      res.status(200).json({ providers })
    })
  )

  router.put(
    '/admin/llm-providers/:provider/catalog-policy',
    asyncHandler(async (req: Request, res: Response) => {
      const provider = req.params.provider
      if (!isCatalogPolicyProvider(provider)) {
        res.status(CATALOG_POLICY_NOT_FOUND_STATUS).json(CATALOG_POLICY_NOT_FOUND_BODY)
        return
      }
      const parsed = setCatalogPolicySchema.safeParse(req.body)
      if (!parsed.success) {
        sendZodError(res, parsed.error)
        return
      }
      const actor = (req as UiAuthedRequest).adminAuth?.sub ?? 'admin'
      const log = req.log ?? fallbackLog
      let outcome
      try {
        outcome = await setProviderAutoEnable(provider, parsed.data.auto_enable, actor)
      } catch (error) {
        if (error instanceof CatalogPolicyLockTimeoutError) {
          log.warn(
            { event: 'llm_provider_catalog_policy_lock_timeout', provider, actor },
            'catalog policy toggle timed out waiting for a running catalog sync'
          )
          res.status(CATALOG_SYNC_IN_PROGRESS_STATUS).json(CATALOG_SYNC_IN_PROGRESS_BODY)
          return
        }
        throw error
      }
      log.info(
        {
          event: 'llm_provider_catalog_policy_changed',
          provider,
          actor,
          previousAutoEnable: outcome.previousAutoEnable,
          autoEnable: outcome.policy.auto_enable,
          // Tells a reset (false) apart from setting the default explicitly.
          previousOverridden: outcome.previousOverridden,
          overridden: outcome.policy.overridden,
        },
        'llm provider catalog auto-enable policy changed'
      )
      res.status(200).json(outcome.policy)
    })
  )

  return router
}
