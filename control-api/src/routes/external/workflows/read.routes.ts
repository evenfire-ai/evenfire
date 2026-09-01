import { type Request, type Response, Router } from 'express'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type { K8sGateway } from '../../../k8s.js'
import { scheduleAccessCatalogShadow } from '../../../services/access/accessCatalogShadow.js'
import { K8sNotFoundError } from '../../../services/resourceService.js'
import {
  WORKFLOW_RECIPE_PLURAL,
  asRecord,
  ensureRecipeAuthorized,
  getAuthorizedRecipeResources,
  isRecipeNamespaceAllowed,
} from '../../../services/workflows/workflowRecipeAccessService.js'
import { getWorkflowHealth } from '../../../services/workflows/workflowRunReadService.js'
import { requireBoundExternalWorkflowCaller } from '../../workflows/shared/auth.js'
import { externalWorkflowReadAdmission } from './admission.js'

const BASE = '/external/workflows'

export function createExternalWorkflowReadRoutes(gateway: K8sGateway): Router {
  const router = Router()

  router.get(
    BASE,
    ...externalWorkflowReadAdmission,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireBoundExternalWorkflowCaller(req, res)
      if (!caller) return

      const recipes = await getAuthorizedRecipeResources(caller, gateway)
      if (caller.kind === 'user-session') {
        const recipeIds: string[] = []
        const appIds: string[] = []
        for (const recipe of recipes) {
          const metadata = asRecord(recipe.metadata)
          const spec = asRecord(recipe.spec)
          const ui = asRecord(spec?.ui)
          const namespace = typeof metadata?.namespace === 'string' ? metadata.namespace : ''
          const name = typeof metadata?.name === 'string' ? metadata.name : ''
          if (!namespace || !name) continue
          const logicalId = `${namespace}/${name}`
          recipeIds.push(logicalId)
          if (
            typeof ui?.workloadRef === 'string' &&
            ui.workloadRef.trim() &&
            Number.isInteger(ui?.port) &&
            Number(ui.port) >= 1 &&
            Number(ui.port) <= 65_535
          ) {
            appIds.push(logicalId)
          }
        }
        scheduleAccessCatalogShadow({
          session: caller.session,
          family: 'workflow_recipe',
          legacyLogicalIds: recipeIds,
          legacyComplete: true,
        })
        scheduleAccessCatalogShadow({
          session: caller.session,
          family: 'sandbox_app',
          legacyLogicalIds: appIds,
          legacyComplete: true,
        })
      }
      res.json({ items: recipes, count: recipes.length })
    })
  )

  router.get(
    `${BASE}/:ns/:name`,
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
        res.status(403).json({ error: 'Not authorized to view this recipe health' })
        return
      }

      try {
        const resource = (await gateway.getResource(WORKFLOW_RECIPE_PLURAL, name, ns)) as Record<
          string,
          unknown
        >
        const status = asRecord(resource.status) ?? {}
        const { activeRuns, lastRun } = await getWorkflowHealth(ns, name, caller)
        res.json({
          recipe: `${ns}/${name}`,
          phase: status.phase ?? 'Unknown',
          workflowPhase: asRecord(status.workflowExecution)?.phase ?? null,
          activeRuns,
          lastRun,
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
