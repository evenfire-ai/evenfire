import express, { Router } from 'express'
import type { Request, Response } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { K8sGateway } from '../../k8s.js'
import {
  requireRpcTokenUserMatch,
  requireValidRpcAccessToken,
  requireValidRpcAccessTokenAny,
} from '../../middleware/rpcAccessAuth.js'
import type { RpcAccessClaims } from '../../profileTypes.js'
import {
  resolveConnectorsForAgents,
  resolveInvocableMcpServersForContexts,
} from '../../services/access/mcpInvocable.js'
import {
  type RpcHostAccessDenialReason,
  type RpcHostAccessDirectory,
  authorizeRpcHostAccess,
} from '../../services/access/rpcHostAccessAuthorizer.js'
import {
  getCurrentTeam,
  getTeamAgents,
  getUserAgents,
  getUserContexts,
} from '../../services/directory/index.js'
import {
  type DirectRunAttributionBindingService,
  DirectRunBindingConflictError,
} from '../../services/tracing/directRunAttributionBindingService.js'
import { parseDirectRunBindingRequest } from '../../services/tracing/directRunBindingRequest.js'

type RpcAccessUsersRouterOptions = {
  bindingService: Pick<DirectRunAttributionBindingService, 'bind'>
  directory?: RpcHostAccessDirectory
  bindingBudgetMs?: number
}

const DEFAULT_DIRECT_RUN_BINDING_BUDGET_MS = 750

const HOST_ACCESS_SCOPES = [
  'host:message:invoke',
  'host:status:read',
  'host:health:read',
  'host:activity:read',
  'host:approval:write',
  'host:model:write',
  'host:task:read',
  'host:session:read',
  'host:session:write',
  'desktop:view',
] as const

type RpcAuthedRequest = Request & { rpcAuth?: RpcAccessClaims }

/**
 * Response header that tells rpc-proxy why control-api denied Host access. The
 * 403 body stays exactly `{"error":"Forbidden"}` (a pinned 21-byte contract);
 * the reason travels out of band so rpc-proxy can tell removed access from
 * other denials. Scope denials from the auth middleware carry no such header.
 */
export const HOST_ACCESS_DENIAL_REASON_HEADER = 'x-host-access-denial-reason'

function denyHostAccess(
  req: RpcAuthedRequest,
  res: Response,
  reason: RpcHostAccessDenialReason | 'claims_missing'
): void {
  req.log?.warn(
    { event: 'rpc_host_access_denied', reason },
    'rpc host access denied by control-plane authority'
  )
  res.setHeader(HOST_ACCESS_DENIAL_REASON_HEADER, reason)
  res.status(403).json({ error: 'Forbidden' })
}

async function bindDirectRunWithinBudget(
  bindingService: Pick<DirectRunAttributionBindingService, 'bind'>,
  input: Parameters<DirectRunAttributionBindingService['bind']>[0],
  budgetMs: number
): Promise<'recorded' | 'unavailable' | 'conflict'> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const bindingAttempt = bindingService.bind(input).then(
    () => 'recorded' as const,
    error =>
      error instanceof DirectRunBindingConflictError
        ? ('conflict' as const)
        : ('unavailable' as const)
  )
  const deadline = new Promise<'unavailable'>(resolve => {
    timeout = setTimeout(() => resolve('unavailable'), budgetMs)
  })
  try {
    return await Promise.race([bindingAttempt, deadline])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function createRpcAccessUsersRouter(
  gateway: K8sGateway,
  options: RpcAccessUsersRouterOptions
): Router {
  const router = Router()
  const { bindingService, directory } = options
  const bindingBudgetMs = options.bindingBudgetMs ?? DEFAULT_DIRECT_RUN_BINDING_BUDGET_MS

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
        // `req.params.userId` is authoritative here — `requireRpcTokenUserMatch()`
        // has already bound it to the RPC token subject. The DB client follows the
        // pool-wrapper idiom used by the other oauth routes (mcpOauth.ts,
        // internal/oauth.ts): `{ query: (t, v) => pool.query(t, v) }`.
        const servers = await resolveInvocableMcpServersForContexts(
          gateway,
          config.mcpServersNamespace,
          userContexts.contextIds,
          req.params.userId,
          { query: (text, values) => pool.query(text, values) }
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

  // Proactive connectors panel read-model (spec 11 U1): the CLASSIFIED fleet
  // per agent — `authorized` / `requires_setup` / `no_oauth`. Same gate as
  // `/mcp-servers`; `req.params.userId` is authoritative (bound to the RPC
  // token subject by `requireRpcTokenUserMatch()`) and flows only into the
  // grant-presence key, never from a body. Agents are the user's direct grants
  // (`getUserAgents`) plus, when the token carries a session team the user is
  // still an active member of, that team's grants (`getTeamAgents`) — the same
  // session-team rule as `authorizeRpcHostAccess` (PR #1004).
  router.get(
    '/rpc/access/users/:userId/mcp-connectors',
    requireValidRpcAccessToken(),
    requireRpcTokenUserMatch(),
    async (req: RpcAuthedRequest, res, next) => {
      try {
        const userId = req.params.userId
        const { agentNames: directAgents } = await getUserAgents(userId)
        const agentNames = [...directAgents]
        const teamId = req.rpcAuth?.teamId
        if (teamId && (await getCurrentTeam(userId, teamId))) {
          const { agentNames: teamAgents } = await getTeamAgents(teamId)
          for (const name of teamAgents) {
            if (!agentNames.includes(name)) agentNames.push(name)
          }
        }
        const agents = await resolveConnectorsForAgents(
          gateway,
          {
            mcpServersNamespace: config.mcpServersNamespace,
            hostsNamespace: config.hostsNamespace,
            agentNames,
            userId,
          },
          { query: (text, values) => pool.query(text, values) }
        )
        res.status(200).json({ userId, agents })
      } catch (error) {
        next(error)
      }
    }
  )

  // One control-plane authority serves both read-only Host resolution and the
  // message-path resolve+bind operation. Access requires the signed subject and
  // host claim, a live user/team directory grant, and an enabled Host CR.
  const hostAccessPath = '/rpc/access/users/:userId/mcp-hosts/:hostRef'

  router.get(
    hostAccessPath,
    requireValidRpcAccessTokenAny([...HOST_ACCESS_SCOPES]),
    async (req: RpcAuthedRequest, res, next) => {
      try {
        const userId = String(req.params.userId || '').trim()
        const hostRef = String(req.params.hostRef || '').trim()
        const claims = req.rpcAuth
        if (!claims) {
          denyHostAccess(req, res, 'claims_missing')
          return
        }
        const authorization = await authorizeRpcHostAccess(
          gateway,
          claims,
          userId,
          hostRef,
          directory
        )
        if (!authorization.authorized) {
          denyHostAccess(req, res, authorization.reason)
          return
        }
        res.status(200).json(authorization.connection)
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    hostAccessPath,
    requireValidRpcAccessToken('host:message:invoke'),
    express.json({ limit: '2kb', strict: true }),
    async (req: RpcAuthedRequest, res, next) => {
      try {
        const userId = String(req.params.userId || '').trim()
        const hostRef = String(req.params.hostRef || '').trim()
        const claims = req.rpcAuth
        const binding = parseDirectRunBindingRequest(req.body)
        if (!claims) {
          denyHostAccess(req, res, 'claims_missing')
          return
        }
        if (!binding) {
          res.status(400).json({ error: 'invalid_direct_run_binding' })
          return
        }

        const authorization = await authorizeRpcHostAccess(
          gateway,
          claims,
          userId,
          hostRef,
          directory
        )
        if (!authorization.authorized) {
          denyHostAccess(req, res, authorization.reason)
          return
        }

        const bindingStatus = await bindDirectRunWithinBudget(
          bindingService,
          {
            ...binding,
            hostRef,
            identityIssuer: config.rpcJwtIssuer,
            actorHumanSub: claims.sub,
            userId: claims.sub,
            teamId: claims.teamId,
          },
          bindingBudgetMs
        )
        if (bindingStatus === 'recorded') {
          res.status(200).json({
            ...authorization.connection,
            bindingStatus: 'recorded',
          })
          return
        }
        if (bindingStatus === 'conflict') {
          res.status(409).json({ error: 'direct_run_binding_conflict' })
          return
        }
        req.log?.warn(
          {
            event: 'governed_trace_operational_error',
            scope: 'agent_run',
            reason: 'attribution_binding_unavailable',
          },
          'direct run attribution binding unavailable after host authorization'
        )
        res.status(200).json({
          ...authorization.connection,
          bindingStatus: 'unavailable',
        })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
