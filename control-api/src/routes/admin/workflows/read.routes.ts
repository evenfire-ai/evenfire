import { type Request, type Response, Router } from 'express'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type { K8sGateway } from '../../../k8s.js'
import { K8sNotFoundError } from '../../../services/resourceService.js'
import {
  WORKFLOW_RECIPE_PLURAL,
  asRecord,
  ensureRecipeAuthorized,
  getAuthorizedRecipeResources,
  isRecipeNamespaceAllowed,
} from '../../../services/workflows/workflowRecipeAccessService.js'
import { getWorkflowHealth } from '../../../services/workflows/workflowRunReadService.js'
import {
  bindAdminWorkflowAuth,
  requireBoundAdminWorkflowCaller,
} from '../../workflows/shared/auth.js'
import { workflowAdminReadRateLimits } from '../../workflows/shared/rateLimit.js'

const BASE = '/admin/workflows'

export function createAdminWorkflowReadRoutes(gateway: K8sGateway): Router {
  const router = Router()
  const readRateLimits = workflowAdminReadRateLimits()

  router.get(
    BASE,
    ...readRateLimits,
    bindAdminWorkflowAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireBoundAdminWorkflowCaller(req, res)
      if (!caller) return

      const recipes = await getAuthorizedRecipeResources(caller, gateway)
      res.json({ items: recipes, count: recipes.length })
    })
  )

  router.get(
    `${BASE}/:ns/:name`,
    ...readRateLimits,
    bindAdminWorkflowAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireBoundAdminWorkflowCaller(req, res)
      if (!caller) return

      const { ns, name } = req.params
      if (!isRecipeNamespaceAllowed(ns)) {
        res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
        return
      }
      if (!(await ensureRecipeAuthorized(caller, ns, name))) {
        res.status(403).json({ error: 'Not authorized to view this recipe' })
        return
      }

      try {
        const resource = await gateway.getResource(WORKFLOW_RECIPE_PLURAL, name, ns)
        res.json(resource)
      } catch (err) {
        if (err instanceof K8sNotFoundError) {
          res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
          return
        }
        throw err
      }
    })
  )

  router.get(
    `${BASE}/:ns/:name/health`,
    ...readRateLimits,
    bindAdminWorkflowAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireBoundAdminWorkflowCaller(req, res)
      if (!caller) return

      const { ns, name } = req.params
      if (!isRecipeNamespaceAllowed(ns)) {
        res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
        return
      }
      if (!(await ensureRecipeAuthorized(caller, ns, name))) {
        res.status(403).json({ error: 'Not authorized to view this recipe health' })
        return
      }

      try {
        const resource = (await gateway.getResource(WORKFLOW_RECIPE_PLURAL, name, ns)) as Record<
          string,
          unknown
        >
        const status = asRecord(resource.status) ?? {}
        const { activeRuns, lastRun } = await getWorkflowHealth(ns, name)
        res.json({
          recipe: `${ns}/${name}`,
          phase: status.phase ?? 'Unknown',
          workflowPhase: asRecord(status.workflowExecution)?.phase ?? null,
          activeRuns,
          lastRun,
          conditions: status.conditions ?? [],
        })
      } catch (err) {
        if (err instanceof K8sNotFoundError) {
          res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
          return
        }
        throw err
      }
    })
  )

  return router
}
