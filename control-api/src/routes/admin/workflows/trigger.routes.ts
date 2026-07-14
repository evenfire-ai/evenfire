import { type Request, type Response, Router } from 'express'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type { K8sGateway } from '../../../k8s.js'
import { rootLogger } from '../../../observability/logger.js'
import type { TriggerBody } from '../../../services/workflows/types.js'
import { getCallerDisplayId } from '../../../services/workflows/workflowCallerService.js'
import { asRecord } from '../../../services/workflows/workflowRecipeAccessService.js'
import { mapDbRun } from '../../../services/workflows/workflowRunReadService.js'
import {
  WorkflowTriggerHttpError,
  triggerWorkflow,
} from '../../../services/workflows/workflowTriggerService.js'
import { requireAdminWorkflowCaller } from '../../workflows/shared/auth.js'
import { workflowTriggerRateLimit } from '../../workflows/shared/rateLimit.js'

const BASE = '/admin/workflows'
const logger = rootLogger.child({ module: 'admin-workflows' })

export function createAdminWorkflowTriggerRoutes(gateway: K8sGateway): Router {
  const router = Router()

  router.post(
    `${BASE}/:ns/:name/trigger`,
    workflowTriggerRateLimit(),
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      const { ns, name } = req.params
      const body = (asRecord(req.body) ?? {}) as TriggerBody
      const idempotencyKey = String(req.headers['idempotency-key'] || '').trim()

      try {
        const result = await triggerWorkflow({
          gateway,
          caller,
          recipeNamespace: ns,
          recipeName: name,
          body,
          idempotencyKey,
          correlationId: req.correlationId,
        })

        if (result.kind === 'approval') {
          // Defensive for future caller modes. The current admin-ui lane creates
          // operator-attributed runs directly rather than user approvals.
          res.status(result.existing ? 200 : 202).json({
            approvalRequired: true,
            approvalRequestId: result.approvalRequestId,
            status: result.status,
            ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
          })
          return
        }

        const { row, created } = result

        logger.info(
          {
            runId: row.run_id,
            recipe: `${ns}/${name}`,
            caller: caller.kind,
            callerId: getCallerDisplayId(caller),
            idempotencyHit: !created,
          },
          created ? 'WorkflowRun created (DB)' : 'WorkflowRun idempotency hit (DB)'
        )

        res.status(created ? 201 : 200).json(mapDbRun(row))
      } catch (err) {
        if (err instanceof WorkflowTriggerHttpError) {
          res.status(err.status).json(err.body)
          return
        }
        throw err
      }
    })
  )

  return router
}
