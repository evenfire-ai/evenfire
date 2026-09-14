import { type Request, type Response, Router } from 'express'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type { K8sGateway } from '../../../k8s.js'
import { rootLogger } from '../../../observability/logger.js'
import type { TriggerBody } from '../../../services/workflows/types.js'
import {
  WorkflowAuthorityError,
  captureWorkflowTriggerAuthorityFence,
  requireCurrentWorkflowTriggerAuthority,
  requireWorkflowActionAuthority,
} from '../../../services/workflows/workflowAuthorityBindingService.js'
import { getCallerDisplayId } from '../../../services/workflows/workflowCallerService.js'
import { asRecord } from '../../../services/workflows/workflowRecipeAccessService.js'
import { mapDbRun } from '../../../services/workflows/workflowRunReadService.js'
import {
  WorkflowTriggerHttpError,
  triggerWorkflow,
} from '../../../services/workflows/workflowTriggerService.js'
import { requireBoundExternalWorkflowCaller } from '../../workflows/shared/auth.js'
import { externalWorkflowTriggerAdmission } from './admission.js'

const BASE = '/external/workflows'
const logger = rootLogger.child({ module: 'external-workflows' })

export function createExternalWorkflowTriggerRoutes(gateway: K8sGateway): Router {
  const router = Router()

  router.post(
    `${BASE}/:ns/:name/trigger`,
    ...externalWorkflowTriggerAdmission,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireBoundExternalWorkflowCaller(req, res)
      if (!caller) return

      const { ns, name } = req.params
      const body = (asRecord(req.body) ?? {}) as TriggerBody
      const idempotencyKey = String(req.headers['idempotency-key'] || '').trim()

      try {
        const authorityInput = {
          req,
          caller,
          operationId: 'workflow.trigger',
          resourceType: 'workflow_recipe',
          resourceLogicalId: `${ns}/${name}`,
          target: Object.freeze({ recipeNamespace: ns, recipeName: name }),
          gateway,
        } as const
        const authority = await requireWorkflowActionAuthority(authorityInput)
        let phaseOneFence: Awaited<ReturnType<typeof captureWorkflowTriggerAuthorityFence>> | null =
          null
        const result = await triggerWorkflow({
          gateway,
          caller,
          recipeNamespace: ns,
          recipeName: name,
          body,
          idempotencyKey,
          correlationId: req.correlationId,
          authority,
          reauthorize: async () => {
            if (!authority) return null
            const before = await captureWorkflowTriggerAuthorityFence({ authority })
            const current = await requireWorkflowActionAuthority(authorityInput)
            if (!current || current.bindingHash !== authority.bindingHash) {
              throw new WorkflowAuthorityError(409, 'access_path_stale')
            }
            const after = await captureWorkflowTriggerAuthorityFence({ authority: current })
            if (before.fingerprint !== after.fingerprint) {
              throw new WorkflowAuthorityError(409, 'access_path_stale')
            }
            phaseOneFence = after
            return current
          },
          validateCurrentInTransaction: (db, phaseOneAuthority) => {
            if (!phaseOneFence) {
              throw new WorkflowAuthorityError(409, 'access_path_stale')
            }
            return requireCurrentWorkflowTriggerAuthority({
              db,
              authority: phaseOneAuthority,
              expectedFence: phaseOneFence,
            })
          },
        })

        if (result.kind === 'approval') {
          logger.info(
            {
              approvalRequestId: result.approvalRequestId,
              recipe: `${ns}/${name}`,
              caller: caller.kind,
              callerId: getCallerDisplayId(caller),
              idempotencyHit: Boolean(result.existing),
            },
            result.existing
              ? 'Workflow trigger approval idempotency hit'
              : 'Workflow trigger approval requested'
          )

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
        if (err instanceof WorkflowAuthorityError) {
          res.status(err.status).json({ error: err.code })
          return
        }
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
