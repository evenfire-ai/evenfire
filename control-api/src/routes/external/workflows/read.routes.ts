import { type Request, type Response, Router } from 'express'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type { K8sGateway } from '../../../k8s.js'
import { K8sNotFoundError } from '../../../services/resourceService.js'
import {
  WorkflowAuthorityError,
  requireWorkflowActionAuthority,
} from '../../../services/workflows/workflowAuthorityBindingService.js'
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
import { auditAuthorizedWorkflowRead } from './readAudit.js'

const BASE = '/external/workflows'

async function authorizeRecipeRead(
  req: Request,
  gateway: K8sGateway,
  caller: Parameters<typeof requireWorkflowActionAuthority>[0]['caller'],
  recipeNamespace: string,
  recipeName: string,
  entityType: string
): Promise<Awaited<ReturnType<typeof requireWorkflowActionAuthority>>> {
  return requireWorkflowActionAuthority({
    req,
    caller,
    operationId: 'workflow.read',
    resourceType: 'workflow_recipe',
    resourceLogicalId: `${recipeNamespace}/${recipeName}`,
    target: Object.freeze({ recipeNamespace, recipeName }),
    gateway,
  })
}

export function createExternalWorkflowReadRoutes(gateway: K8sGateway): Router {
  const router = Router()

  router.get(
    BASE,
    ...externalWorkflowReadAdmission,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireBoundExternalWorkflowCaller(req, res)
      if (!caller) return

      const recipes = await getAuthorizedRecipeResources(caller, gateway)
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
        const authority = await authorizeRecipeRead(
          req,
          gateway,
          caller,
          ns,
          name,
          'workflow_recipe'
        )
        const resource = await gateway.getResource(WORKFLOW_RECIPE_PLURAL, name, ns)
        if (authority) {
          auditAuthorizedWorkflowRead(authority, {
            entityType: 'workflow_recipe',
            entityId: `${ns}/${name}`,
          })
        }
        res.json(resource)
      } catch (err) {
        if (err instanceof K8sNotFoundError) {
          res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
          return
        }
        if (err instanceof WorkflowAuthorityError) {
          res.status(err.status).json({ error: err.code })
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
        const authority = await authorizeRecipeRead(
          req,
          gateway,
          caller,
          ns,
          name,
          'workflow_recipe'
        )
        const resource = (await gateway.getResource(WORKFLOW_RECIPE_PLURAL, name, ns)) as Record<
          string,
          unknown
        >
        const status = asRecord(resource.status) ?? {}
        const { activeRuns, lastRun } = await getWorkflowHealth(ns, name, caller)
        if (authority) {
          auditAuthorizedWorkflowRead(authority, {
            entityType: 'workflow_recipe',
            entityId: `${ns}/${name}`,
          })
        }
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
        if (err instanceof WorkflowAuthorityError) {
          res.status(err.status).json({ error: err.code })
          return
        }
        throw err
      }
    })
  )

  return router
}
