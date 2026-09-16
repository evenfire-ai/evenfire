import express, { Router } from 'express'
import type { Request, Response } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { K8sGateway } from '../../k8s.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import {
  requireRpcTokenHostMatch,
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
  type AuthorizedRpcHostAccess,
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
  'host:session:write',
  'desktop:view',
] as const

type RpcAuthedRequest = Request & { rpcAuth?: RpcAccessClaims }
type ArtifactReadRequest = RpcAuthedRequest & {
  artifactReadConnection?: AuthorizedRpcHostAccess
}

function logHostAccessDenial(
  req: RpcAuthedRequest,
  reason: RpcHostAccessDenialReason | 'claims_missing'
): void {
  req.log?.warn(
    { event: 'rpc_host_access_denied', reason },
    'rpc host access denied by control-plane authority'
  )
}

async function resolveAuthorizedHostConnection(
  req: RpcAuthedRequest,
  res: Response,
  gateway: K8sGateway,
  directory: RpcHostAccessDirectory | undefined
): Promise<AuthorizedRpcHostAccess | null> {
  const userId = String(req.params.userId || '').trim()
  const hostRef = String(req.params.hostRef || '').trim()
  const claims = req.rpcAuth
  if (!claims) {
    logHostAccessDenial(req, 'claims_missing')
    res.status(403).json({ error: 'Forbidden' })
    return null
  }
  const authorization = await authorizeRpcHostAccess(gateway, claims, userId, hostRef, directory)
  if (!authorization.authorized) {
    logHostAccessDenial(req, authorization.reason)
    res.status(403).json({ error: 'Forbidden' })
    return null
  }
  return authorization.connection
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
  // grant-presence key, never from a body. Agents derive from `getUserAgents`.
  router.get(
    '/rpc/access/users/:userId/mcp-connectors',
    requireValidRpcAccessToken(),
    requireRpcTokenUserMatch(),
    async (req, res, next) => {
      try {
        const { agentNames } = await getUserAgents(req.params.userId)
        const agents = await resolveConnectorsForAgents(
          gateway,
          {
            mcpServersNamespace: config.mcpServersNamespace,
            hostsNamespace: config.hostsNamespace,
            agentNames,
            userId: req.params.userId,
          },
          { query: (text, values) => pool.query(text, values) }
        )
        res.status(200).json({ userId: req.params.userId, agents })
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
        const connection = await resolveAuthorizedHostConnection(req, res, gateway, directory)
        if (connection) res.status(200).json(connection)
      } catch (error) {
        next(error)
      }
    }
  )

  // The subject-wide durable PG bucket protects the expensive live Host
  // authorization below. Claim-match middleware runs first so malformed,
  // mismatched, or unsigned Host selectors do not consume admission and
  // caller-controlled Host refs cannot expand bucket cardinality.
  router.get(
    `${hostAccessPath}/artifact-read`,
    requireValidRpcAccessTokenAny(['host:task:read']),
    requireRpcTokenUserMatch(),
    requireRpcTokenHostMatch(),
    rateLimitMiddleware({
      bucketType: 'host_artifact_pre_admission',
      maxPerMinute: config.hostArtifactReadRlPerMin,
      getBucketKey: req => {
        const subject = (req as ArtifactReadRequest).rpcAuth?.sub
        return subject ? `host-artifact-pre-admission:${subject}` : null
      },
    }),
    async (req: ArtifactReadRequest, res, next) => {
      try {
        const connection = await resolveAuthorizedHostConnection(req, res, gateway, directory)
        if (!connection) return
        req.artifactReadConnection = connection
        next()
      } catch (error) {
        next(error)
      }
    },
    // Preserve R29-H1: after live authorization establishes the canonical
    // Host, consume its independent subject+Host budget before returning the
    // artifact connection. Host wake capacity remains separate.
    rateLimitMiddleware({
      bucketType: 'host_artifact_read',
      maxPerMinute: config.hostArtifactReadRlPerMin,
      getBucketKey: req => {
        const artifactRead = req as ArtifactReadRequest
        const subject = artifactRead.rpcAuth?.sub
        const hostRef = artifactRead.artifactReadConnection?.hostRef
        return subject && hostRef ? `host-artifact-read:${subject}:${hostRef}` : null
      },
    }),
    (req: ArtifactReadRequest, res) => {
      res.status(200).json(req.artifactReadConnection)
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
