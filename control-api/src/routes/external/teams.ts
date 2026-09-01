import { Router } from 'express'
import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import { attachAccessExecutionBudget } from '../../middleware/accessExecutionBudget.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import type { ExternalAuthedRequest } from '../../middleware/externalSessionAuth.js'
import {
  rejectBodyUserTeamMismatch,
  requireExternalRole,
  requireExternalTeamParamMatch,
  requireExternalUserParamMatch,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { externalUserRateLimitOptions } from '../../middleware/externalUserRateLimitPolicy.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { resolveMcpServersForAgents } from '../../services/access/mcpInvocable.js'
import {
  filterAccessValues,
  listActiveContextIds,
} from '../../services/directory/accessReconciliation.js'
import {
  createManagedInvitationForUser,
  createTeamForUser,
  deleteManagedMemberForUser,
  externalManagedInvitationResponse,
  findMemberRole,
  getCurrentTeam,
  getTeamAgents,
  getTeamContexts,
  listMembers,
  renameTeamForUser,
  updateManagedMemberRoleForUser,
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
  const externalTeamsRateLimits = createExternalClientRateLimiters(
    'teams',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )
  router.use(
    '/external/teams',
    ...externalTeamsRateLimits,
    attachAccessExecutionBudget,
    requireValidExternalSessionToken
  )

  router.get(
    '/external/teams/:teamId/users/:userId/current',
    rateLimitMiddleware(externalUserRateLimitOptions('team_user_read', 'authenticated')),
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

  router.post(
    '/external/teams',
    rateLimitMiddleware(externalUserRateLimitOptions('team_user_mutation', 'authenticated')),
    rejectBodyUserTeamMismatch,
    async (req, res, next) => {
      try {
        const userId = String(req.body?.userId || '').trim()
        const name = String(req.body?.name || '').trim()
        if (!userId || !name) return res.status(400).json({ error: 'userId and name are required' })
        return res.status(200).json(await createTeamForUser(userId, name))
      } catch (error) {
        return next(error)
      }
    }
  )

  router.put(
    '/external/teams/:teamId/name',
    rateLimitMiddleware(externalUserRateLimitOptions('team_user_mutation', 'authenticated')),
    requireExternalTeamParamMatch(),
    requireExternalRole(['admin']),
    rejectBodyUserTeamMismatch,
    async (req, res, next) => {
      try {
        const name = String(req.body?.name || '').trim()
        if (!name) return res.status(400).json({ error: 'name is required' })
        const result = await renameTeamForUser(
          (req as ExternalAuthedRequest).externalAuth!.userId,
          req.params.teamId,
          name,
          (req as ExternalAuthedRequest).externalSessionAuthority
        )
        if ('error' in result) {
          if (result.error === 'forbidden') return res.status(403).json({ error: 'forbidden' })
          return res.status(404).json({ error: 'not_found' })
        }
        return res.status(200).json(result.team)
      } catch (error) {
        return next(error)
      }
    }
  )

  router.get(
    '/external/teams/:teamId/members',
    rateLimitMiddleware(externalUserRateLimitOptions('team_user_read', 'authenticated')),
    requireExternalTeamParamMatch(),
    requireExternalRole(['admin', 'inviter']),
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
    rateLimitMiddleware(externalUserRateLimitOptions('team_user_read', 'authenticated')),
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
    rateLimitMiddleware(externalUserRateLimitOptions('team_user_read', 'authenticated')),
    requireExternalTeamParamMatch(),
    async (req, res, next) => {
      try {
        const base = await getTeamAgents(req.params.teamId)
        // getTeamAgents is the authorization boundary. Resolve only those
        // exact names so hidden Hosts are never queried for DTO enrichment.
        const authorizedAgentNames = filterAccessValues(base.agentNames, null)
        let agents: Awaited<ReturnType<typeof resolveMcpServersForAgents>> = []
        let agentNames = authorizedAgentNames
        try {
          // Authorization model: authorizedAgentNames already reflects which agents
          // this team is allowed to use. resolveMcpServersForAgents treats
          // agent access as the gate — no context-level scoping needed.
          agents = await resolveMcpServersForAgents(gateway, {
            mcpServersNamespace: config.mcpServersNamespace,
            hostsNamespace: config.hostsNamespace,
            agentNames: authorizedAgentNames,
          })
          // A successful lookup can safely remove genuinely missing or invalid
          // Hosts. Only the DTOs resolved from the authorized input are used.
          agentNames = agents.map(agent => agent.name)
        } catch (err) {
          // Spec §7.2: never fail the catalog purely because Kubernetes is
          // unavailable. Preserve the names authorized by the directory DB;
          // omit enriched DTOs because their live Host identity is unverified.
          console.warn(
            `[external/teams] MCP server enrichment failed for team ${req.params.teamId}:`,
            err
          )
          agents = []
        }
        return res.status(200).json({ ...base, agentNames, agents })
      } catch (error) {
        return next(error)
      }
    }
  )

  router.get(
    '/external/teams/:teamId/members/:userId/role',
    rateLimitMiddleware(externalUserRateLimitOptions('team_user_read', 'authenticated')),
    requireExternalTeamParamMatch(),
    requireExternalRole(['admin', 'inviter']),
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
    rateLimitMiddleware(externalUserRateLimitOptions('team_user_mutation', 'authenticated')),
    requireExternalTeamParamMatch(),
    requireExternalRole(['admin']),
    rejectBodyUserTeamMismatch,
    async (req, res, next) => {
      try {
        const role = normalizeTeamRoleInput(req.body?.role)
        if (!role) return res.status(400).json({ error: 'invalid role' })
        const result = await updateManagedMemberRoleForUser(
          (req as ExternalAuthedRequest).externalAuth!.userId,
          req.params.userId,
          req.params.teamId,
          role,
          (req as ExternalAuthedRequest).externalSessionAuthority
        )
        if ('error' in result) {
          if (result.error === 'forbidden') return res.status(403).json({ error: 'forbidden' })
          if (result.error === 'not_found') return res.status(404).json({ error: 'not_found' })
          return res.status(400).json({ error: result.error })
        }
        return res.status(200).json(result.membership)
      } catch (error) {
        return next(error)
      }
    }
  )

  router.post(
    '/external/teams/:teamId/invitations',
    rateLimitMiddleware(externalUserRateLimitOptions('team_user_mutation', 'authenticated')),
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
        const result = await createManagedInvitationForUser(
          (req as ExternalAuthedRequest).externalAuth!.userId,
          email,
          [{ teamId: req.params.teamId, role }],
          name || fallbackName,
          (req as ExternalAuthedRequest).externalSessionAuthority
        )
        if ('error' in result) {
          return res.status(result.error === 'forbidden' ? 403 : 400).json({ error: result.error })
        }
        return res
          .status(200)
          .json(externalManagedInvitationResponse(result.invitation as Record<string, unknown>))
      } catch (error) {
        return next(error)
      }
    }
  )

  router.delete(
    '/external/teams/:teamId/members/:userId',
    rateLimitMiddleware(externalUserRateLimitOptions('team_user_mutation', 'authenticated')),
    requireExternalTeamParamMatch(),
    requireExternalRole(['admin']),
    async (req, res, next) => {
      try {
        const result = await deleteManagedMemberForUser(
          (req as ExternalAuthedRequest).externalAuth!.userId,
          req.params.userId,
          req.params.teamId,
          (req as ExternalAuthedRequest).externalSessionAuthority
        )
        if ('error' in result) {
          if (result.error === 'forbidden') return res.status(403).json({ error: 'forbidden' })
          if (result.error === 'invalid_target') {
            return res.status(400).json({ error: 'invalid_target' })
          }
          return res.status(404).json({ error: 'not_found' })
        }
        return res.status(200).json(result.deleted)
      } catch (error) {
        return next(error)
      }
    }
  )

  return router
}
