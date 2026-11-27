import { type Request, type Response, Router } from 'express'
import { pool } from '../../../db.js'
import { asyncHandler } from '../../../http/asyncHandler.js'
import { rootLogger } from '../../../observability/logger.js'
import { getCallerDisplayId } from '../../../services/workflows/workflowCallerService.js'
import {
  ensureRecipeAuthorized,
  isRecipeNamespaceAllowed,
} from '../../../services/workflows/workflowRecipeAccessService.js'
import {
  WorkflowRunCancelError,
  cancelWorkflowRunAsOperator,
} from '../../../services/workflows/workflowRunCancelService.js'
import { mapDbRun } from '../../../services/workflows/workflowRunReadService.js'
import {
  bindAdminWorkflowAuth,
  requireBoundAdminWorkflowCaller,
} from '../../workflows/shared/auth.js'
import { adminWorkflowTriggerRateLimit } from '../../workflows/shared/rateLimit.js'
import { isUuid } from '../../workflows/shared/validation.js'

const BASE = '/admin/workflows'
const logger = rootLogger.child({ module: 'admin-workflows' })

/**
 * Operator cancel of a workflow run. It shares the admin trigger budget and
 * reads no Kubernetes resource, so a run whose recipe CR was deleted can still
 * be cancelled.
 */
export function createAdminWorkflowCancelRoutes(): Router {
  const router = Router()

  router.post(
    `${BASE}/:ns/:name/runs/:runId/cancel`,
    adminWorkflowTriggerRateLimit(),
    bindAdminWorkflowAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireBoundAdminWorkflowCaller(req, res)
      if (!caller) return

      const { ns, name, runId } = req.params
      if (!isRecipeNamespaceAllowed(ns)) {
        res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
        return
      }
      if (!(await ensureRecipeAuthorized(caller, ns, name))) {
        res.status(403).json({ error: 'Not authorized to cancel runs for this recipe' })
        return
      }
      if (!isUuid(runId)) {
        res.status(400).json({ error: 'Invalid workflow run id' })
        return
      }

      try {
        const row = await cancelWorkflowRunAsOperator({
          runId,
          recipeNamespace: ns,
          recipeName: name,
          operatorId: caller.userId,
          db: pool,
        })
        logger.info(
          {
            runId: row.run_id,
            recipe: `${ns}/${name}`,
            caller: caller.kind,
            callerId: getCallerDisplayId(caller),
            phase: row.phase,
          },
          'WorkflowRun cancel requested (operator)'
        )
        res.status(200).json(mapDbRun(row, 'admin'))
      } catch (err) {
        if (err instanceof WorkflowRunCancelError) {
          res.status(err.status).json({ error: err.code })
          return
        }
        throw err
      }
    })
  )

  return router
}
