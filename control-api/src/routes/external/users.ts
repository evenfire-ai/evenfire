import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import {
  type ExternalAuthedRequest,
  rejectBodyUserTeamMismatch,
  requireExternalUserParamMatch,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { resolveMcpServersForAgents } from '../../services/access/mcpInvocable.js'
import {
  filterAccessValues,
  listActiveAgentNames,
  listActiveContextIds,
} from '../../services/directory/accessReconciliation.js'
import {
  findMembership,
  getMe,
  getTeamAgents,
  getTeamContexts,
  getUserAgents,
  getUserContexts,
  listMembers,
  listTeams,
  updateProfile,
  updateUserPassword,
} from '../../services/directory/index.js'

const MAX_TEAM_DIRECTORY_TEAMS = 50
const TEAM_DIRECTORY_RATE_LIMIT_PER_MINUTE = 10
const PASSWORD_UPDATE_RATE_LIMIT_PER_MINUTE = 5

type TeamDirectoryMember = {
  id: string
  email: string
  name: string | null
  role: string
  status: string
}

function projectTeamMembers(values: unknown): TeamDirectoryMember[] {
  if (!Array.isArray(values)) return []
  return values.map(value => {
    const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    return {
      id: String(row.id || ''),
      email: String(row.email || ''),
      name: row.name === null || row.name === undefined ? null : String(row.name),
      role: String(row.role || ''),
      status: String(row.status || ''),
    }
  })
}

async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(items[index])
      }
    })
  )
  return results
}

export function createExternalUsersRouter(gateway: K8sGateway): Router {
  const router = Router()
  const externalUsersRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.approvalRlExternalPerMin,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  router.use('/external/users', externalUsersRateLimit, requireValidExternalSessionToken)

  router.get(
    '/external/users/:userId/teams',
    requireExternalUserParamMatch(),
    async (req, res, next) => {
      try {
        return res
          .status(200)
          .json(await listTeams(req.params.userId, String(req.query.currentTeamId || '')))
      } catch (error) {
        return next(error)
      }
    }
  )

  router.get(
    '/external/users/:userId/team-directory',
    requireExternalUserParamMatch(),
    rateLimitMiddleware({
      bucketType: 'team_directory',
      maxPerMinute: TEAM_DIRECTORY_RATE_LIMIT_PER_MINUTE,
      getBucketKey: req => {
        const userId = (req as ExternalAuthedRequest).externalAuth?.userId
        return userId ? `team_directory:${userId}` : null
      },
    }),
    async (req, res, next) => {
      try {
        const currentTeamId = (req as ExternalAuthedRequest).externalAuth?.teamId ?? ''
        const listed = await listTeams(req.params.userId, currentTeamId)
        const allTeams = Array.isArray(listed.items) ? listed.items : []
        const teams = allTeams.slice(0, MAX_TEAM_DIRECTORY_TEAMS)
        const truncated = allTeams.length > teams.length
        let activeContextIds: Set<string> | null = null
        let activeAgentNames: Set<string> | null = null
        try {
          const [contextIds, agentNames] = await Promise.all([
            listActiveContextIds(gateway),
            listActiveAgentNames(gateway),
          ])
          activeContextIds = new Set(contextIds)
          activeAgentNames = new Set(agentNames)
        } catch (err) {
          console.warn('[external/users] access reconciliation failed for team directory:', err)
        }

        const items = await mapWithConcurrencyLimit(teams, 4, async team => {
          try {
            const [members, contexts, agents] = await Promise.all([
              listMembers(team.id),
              getTeamContexts(team.id),
              getTeamAgents(team.id),
            ])
            return {
              team,
              members: projectTeamMembers(members),
              contextIds: filterAccessValues(contexts?.contextIds, activeContextIds),
              agentNames: filterAccessValues(agents?.agentNames, activeAgentNames),
            }
          } catch (err) {
            console.warn(`[external/users] team-directory fetch failed for team ${team.id}:`, err)
            return {
              team,
              members: [],
              contextIds: [],
              agentNames: [],
            }
          }
        })

        return res.status(200).json({
          currentTeamId: listed.currentTeamId || currentTeamId,
          truncated,
          items,
        })
      } catch (error) {
        return next(error)
      }
    }
  )

  router.get(
    '/external/users/:userId/memberships/:teamId',
    requireExternalUserParamMatch(),
    async (req, res, next) => {
      try {
        const membership = await findMembership(req.params.userId, req.params.teamId)
        if (!membership) return res.status(404).json({ error: 'not_found' })
        return res.status(200).json(membership)
      } catch (error) {
        return next(error)
      }
    }
  )

  router.get(
    '/external/users/:userId/me',
    requireExternalUserParamMatch(),
    async (req, res, next) => {
      try {
        const teamId = String(req.query.teamId || '')
        const data = await getMe(req.params.userId, teamId)
        if (!data) return res.status(404).json({ error: 'not_found' })
        return res.status(200).json(data)
      } catch (error) {
        return next(error)
      }
    }
  )

  router.get(
    '/external/users/:userId/contexts',
    requireExternalUserParamMatch(),
    async (req, res, next) => {
      try {
        const base = await getUserContexts(req.params.userId)
        let active: Set<string> | null = null
        try {
          active = new Set(await listActiveContextIds(gateway))
        } catch (err) {
          console.warn(
            `[external/users] context reconciliation failed for ${req.params.userId}:`,
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
    '/external/users/:userId/agents',
    requireExternalUserParamMatch(),
    async (req, res, next) => {
      try {
        const base = await getUserAgents(req.params.userId)
        // getUserAgents is the authorization boundary. Only its normalized
        // result may be resolved against Kubernetes; never list hidden Hosts
        // to build directory DTOs and filter afterward.
        const authorizedAgentNames = filterAccessValues(base.agentNames, null)
        let agents: Awaited<ReturnType<typeof resolveMcpServersForAgents>> = []
        let agentNames = authorizedAgentNames
        try {
          // Authorization model: authorizedAgentNames already reflects which agents
          // this user is allowed to use. resolveMcpServersForAgents treats agent
          // access as the gate — no additional context-level scoping needed.
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
            `[external/users] MCP server enrichment failed for ${req.params.userId}:`,
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

  router.put(
    '/external/users/:userId/profile',
    requireExternalUserParamMatch(),
    rejectBodyUserTeamMismatch,
    async (req, res, next) => {
      try {
        const displayName = String(req.body?.displayName || '').trim()
        return res
          .status(200)
          .json(await updateProfile(req.params.userId, displayName, req.body?.channels))
      } catch (error) {
        return next(error)
      }
    }
  )

  router.put(
    '/external/users/:userId/password',
    requireExternalUserParamMatch(),
    rateLimitMiddleware({
      bucketType: 'profile_password_update',
      maxPerMinute: PASSWORD_UPDATE_RATE_LIMIT_PER_MINUTE,
      getBucketKey: req => {
        const userId = (req as ExternalAuthedRequest).externalAuth?.userId
        return userId ? `profile_password_update:${userId}` : null
      },
    }),
    async (req, res, next) => {
      try {
        const auth = (req as ExternalAuthedRequest).externalAuth
        if (!auth) {
          return res.status(403).json({ error: 'Forbidden' })
        }
        const currentPassword = String(req.body?.currentPassword || '')
        const newPassword = String(req.body?.newPassword || '')
        const result = await updateUserPassword(
          req.params.userId,
          auth.email,
          currentPassword,
          newPassword
        )
        if ('error' in result) {
          if (result.error === 'not_found') return res.status(404).json({ error: 'not_found' })
          if (result.error === 'password_not_set') {
            return res.status(409).json({ error: 'password_not_set' })
          }
          if (result.error === 'invalid_current_password') {
            return res.status(401).json({ error: 'invalid_current_password' })
          }
          return res.status(400).json({ error: 'invalid_password' })
        }
        return res.status(200).json(result)
      } catch (error) {
        return next(error)
      }
    }
  )

  return router
}
