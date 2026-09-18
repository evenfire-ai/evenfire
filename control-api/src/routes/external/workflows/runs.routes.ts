import { type Request, type Response, Router } from 'express'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type { K8sGateway } from '../../../k8s.js'
import { scheduleAccessCatalogShadow } from '../../../services/access/accessCatalogShadow.js'
import { K8sNotFoundError } from '../../../services/resourceService.js'
import {
  ensureRecipeAuthorized,
  isRecipeNamespaceAllowed,
} from '../../../services/workflows/workflowRecipeAccessService.js'
import {
  WorkflowArtifactHttpError,
  downloadWorkflowRunArtifact,
  listWorkflowRunArtifacts,
} from '../../../services/workflows/workflowRunArtifactService.js'
import { listCanonicalRuns } from '../../../services/workflows/workflowRunReadService.js'
import { requireBoundExternalWorkflowCaller } from '../../workflows/shared/auth.js'
import { parseLimit } from '../../workflows/shared/validation.js'
import { externalWorkflowReadAdmission } from './admission.js'

const BASE = '/external/workflows'

function sendArtifactError(res: Response, err: unknown): void {
  if (err instanceof WorkflowArtifactHttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  if (err instanceof K8sNotFoundError) {
    res.status(404).json({ error: 'Workflow run artifact resource not found' })
    return
  }
  throw err
}

function sendDownloadResult(
  res: Response,
  result: Awaited<ReturnType<typeof downloadWorkflowRunArtifact>>
): void {
  if (Buffer.isBuffer(result.body)) {
    res.status(result.status)
    for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value)
    res.end(result.body)
    return
  }
  res.status(result.status).json(result.body)
}

export function createExternalWorkflowRunsRoutes(gateway: K8sGateway): Router {
  const router = Router()

  router.get(
    `${BASE}/:ns/:name/runs`,
    ...externalWorkflowReadAdmission,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireBoundExternalWorkflowCaller(req, res)
      if (!caller) return

      const { ns, name } = req.params
      if (!isRecipeNamespaceAllowed(ns)) {
        res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
        return
      }
      if (!(await ensureRecipeAuthorized(caller, ns, name))) {
        res.status(403).json({ error: 'Not authorized to view runs for this recipe' })
        return
      }

      const limit = parseLimit(req.query?.limit)
      const items = await listCanonicalRuns(ns, name, limit, caller)
      if (caller.kind === 'user-session') {
        scheduleAccessCatalogShadow({
          session: caller.session,
          family: 'workflow_run',
          legacyLogicalIds: items.map(item => item.id),
          legacyComplete: items.length < limit,
          scope: {
            kind: 'relationship',
            type: 'recipe',
            targetResourceId: `workflow_recipe:${ns}/${name}`,
          },
        })
      }
      res.json({ items, count: items.length })
    })
  )

  router.get(
    `${BASE}/:ns/:name/runs/:runId/artifacts`,
    ...externalWorkflowReadAdmission,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireBoundExternalWorkflowCaller(req, res)
      if (!caller) return

      try {
        const artifacts = await listWorkflowRunArtifacts({
          gateway,
          caller,
          recipeNamespace: req.params.ns,
          recipeName: req.params.name,
          runId: req.params.runId,
        })
        res.json({ artifacts })
      } catch (err) {
        sendArtifactError(res, err)
      }
    })
  )

  router.get(
    `${BASE}/:ns/:name/runs/:runId/artifacts/:artifactName/download`,
    ...externalWorkflowReadAdmission,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireBoundExternalWorkflowCaller(req, res)
      if (!caller) return

      try {
        const result = await downloadWorkflowRunArtifact({
          gateway,
          caller,
          recipeNamespace: req.params.ns,
          recipeName: req.params.name,
          runId: req.params.runId,
          artifactName: req.params.artifactName,
        })
        sendDownloadResult(res, result)
      } catch (err) {
        sendArtifactError(res, err)
      }
    })
  )

  return router
}
