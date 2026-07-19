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
  addMemberToTeam,
  adminDeleteTeam,
  createInvitation,
  createInvitationForTeams,
  createTeam,
  getTeamAgents,
  getTeamById,
  getTeamContexts,
  listAllPendingInvitationsAdmin,
  listAllTeams,
  listMembers,
  listPendingInvitationsForTeam,
  listTeamAgentsByTeam,
  listTeamContextsByTeam,
  listUsers,
  renameTeam,
  resendInvitation,
  revokePendingInvitation,
  setTeamAgents,
  setTeamContexts,
  softDeleteMember,
  updateMemberRole,
} from '../../services/directory/index.js'
import { normalizeTeamRoleInput } from '../../services/directory/types.js'
import {
  loadAdminActiveAgentNames,
  loadAdminActiveContextIds,
  sendAdminAccessReconciliationError,
} from './accessReconciliationResponse.js'

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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

async function findExistingMemberByEmail(
  email: string
): Promise<{ id: string; email: string } | null> {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return null
  const matches = await listUsers(normalizedEmail)
  return (
    matches.find(member => String(member.email || '').toLowerCase() === normalizedEmail) || null
  )
}

function sendExistingMemberConflict(res: Response, member: { id: string; email: string }) {
  res.status(409).json({
    error: 'member_email_exists',
    message:
      'A member with this email already exists. Open the existing member and add them to more teams instead.',
    memberId: member.id,
    email: member.email,
  })
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
      next(error)
    }
  })

  router.post('/admin/invitations', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim()
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const fallbackRole = normalizeTeamRoleInput(req.body?.role) || 'member'
      const teamsInput: unknown[] = Array.isArray(req.body?.teams) ? req.body.teams : []
      const teamAssignments = teamsInput
        .map((item: unknown) => {
          const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
          const teamId = String(row.teamId || row.id || '').trim()
          const role = normalizeTeamRoleInput(row.role) || fallbackRole
          return teamId ? { teamId, role } : null
        })
        .filter((item): item is { teamId: string; role: 'admin' | 'inviter' | 'member' } =>
          Boolean(item)
        )
      if (!name || !email) {
        res.status(400).json({ error: 'invalid invitation payload' })
        return
      }
      const existingMember = await findExistingMemberByEmail(email)
      if (existingMember) {
        sendExistingMemberConflict(res, existingMember)
        return
      }
      res.status(200).json(
        await createInvitationForTeams({
          inviteeName: name,
          email,
          purpose: 'member_invitation',
          teamAssignments,
          fallbackRole,
        })
      )
    } catch (error) {
      next(error)
    }
  })

  router.post('/admin/invitations/:invitationId/resend', async (req, res, next) => {
    try {
      const invitationId = String(req.params.invitationId || '').trim()
      if (!isUuid(invitationId)) {
        res.status(400).json({ error: 'invalid_invitation_id' })
        return
      }
      const resent = await resendInvitation(null, invitationId)
      if (!resent) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json({ sent: true, id: resent.id, email: resent.email })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/admin/invitations/:invitationId', async (req, res, next) => {
    try {
      const invitationId = String(req.params.invitationId || '').trim()
      if (!isUuid(invitationId)) {
        res.status(400).json({ error: 'invalid_invitation_id' })
        return
      }
      const revoked = await revokePendingInvitation(null, invitationId)
      if (!revoked) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json({ revoked: true, id: revoked.id, email: revoked.email })
    } catch (error) {
      next(error)
    }
  })

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

  router.get('/admin/teams/:teamId/invitations', async (req, res, next) => {
    try {
      const team = await getTeamById(req.params.teamId)
      if (!team) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json({ items: await listPendingInvitationsForTeam(req.params.teamId) })
    } catch (error) {
      next(error)
    }
  })

  router.post('/admin/teams/:teamId/invitations', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim()
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const role = normalizeTeamRoleInput(req.body?.role)
      if (!name || !email || !role) {
        res.status(400).json({ error: 'invalid invitation payload' })
        return
      }
      const existingMember = await findExistingMemberByEmail(email)
      if (existingMember) {
        sendExistingMemberConflict(res, existingMember)
        return
      }
      res.status(200).json(await createInvitation(req.params.teamId, name, email, role))
    } catch (error) {
      next(error)
    }
  })

  router.post('/admin/teams/:teamId/invitations/:invitationId/resend', async (req, res, next) => {
    try {
      const resent = await resendInvitation(req.params.teamId, req.params.invitationId)
      if (!resent) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json({ sent: true, id: resent.id, email: resent.email })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/admin/teams/:teamId/invitations/:invitationId', async (req, res, next) => {
    try {
      const revoked = await revokePendingInvitation(req.params.teamId, req.params.invitationId)
      if (!revoked) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json({ revoked: true, id: revoked.id, email: revoked.email })
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

  router.get('/admin/teams/:teamId/contexts', async (req, res, next) => {
    try {
      const base = await getTeamContexts(req.params.teamId)
      const partition = partitionAccessValues(
        base.contextIds,
        await loadAdminActiveContextIds(gateway)
      )
      res.status(200).json({
        ...base,
        contextIds: partition.active,
        deletedContextIds: partition.deleted,
      })
    } catch (error) {
      if (sendAdminAccessReconciliationError(res, error)) return
      next(error)
    }
  })

  router.put('/admin/teams/:teamId/contexts', async (req, res, next) => {
    try {
      const contextIds = Array.isArray(req.body?.contextIds) ? req.body.contextIds.map(String) : []
      const [existing, activeContextIds] = await Promise.all([
        getTeamContexts(req.params.teamId),
        loadAdminActiveContextIds(gateway),
      ])
      const existingPartition = partitionAccessValues(existing.contextIds, activeContextIds)
      const updated = await setTeamContexts(
        req.params.teamId,
        mergeActiveUpdateWithDeletedHistory(
          contextIds,
          activeContextIds,
          existingPartition.deleted
        ),
        (req as UiAuthedRequest).adminAuth!.sub
      )
      const updatedPartition = partitionAccessValues(updated.contextIds, activeContextIds)
      res.status(200).json({
        ...updated,
        contextIds: updatedPartition.active,
        deletedContextIds: updatedPartition.deleted,
      })
    } catch (error) {
      if (sendAdminAccessReconciliationError(res, error)) return
      next(error)
    }
  })

  router.get('/admin/teams/:teamId/agents', async (req, res, next) => {
    try {
      const base = await getTeamAgents(req.params.teamId)
      const partition = partitionAccessValues(
        base.agentNames,
        await loadAdminActiveAgentNames(gateway)
      )
      res.status(200).json({
        ...base,
        agentNames: partition.active,
      })
    } catch (error) {
      if (sendAdminAccessReconciliationError(res, error)) return
      next(error)
    }
  })

  router.put('/admin/teams/:teamId/agents', async (req, res, next) => {
    try {
      const agentNames = Array.isArray(req.body?.agentNames) ? req.body.agentNames.map(String) : []
      const activeAgentNames = await loadAdminActiveAgentNames(gateway)
      const updated = await setTeamAgents(
        req.params.teamId,
        filterAccessValues(agentNames, new Set(activeAgentNames)),
        (req as UiAuthedRequest).adminAuth!.sub
      )
      const updatedPartition = partitionAccessValues(updated.agentNames, activeAgentNames)
      res.status(200).json({
        ...updated,
        agentNames: updatedPartition.active,
      })
    } catch (error) {
      if (sendAdminAccessReconciliationError(res, error)) return
      next(error)
    }
  })

  return router
}
