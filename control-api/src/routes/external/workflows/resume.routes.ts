import { type Request, type Response, Router } from 'express'
import { pool } from '../../../db.js'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type { K8sGateway } from '../../../k8s.js'
import {
  WorkflowAuthorityError,
  requireWorkflowActionAuthority,
} from '../../../services/workflows/workflowAuthorityBindingService.js'
import { mapDbRun } from '../../../services/workflows/workflowRunReadService.js'
import {
  WorkflowRunResumeError,
  resumeWorkflowRun,
} from '../../../services/workflows/workflowRunResumeService.js'
import { requireBoundExternalWorkflowCaller } from '../../workflows/shared/auth.js'
import { externalWorkflowTriggerAdmission } from './admission.js'

const BASE = '/external/workflows'

export function createExternalWorkflowResumeRoutes(gateway: K8sGateway): Router {
  const router = Router()

  router.post(
    `${BASE}/:ns/:name/runs/:runId/resume`,
    ...externalWorkflowTriggerAdmission,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireBoundExternalWorkflowCaller(req, res)
      if (!caller) return

      const { ns, name, runId } = req.params
      try {
        const authority = await requireWorkflowActionAuthority({
          req,
          caller,
          operationId: 'workflow.run.manage',
          resourceType: 'workflow_run',
          resourceLogicalId: runId,
          target: Object.freeze({ runId, action: 'resume' }),
          gateway,
        })
        if (!authority) {
          res.status(409).json({ error: 'workflow_run_not_paused' })
          return
        }
        const row = await resumeWorkflowRun({
          runId,
          recipeNamespace: ns,
          recipeName: name,
          authority,
          gateway,
          db: pool,
        })
        res.json({ run: mapDbRun(row) })
      } catch (error) {
        if (error instanceof WorkflowAuthorityError) {
          res.status(error.status).json({ error: error.code })
          return
        }
        if (error instanceof WorkflowRunResumeError) {
          res.status(error.status).json({ error: error.code })
          return
        }
        throw error
      }
    })
  )

  return router
}
