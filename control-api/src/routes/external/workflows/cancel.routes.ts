import { type Request, type Response, Router } from 'express'
import { pool } from '../../../db.js'
import { asyncHandler } from '../../../http/asyncHandler.js'
import {
  WorkflowRunCancelError,
  cancelWorkflowRun,
} from '../../../services/workflows/workflowRunCancelService.js'
import { mapDbRun } from '../../../services/workflows/workflowRunReadService.js'
import { requireBoundExternalWorkflowCaller } from '../../workflows/shared/auth.js'
import { externalWorkflowTriggerAdmission } from './admission.js'

const BASE = '/external/workflows'

// Cancel needs a live session and no delegation: V1 and V2 sessions take the
// same path, and the permission check reads only the run row and, for an
// admin, the caller's live team membership and the scope team's live grant on
// the run's recipe.
export function createExternalWorkflowCancelRoutes(): Router {
  const router = Router()

  router.post(
    `${BASE}/:ns/:name/runs/:runId/cancel`,
    ...externalWorkflowTriggerAdmission,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireBoundExternalWorkflowCaller(req, res)
      if (!caller) return

      const { ns, name, runId } = req.params
      try {
        const row = await cancelWorkflowRun({
          runId,
          recipeNamespace: ns,
          recipeName: name,
          caller,
          db: pool,
        })
        res.json({ run: mapDbRun(row) })
      } catch (error) {
        if (error instanceof WorkflowRunCancelError) {
          res.status(error.status).json({ error: error.code })
          return
        }
        throw error
      }
    })
  )

  return router
}
