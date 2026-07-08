import { Router } from 'express'
import type { Request } from 'express'
import { config } from '../../config.js'
import { K8sGateway } from '../../k8s.js'
import {
  requireRpcTokenHostMatch,
  requireRpcTokenUserMatch,
  requireValidRpcAccessToken,
  requireValidRpcAccessTokenAny,
} from '../../middleware/rpcAccessAuth.js'
import type { RpcAccessClaims } from '../../profileTypes.js'
import { resolveInvocableMcpServersForContexts } from '../../services/access/mcpInvocable.js'
import { getTeamAgents, getUserAgents, getUserContexts } from '../../services/directory/index.js'

export function createRpcAccessUsersRouter(gateway: K8sGateway): Router {
  const router = Router()
  const mcpServerNamespace = config.mcpServersNamespace

  router.get(
    '/rpc/access/users/:userId/contexts',
    requireValidRpcAccessToken(),
    requireRpcTokenUserMatch(),
    async (req, res, next) => {
      try {
        res.status(200).json(await getUserContexts(req.params.userId))
      } catch (error) {
        next(error)
      }
    }
  )

  router.get(
    '/rpc/access/users/:userId/agents',
    requireValidRpcAccessToken(),
    requireRpcTokenUserMatch(),
    async (req, res, next) => {
      try {
        res.status(200).json(await getUserAgents(req.params.userId))
      } catch (error) {
        next(error)
      }
    }
  )

  router.get(
    '/rpc/access/users/:userId/mcp-servers',
    requireValidRpcAccessToken(),
    requireRpcTokenUserMatch(),
    async (req, res, next) => {
      try {
        const userContexts = await getUserContexts(req.params.userId)
        const servers = await resolveInvocableMcpServersForContexts(
          gateway,
          mcpServerNamespace,
          userContexts.contextIds
        )
        res.status(200).json({
          userId: req.params.userId,
          contextIds: userContexts.contextIds,
          servers,
        })
      } catch (error) {
        next(error)
      }
    }
  )

  // Authorization gate: verifies the user has an explicit user_agents row for
  // the requested host. This check was introduced in 4d8f9a7 (2026-03-10) but
  // the population path (HostWizard Step 5 "Access") was not enforced, causing
  // a ~30-day production incident where agents created without selecting users
  // were silently unusable. Fixed in 61d62d2 + 48ff7d6 (2026-04-09/10).
  // Population: PUT /admin/agents/:agentName/users (agentAccess.setAgentUsers).
  // Tests: test/routes.rpcAccessUsersMcpHost.test.ts (16 cases).
  router.get(
    '/rpc/access/users/:userId/mcp-hosts/:hostRef',
    requireValidRpcAccessTokenAny([
      'host:message:invoke',
      'host:status:read',
      'host:health:read',
      'host:activity:read',
      'host:approval:write',
      'host:task:read',
      'host:session:read',
      'desktop:view',
    ]),
    requireRpcTokenUserMatch(),
    requireRpcTokenHostMatch(),
    async (req, res, next) => {
      try {
        const userId = String(req.params.userId || '').trim()
        const hostRef = String(req.params.hostRef || '').trim()
        const rpcAuth = (req as Request & { rpcAuth?: RpcAccessClaims }).rpcAuth
        const userAgents = await getUserAgents(userId)
        if (!userAgents.agentNames.includes(hostRef)) {
          const teamId = rpcAuth?.teamId
          if (!teamId) {
            res.status(403).json({ error: 'Forbidden' })
            return
          }
          const teamAgents = await getTeamAgents(teamId)
          if (!teamAgents.agentNames.includes(hostRef)) {
            res.status(403).json({ error: 'Forbidden' })
            return
          }
        }

        const hosts = (await gateway.listResource('hosts', config.hostsNamespace)) as Array<{
          metadata?: { name?: string }
          spec?: { enabled?: boolean }
        }>
        const host = hosts.find(entry => entry.metadata?.name === hostRef)
        if (!host || host.spec?.enabled === false) {
          res.status(403).json({ error: 'Forbidden' })
          return
        }

        const url = `http://${hostRef}.${config.hostsNamespace}.svc.cluster.local:8080`
        res.status(200).json({ userId, hostRef, url })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
