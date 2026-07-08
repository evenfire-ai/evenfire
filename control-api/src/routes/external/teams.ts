import { Router } from 'express'
import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import {
  rejectBodyUserTeamMismatch,
  requireExternalRole,
  requireExternalTeamParamMatch,
  requireExternalUserParamMatch,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { resolveMcpServersForAgents } from '../../services/access/mcpInvocable.js'
import {
  filterAccessValues,
  listActiveAgentNames,
  listActiveContextIds,
} from '../../services/directory/accessReconciliation.js'
import {
  createInvitation,
  createTeamForUser,
  findMemberRole,
  getCurrentTeam,
  getTeamAgents,
  getTeamContexts,
  listMembers,
  renameTeam,
  softDeleteMember,
  updateMemberRole,
} from '../../services/directory/index.js'
import { normalizeTeamRoleInput } from '../../services/directory/types.js'

function sendInvitationServiceError(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  error: unknown
): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes('Member registration service')) return false
  res.status(502).json({ error: 'invitation_service_unavailable', message })
  return true
}

export function createExternalTeamsRouter(gateway: K8sGateway): Router {
  const router = Router()
  router.use('/external/teams', requireValidExternalSessionToken)

  router.get(
    '/external/teams/:teamId/users/:userId/current',
    requireExternalTeamParamMatch(),
    requireExternalUserParamMatch(),
    async (req, res, next) => {
      try {
        const team = await getCurrentTeam(req.params.userId, req.params.teamId)
        if (!team) return res.status(404).json({ error: 'not_found' })
        return res.status(200).json(team)
      } catch (error) {
        if (sendInvitationServiceError(res, error)) return
        return next(error)
      }
    }
  )

  router.post('/external/teams', rejectBodyUserTeamMismatch, async (req, res, next) => {
    try {
      const userId = String(req.body?.userId || '').trim()
      const name = String(req.body?.name || '').trim()
      if (!userId || !name) return res.status(400).json({ error: 'userId and name are required' })
      return res.status(200).json(await createTeamForUser(userId, name))
    } catch (error) {
      return next(error)
    }
  })

  router.put(
    '/external/teams/:teamId/name',
    requireExternalTeamParamMatch(),
    rejectBodyUserTeamMismatch,
    async (req, res, next) => {
      try {
        const name = String(req.body?.name || '').trim()
        if (!name) return res.status(400).json({ error: 'name is required' })
        const updated = await renameTeam(req.params.teamId, name)
        if (!updated) return res.status(404).json({ error: 'not_found' })
        return res.status(200).json(updated)
      } catch (error) {
        return next(error)
      }
    }
  )

  router.get(
    '/external/teams/:teamId/members',
    requireExternalTeamParamMatch(),
    async (req, res, next) => {
      try {
        return res.status(200).json({ items: await listMembers(req.params.teamId) })
      } catch (error) {
        return next(error)
      }
    }
  )

  router.get(
    '/external/teams/:teamId/contexts',
    requireExternalTeamParamMatch(),
    async (req, res, next) => {
      try {
        const base = await getTeamContexts(req.params.teamId)
        let active: Set<string> | null = null
        try {
          active = new Set(await listActiveContextIds(gateway))
        } catch (err) {
          console.warn(
            `[external/teams] context reconciliation failed for ${req.params.teamId}:`,
            err
          )
        }
        return res.status(200).json({
          ...base,
          contextIds: filterAccessValues(base.contextIds, active),
        })
      } catch (error) {
        return next(error)
      }
    }
  )

  router.get(
    '/external/teams/:teamId/agents',
    requireExternalTeamParamMatch(),
    async (req, res, next) => {
      try {
        const base = await getTeamAgents(req.params.teamId)
        let active: Set<string> | null = null
        try {
          active = new Set(await listActiveAgentNames(gateway))
        } catch (err) {
          console.warn(
            `[external/teams] agent reconciliation failed for ${req.params.teamId}:`,
            err
          )
        }
        const activeAgentNames = filterAccessValues(base.agentNames, active)
        let agents: Awaited<ReturnType<typeof resolveMcpServersForAgents>> = []
        try {
          // Authorization model: base.agentNames already reflects which agents
          // this team is allowed to use. resolveMcpServersForAgents treats
          // agent access as the gate — no context-level scoping needed.
          agents = await resolveMcpServersForAgents(gateway, {
            mcpServersNamespace: config.mcpServersNamespace,
            hostsNamespace: config.hostsNamespace,
            agentNames: activeAgentNames,
          })
        } catch (err) {
          // Spec §7.2: never fail the catalog purely because K8s listing failed.
          console.warn(
            `[external/teams] MCP server enrichment failed for team ${req.params.teamId}:`,
            err
          )
          agents = []
        }
        return res.status(200).json({ ...base, agentNames: activeAgentNames, agents })
      } catch (error) {
        return next(error)
      }
    }
  )

  router.get(
    '/external/teams/:teamId/members/:userId/role',
    requireExternalTeamParamMatch(),
    async (req, res, next) => {
      try {
        const role = await findMemberRole(req.params.teamId, req.params.userId)
        if (!role) return res.status(404).json({ error: 'not_found' })
        return res.status(200).json(role)
      } catch (error) {
        return next(error)
      }
    }
  )

  router.patch(
    '/external/teams/:teamId/members/:userId/role',
    requireExternalTeamParamMatch(),
    requireExternalRole(['admin']),
    rejectBodyUserTeamMismatch,
    async (req, res, next) => {
      try {
        const role = normalizeTeamRoleInput(req.body?.role)
        if (!role) return res.status(400).json({ error: 'invalid role' })
        return res
          .status(200)
          .json(await updateMemberRole(req.params.teamId, req.params.userId, role))
      } catch (error) {
        return next(error)
      }
    }
  )

  router.post(
    '/external/teams/:teamId/invitations',
    requireExternalTeamParamMatch(),
    requireExternalRole(['admin', 'inviter']),
    rejectBodyUserTeamMismatch,
    async (req, res, next) => {
      try {
        const name = String(req.body?.name || '').trim()
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        const role = normalizeTeamRoleInput(req.body?.role)
        if (!email || !role) {
          return res.status(400).json({ error: 'invalid invitation payload' })
        }
        const fallbackName = email.split('@')[0] || email
        return res
          .status(200)
          .json(await createInvitation(req.params.teamId, name || fallbackName, email, role))
      } catch (error) {
        return next(error)
      }
    }
  )

  router.delete(
    '/external/teams/:teamId/members/:userId',
    requireExternalTeamParamMatch(),
    requireExternalRole(['admin']),
    async (req, res, next) => {
      try {
        const deleted = await softDeleteMember(req.params.teamId, req.params.userId)
        if (!deleted) return res.status(404).json({ error: 'not_found' })
        return res.status(200).json(deleted)
      } catch (error) {
        return next(error)
      }
    }
  )

  return router
}
