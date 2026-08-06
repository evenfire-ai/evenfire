import { type Response, Router } from 'express'
import { asyncHandler } from '../../http/asyncHandler.js'
import type { K8sGateway } from '../../k8s.js'
import type { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import {
  filterAccessValues,
  mergeActiveUpdateWithDeletedHistory,
  partitionAccessValues,
} from '../../services/directory/accessReconciliation.js'
import {
  TeamNameConflictError,
  addMemberToTeam,
  adminDeleteTeam,
  createTeam,
  getTeamById,
  listAllPendingInvitationsAdmin,
  listAllTeams,
  listMembers,
  listTeamAgentsByTeam,
  listTeamContextsByTeam,
  listUsers,
  renameTeam,
  softDeleteMember,
  updateMemberRole,
} from '../../services/directory/index.js'
import { normalizeTeamRoleInput } from '../../services/directory/types.js'
import {
  loadAdminActiveAgentNames,
  loadAdminActiveContextIds,
  sendAdminAccessReconciliationError,
} from './accessReconciliationResponse.js'
import { registerAdminTeamAccessRoutes } from './teamAccess.js'
import { registerAdminTeamInvitationRoutes } from './teamInvitations.js'

function sendInvitationServiceError(res: Response, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes('Member registration service')) return false
  res.status(502).json({ error: 'invitation_service_unavailable', message })
  return true
}

function isTeamAuditHistoryForeignKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const pgError = error as {
    code?: unknown
    constraint?: unknown
    detail?: unknown
    message?: unknown
  }
  if (String(pgError.code || '') !== '23503') return false
  const details = [pgError.constraint, pgError.detail, pgError.message]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
  return (
    details.includes('team_workflow_grants_audit') ||
    details.includes('workflow_recipe_allowed_teams_audit')
  )
}

export function createAdminTeamsRouter(gateway: K8sGateway): Router {
  const router = Router()

  router.get('/admin/pending-invitations', async (_req, res, next) => {
    try {
      res.status(200).json({ items: await listAllPendingInvitationsAdmin() })
    } catch (error) {
      if (sendInvitationServiceError(res, error)) return
      next(error)
    }
  })

  router.get(
    '/admin/profile-admin/overview',
    asyncHandler(async (_req, res) => {
      try {
        const [
          teams,
          users,
          pendingInvitations,
          agentsByTeam,
          contextsByTeam,
          activeAgentNames,
          activeContextIds,
        ] = await Promise.all([
          listAllTeams(),
          listUsers(''),
          listAllPendingInvitationsAdmin(),
          listTeamAgentsByTeam(),
          listTeamContextsByTeam(),
          loadAdminActiveAgentNames(gateway),
          loadAdminActiveContextIds(gateway),
        ])
        const activeAgentSet = new Set(activeAgentNames)
        const activeContextSet = new Set(activeContextIds)
        const teamAgentCounts = Object.fromEntries(
          teams.map(team => [
            team.id,
            (agentsByTeam[team.id] || []).filter(agentName => activeAgentSet.has(agentName)).length,
          ])
        )
        const teamContextCounts = Object.fromEntries(
          teams.map(team => [
            team.id,
            (contextsByTeam[team.id] || []).filter(contextId => activeContextSet.has(contextId))
              .length,
          ])
        )
        res.status(200).json({
          teams,
          users,
          pendingInvitations,
          teamAgentCounts,
          teamContextCounts,
        })
      } catch (error) {
        if (sendInvitationServiceError(res, error)) return
        if (sendAdminAccessReconciliationError(res, error)) return
        throw error
      }
    })
  )

  router.get('/admin/teams', async (_req, res, next) => {
    try {
      res.status(200).json({ items: await listAllTeams() })
    } catch (error) {
      if (sendInvitationServiceError(res, error)) return
      next(error)
    }
  })

  router.post('/admin/teams', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim()
      if (!name) {
        res.status(400).json({ error: 'name is required' })
        return
      }
      res.status(200).json(await createTeam(name))
    } catch (error) {
      if (error instanceof TeamNameConflictError) {
        res.status(409).json({ error: 'team_name_exists', message: error.message })
        return
      }
      next(error)
    }
  })

  registerAdminTeamInvitationRoutes(router)

  router.get('/admin/teams/:teamId', async (req, res, next) => {
    try {
      const team = await getTeamById(req.params.teamId)
      if (!team) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json(team)
    } catch (error) {
      next(error)
    }
  })

  /**
   * Hard-delete team and all memberships, invitations, team context/agent links (DB CASCADE).
   * Audit history is retained, so teams referenced by workflow audit rows cannot be deleted.
   */
  router.delete('/admin/teams/:teamId', async (req, res, next) => {
    try {
      const deleted = await adminDeleteTeam(req.params.teamId)
      if ('error' in deleted) {
        if (deleted.error === 'team_not_empty') {
          res.status(409).json({ error: 'team_not_empty' })
          return
        }
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json({ deleted: true, id: deleted.id })
    } catch (error) {
      if (isTeamAuditHistoryForeignKeyError(error)) {
        res.status(409).json({ error: 'team_has_audit_history' })
        return
      }
      next(error)
    }
  })

  router.put('/admin/teams/:teamId/name', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim()
      if (!name) {
        res.status(400).json({ error: 'name is required' })
        return
      }
      const updated = await renameTeam(req.params.teamId, name)
      if (!updated) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json(updated)
    } catch (error) {
      if (error instanceof TeamNameConflictError) {
        res.status(409).json({ error: 'team_name_exists', message: error.message })
        return
      }
      next(error)
    }
  })

  router.get('/admin/teams/:teamId/members', async (req, res, next) => {
    try {
      res.status(200).json({ items: await listMembers(req.params.teamId) })
    } catch (error) {
      next(error)
    }
  })

  router.post('/admin/teams/:teamId/members', async (req, res, next) => {
    try {
      const userId = String(req.body?.userId || '').trim()
      const role = normalizeTeamRoleInput(req.body?.role || 'member')
      if (!userId || !role) {
        res.status(400).json({ error: 'invalid payload' })
        return
      }
      res
        .status(200)
        .json(
          await addMemberToTeam(
            req.params.teamId,
            userId,
            (req as UiAuthedRequest).adminAuth!.sub,
            role
          )
        )
    } catch (error) {
      next(error)
    }
  })

  router.patch('/admin/teams/:teamId/members/:userId/role', async (req, res, next) => {
    try {
      const role = normalizeTeamRoleInput(req.body?.role)
      if (!role) {
        res.status(400).json({ error: 'invalid role' })
        return
      }
      res
        .status(200)
        .json(
          await updateMemberRole(
            req.params.teamId,
            req.params.userId,
            role,
            (req as UiAuthedRequest).adminAuth!.sub
          )
        )
    } catch (error) {
      next(error)
    }
  })

  router.delete('/admin/teams/:teamId/members/:userId', async (req, res, next) => {
    try {
      const deleted = await softDeleteMember(
        req.params.teamId,
        req.params.userId,
        (req as UiAuthedRequest).adminAuth!.sub
      )
      if (!deleted) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json(deleted)
    } catch (error) {
      next(error)
    }
  })

  registerAdminTeamAccessRoutes(router, gateway)

  return router
}
