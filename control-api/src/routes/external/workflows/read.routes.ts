import { type Request, type Response, Router } from 'express'
import { pool } from '../../../db.js'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type { K8sGateway } from '../../../k8s.js'
import { scheduleAccessCatalogShadow } from '../../../services/access/accessCatalogShadow.js'
import { K8sNotFoundError } from '../../../services/resourceService.js'
import {
  WorkflowAuthorityError,
  persistWorkflowAuthorityBinding,
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

async function persistSuccessfulRecipeRead(
  authority: Exclude<Awaited<ReturnType<typeof requireWorkflowActionAuthority>>, null>,
  recipeNamespace: string,
  recipeName: string,
  entityType: string
): Promise<void> {
  await persistWorkflowAuthorityBinding(pool, {
    authority,
    kind: 'workflow_read',
    entityType,
    entityId: `${recipeNamespace}/${recipeName}`,
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
          await persistSuccessfulRecipeRead(authority, ns, name, 'workflow_recipe')
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
          await persistSuccessfulRecipeRead(authority, ns, name, 'workflow_recipe')
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
