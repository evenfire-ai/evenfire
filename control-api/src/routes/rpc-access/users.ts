import express, { Router } from 'express'
import type { Request } from 'express'
import { config } from '../../config.js'
import { K8sGateway } from '../../k8s.js'
import {
  requireRpcTokenUserMatch,
  requireValidRpcAccessToken,
  requireValidRpcAccessTokenAny,
} from '../../middleware/rpcAccessAuth.js'
import type { RpcAccessClaims } from '../../profileTypes.js'
import { resolveInvocableMcpServersForContexts } from '../../services/access/mcpInvocable.js'
import {
  type RpcHostAccessDenialReason,
  type RpcHostAccessDirectory,
  authorizeRpcHostAccess,
} from '../../services/access/rpcHostAccessAuthorizer.js'
import { getUserAgents, getUserContexts } from '../../services/directory/index.js'
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
  'desktop:view',
] as const

type RpcAuthedRequest = Request & { rpcAuth?: RpcAccessClaims }

function logHostAccessDenial(
  req: RpcAuthedRequest,
  reason: RpcHostAccessDenialReason | 'claims_missing'
): void {
  req.log?.warn(
    { event: 'rpc_host_access_denied', reason },
    'rpc host access denied by control-plane authority'
  )
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
        const servers = await resolveInvocableMcpServersForContexts(
          gateway,
          config.mcpServersNamespace,
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
          logHostAccessDenial(req, 'claims_missing')
          res.status(403).json({ error: 'Forbidden' })
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
          logHostAccessDenial(req, authorization.reason)
          res.status(403).json({ error: 'Forbidden' })
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
          logHostAccessDenial(req, 'claims_missing')
          res.status(403).json({ error: 'Forbidden' })
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
          logHostAccessDenial(req, authorization.reason)
          res.status(403).json({ error: 'Forbidden' })
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
