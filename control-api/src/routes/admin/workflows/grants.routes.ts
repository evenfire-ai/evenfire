import { type Request, type Response, Router } from 'express'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type { K8sGateway } from '../../../k8s.js'
import { rootLogger } from '../../../observability/logger.js'
import { runWithAdministrativeRequestContext } from '../../../services/tracing/adminOperationContext.js'
import {
  WorkflowGrantHttpError,
  allowWorkflowRecipeApprovalTeam,
  listWorkflowRecipeApprovalTeams,
  listWorkflowRecipeGrants,
  listWorkflowRecipeTeamGrants,
  replaceWorkflowRecipeGrants,
  replaceWorkflowRecipeTeamGrants,
  revokeWorkflowRecipeApprovalTeam,
} from '../../../services/workflows/workflowGrantManagementService.js'
import { requireAdminWorkflowCaller } from '../../workflows/shared/auth.js'
import {
  workflowGrantReadRateLimit,
  workflowGrantWriteRateLimit,
} from '../../workflows/shared/rateLimit.js'

const BASE = '/admin/workflows'
const logger = rootLogger.child({ module: 'admin-workflow-grants' })

function withAdministrativeTraceContext<T>(req: Request, operatorSub: string, work: () => T): T {
  return runWithAdministrativeRequestContext(
    { operatorSub, requestId: req.correlationId ?? null },
    work
  )
}

// This router owns two related admin surfaces:
// - /admin/workflows/... manages trigger grants for recipe execution.
// - /admin/workflow-recipes/.../allowed-teams manages approval target allowlists.
// Keep them separate because trigger grants and approval targets are separate
// product contracts, even though both mutate workflow authorization policy.
export function createAdminWorkflowGrantRoutes(gateway: K8sGateway): Router {
  const router = Router()

  router.get(
    `${BASE}/:ns/:name/grants`,
    workflowGrantReadRateLimit(),
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      try {
        const users = await listWorkflowRecipeGrants(gateway, req.params.ns, req.params.name)
        res.status(200).json({ items: users })
      } catch (err) {
        if (err instanceof WorkflowGrantHttpError) {
          res.status(err.status).json(err.body)
          return
        }
        throw err
      }
    })
  )

  router.put(
    `${BASE}/:ns/:name/grants`,
    workflowGrantWriteRateLimit(),
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      try {
        const result = await withAdministrativeTraceContext(req, caller.userId, () =>
          replaceWorkflowRecipeGrants({
            gateway,
            recipeNamespace: req.params.ns,
            recipeName: req.params.name,
            operatorUserId: caller.userId,
            rawUserIds: (req.body as { userIds?: unknown } | undefined)?.userIds,
          })
        )

        logger.info(
          {
            event: 'workflow_grants_replace',
            recipe: `${req.params.ns}/${req.params.name}`,
            operator: caller.userId,
            total: result.userIds.length,
            added: result.added,
            removed: result.removed,
          },
          'Workflow grants replaced'
        )

        res.status(200).json({
          userIds: result.userIds,
          added: result.added,
          removed: result.removed,
        })
      } catch (err) {
        if (err instanceof WorkflowGrantHttpError) {
          res.status(err.status).json(err.body)
          return
        }
        throw err
      }
    })
  )

  router.get(
    `${BASE}/:ns/:name/team-grants`,
    workflowGrantReadRateLimit(),
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      try {
        const teams = await listWorkflowRecipeTeamGrants(gateway, req.params.ns, req.params.name)
        res.status(200).json({ items: teams })
      } catch (err) {
        if (err instanceof WorkflowGrantHttpError) {
          res.status(err.status).json(err.body)
          return
        }
        throw err
      }
    })
  )

  router.put(
    `${BASE}/:ns/:name/team-grants`,
    workflowGrantWriteRateLimit(),
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      try {
        const result = await withAdministrativeTraceContext(req, caller.userId, () =>
          replaceWorkflowRecipeTeamGrants({
            gateway,
            recipeNamespace: req.params.ns,
            recipeName: req.params.name,
            operatorUserId: caller.userId,
            rawTeamIds: (req.body as { teamIds?: unknown } | undefined)?.teamIds,
          })
        )

        logger.info(
          {
            event: 'workflow_team_grants_replace',
            recipe: `${req.params.ns}/${req.params.name}`,
            operator: caller.userId,
            total: result.teamIds.length,
            added: result.added,
            removed: result.removed,
          },
          'Workflow team grants replaced'
        )

        res.status(200).json({
          teamIds: result.teamIds,
          added: result.added,
          removed: result.removed,
        })
      } catch (err) {
        if (err instanceof WorkflowGrantHttpError) {
          res.status(err.status).json(err.body)
          return
        }
        throw err
      }
    })
  )

  router.get(
    `/admin/workflow-recipes/:ns/:name/allowed-teams`,
    workflowGrantReadRateLimit(),
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      try {
        const teams = await listWorkflowRecipeApprovalTeams({
          gateway,
          recipeNamespace: req.params.ns,
          recipeName: req.params.name,
        })
        res.status(200).json({ items: teams })
      } catch (err) {
        if (err instanceof WorkflowGrantHttpError) {
          res.status(err.status).json(err.body)
          return
        }
        throw err
      }
    })
  )

  router.put(
    `/admin/workflow-recipes/:ns/:name/allowed-teams/:teamId`,
    workflowGrantWriteRateLimit(),
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      try {
        const result = await withAdministrativeTraceContext(req, caller.userId, () =>
          allowWorkflowRecipeApprovalTeam({
            gateway,
            recipeNamespace: req.params.ns,
            recipeName: req.params.name,
            actorUserId: caller.userId,
            teamId: req.params.teamId,
          })
        )

        logger.info(
          {
            event: 'workflow_approval_team_allowed',
            recipe: `${req.params.ns}/${req.params.name}`,
            operator: caller.userId,
            teamId: result.teamId,
          },
          'Workflow approval team allowed'
        )

        res.status(200).json(result)
      } catch (err) {
        if (err instanceof WorkflowGrantHttpError) {
          res.status(err.status).json(err.body)
          return
        }
        throw err
      }
    })
  )

  router.delete(
    `/admin/workflow-recipes/:ns/:name/allowed-teams/:teamId`,
    workflowGrantWriteRateLimit(),
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      try {
        const result = await withAdministrativeTraceContext(req, caller.userId, () =>
          revokeWorkflowRecipeApprovalTeam({
            gateway,
            recipeNamespace: req.params.ns,
            recipeName: req.params.name,
            actorUserId: caller.userId,
            teamId: req.params.teamId,
          })
        )

        logger.info(
          {
            event: 'workflow_approval_team_revoked',
            recipe: `${req.params.ns}/${req.params.name}`,
            operator: caller.userId,
            teamId: result.teamId,
            removed: result.removed,
          },
          'Workflow approval team revoked'
        )

        res.status(200).json(result)
      } catch (err) {
        if (err instanceof WorkflowGrantHttpError) {
          res.status(err.status).json(err.body)
          return
        }
        throw err
      }
    })
  )

  return router
}
