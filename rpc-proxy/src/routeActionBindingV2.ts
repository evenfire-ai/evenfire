import type { NextFunction, Response } from 'express'
import {
  type ActionOperationId,
  type CanonicalActionTarget,
  actionOperationScope,
  canonicalActionTargetJson,
  classifyMcpCallerOperation,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import {
  ActionAuthorityCheckpointError,
  type AuthorizedActionV2,
  type BoundActionV2,
  authorizeActionV2,
} from './actionAuthorityV2.js'
import { config } from './config.js'
import type { AuthedRequest } from './middleware/auth.js'
import type { UserDelegationV2Claims } from './userDelegationV2.js'

export class RouteActionBindingError extends Error {
  constructor(readonly code: 'invalid_binding' | 'unsupported_route') {
    super(code)
    this.name = 'RouteActionBindingError'
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function requiredString(value: unknown): string {
  const parsed = stringValue(value)
  if (!parsed) throw new RouteActionBindingError('invalid_binding')
  return parsed
}

function canonicalHostRef(routeHostRef: unknown): {
  routeHostRef: string
  authorityHostRef: string
} {
  const routeValue = requiredString(routeHostRef)
  if (routeValue.includes('/') || routeValue.includes('\\')) {
    throw new RouteActionBindingError('invalid_binding')
  }
  return { routeHostRef: routeValue, authorityHostRef: `${config.hostNamespace}/${routeValue}` }
}

function routePath(req: AuthedRequest): string {
  const path = (req.route as { path?: unknown } | undefined)?.path
  if (typeof path !== 'string') throw new RouteActionBindingError('unsupported_route')
  return path
}

function targetForHostRead(req: AuthedRequest): {
  operationId: 'host.status.read' | 'host.health.read'
  target: Record<string, string>
} | null {
  const path = routePath(req)
  const { authorityHostRef } = canonicalHostRef(req.params.hostRef)
  if (path === '/rpc/hosts/:hostRef/status' || path === '/rpc/hosts/:hostRef/status/stream') {
    return { operationId: 'host.status.read', target: { hostRef: authorityHostRef } }
  }
  if (path === '/rpc/hosts/:hostRef/health') {
    return { operationId: 'host.health.read', target: { hostRef: authorityHostRef } }
  }
  return null
}

function candidateForRequest(req: AuthedRequest): {
  operationId: ActionOperationId
  target: unknown
} {
  const path = routePath(req)
  const method = req.method.toUpperCase()

  if (method === 'POST' && path === '/rpc/:serverName') {
    const body = record(req.body)
    if (body.jsonrpc !== '2.0') throw new RouteActionBindingError('invalid_binding')
    const classified = classifyMcpCallerOperation({
      serverNamespace: config.mcpServerNamespace,
      serverName: req.params.serverName,
      method: body.method,
      params: body.params,
    })
    if (classified.status !== 'classified') throw new RouteActionBindingError('invalid_binding')
    return { operationId: classified.operationId, target: classified.target }
  }

  if (req.params.hostRef !== undefined) {
    const host = canonicalHostRef(req.params.hostRef)
    const hostRead = targetForHostRead(req)
    if (hostRead) return hostRead

    if (method === 'POST' && path === '/rpc/hosts/:hostRef/messages') {
      const body = record(req.body)
      return {
        operationId: 'chat.message.invoke',
        target: {
          hostRef: host.authorityHostRef,
          channelType: 'rpc',
          channelId: host.routeHostRef,
          messageId: requiredString(body.messageId),
        },
      }
    }
    if (method === 'POST' && path === '/rpc/hosts/:hostRef/wake') {
      return {
        operationId: 'host.wake',
        target: {
          hostRef: host.authorityHostRef,
          wakeReason: requiredString(record(req.body).wakeReason),
        },
      }
    }
    if (
      method === 'POST' &&
      (path === '/rpc/hosts/:hostRef/approvals/approve' ||
        path === '/rpc/hosts/:hostRef/approvals/deny')
    ) {
      const body = record(req.body)
      return {
        operationId: 'task.manage',
        target: {
          hostRef: host.authorityHostRef,
          taskId: requiredString(body.taskId),
          action: path.endsWith('/approve') ? 'approve' : 'deny',
          approvalRequestId: requiredString(body.toolCallId ?? body.requestId),
        },
      }
    }
    if (method === 'POST' && path === '/rpc/hosts/:hostRef/tasks/:taskId/cancel') {
      return {
        operationId: 'task.manage',
        target: {
          hostRef: host.authorityHostRef,
          taskId: requiredString(req.params.taskId),
          action: 'cancel',
        },
      }
    }
    if (
      method === 'GET' &&
      (path === '/rpc/hosts/:hostRef/tasks/:taskId/result' ||
        path === '/rpc/hosts/:hostRef/tasks/:taskId/progress/stream')
    ) {
      return {
        operationId: 'task.read',
        target: { hostRef: host.authorityHostRef, taskId: requiredString(req.params.taskId) },
      }
    }
    if (method === 'GET' && path === '/rpc/hosts/:hostRef/sessions') {
      const agent = stringValue(req.query.agent)
      return {
        operationId: 'session.read',
        target: { hostRef: host.authorityHostRef, ...(agent ? { agent } : {}) },
      }
    }
    if (
      method === 'GET' &&
      (path === '/rpc/hosts/:hostRef/sessions/:agent/:chatId/messages' ||
        path === '/rpc/hosts/:hostRef/sessions/:agent/:chatId/context-breakdown')
    ) {
      return {
        operationId: 'session.read',
        target: {
          hostRef: host.authorityHostRef,
          agent: requiredString(req.params.agent),
          chatId: requiredString(req.params.chatId),
        },
      }
    }
    if (method === 'GET' && path === '/rpc/hosts/:hostRef/models') {
      return {
        operationId: 'model.read',
        target: {
          hostRef: host.authorityHostRef,
          agent: requiredString(req.query.agent),
          chatId: requiredString(req.query.chatId),
        },
      }
    }
    if (method === 'POST' && path === '/rpc/hosts/:hostRef/model') {
      const body = record(req.body)
      return {
        operationId: 'model.select',
        target: {
          hostRef: host.authorityHostRef,
          agent: requiredString(body.agent),
          chatId: requiredString(body.chatId),
          provider: requiredString(body.provider),
          model: requiredString(body.model),
        },
      }
    }
    if (
      method === 'GET' &&
      (path === '/rpc/hosts/:hostRef/activity' || path === '/rpc/hosts/:hostRef/activity/stream')
    ) {
      const visibility = req.query.visibility === 'host_all' ? 'host_all' : 'caller_path'
      return {
        operationId: visibility === 'host_all' ? 'host.activity.read_all' : 'host.activity.read',
        target: { hostRef: host.authorityHostRef, visibility },
      }
    }
  }

  // Discovery and later PR 2 partitions are intentionally not made v2-capable
  // by this adapter. In particular, a catalog token is not action authority.
  throw new RouteActionBindingError('unsupported_route')
}

export function bindRouteActionV2(
  req: AuthedRequest,
  claims: UserDelegationV2Claims
): BoundActionV2 {
  const candidate = candidateForRequest(req)
  if (
    !claims.operationIds.includes(candidate.operationId) ||
    !claims.scopes.includes(actionOperationScope(candidate.operationId))
  ) {
    throw new RouteActionBindingError('invalid_binding')
  }
  let target: CanonicalActionTarget
  try {
    target = validateActionOperationTarget({
      operationId: candidate.operationId,
      resource: claims.resource,
      operationTarget: candidate.target,
    })
  } catch {
    throw new RouteActionBindingError('invalid_binding')
  }
  const signedTarget = claims.targets[candidate.operationId]
  const signedHash = claims.targetHashes[candidate.operationId]
  const targetHash = hashActionTarget(target)
  if (
    signedHash !== targetHash ||
    canonicalActionTargetJson(signedTarget) !== canonicalActionTargetJson(target)
  ) {
    throw new RouteActionBindingError('invalid_binding')
  }
  return Object.freeze({ operationId: candidate.operationId, target, targetHash })
}

function sendCheckpointError(res: Response, error: ActionAuthorityCheckpointError): void {
  res.status(error.status).json({
    error: error.code,
    ...(error.currentAuthorizationRevision
      ? { currentAuthorizationRevision: error.currentAuthorizationRevision }
      : {}),
  })
}

export async function authorizeBoundRequestV2(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
  options: {
    authorize?: (
      claims: UserDelegationV2Claims,
      bound: BoundActionV2
    ) => Promise<AuthorizedActionV2>
  } = {}
): Promise<void> {
  const claims = req.userDelegationV2
  if (!claims) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  let bound: BoundActionV2
  try {
    bound = bindRouteActionV2(req, claims)
  } catch (error) {
    if (error instanceof RouteActionBindingError) {
      res.status(400).json({ error: 'invalid_binding' })
      return
    }
    res.status(503).json({ error: 'authority_unavailable' })
    return
  }
  try {
    req.authorizedActionV2 = await (options.authorize ?? authorizeActionV2)(claims, bound)
    next()
  } catch (error) {
    if (error instanceof ActionAuthorityCheckpointError) {
      sendCheckpointError(res, error)
      return
    }
    res.status(503).json({ error: 'authority_unavailable' })
  }
}

export function trustedEdgeActionContextHeader(req: AuthedRequest): string | undefined {
  return req.authorizedActionV2?.trustedEdgeHeader
}

export function runtimeHostEdgeContext(
  req: AuthedRequest,
  extra: {
    requestId?: string
    directRunBinding?: {
      runId: string
      sessionId: string
      origin: 'direct_chat' | 'channel_event' | 'api'
    }
  } = {}
): {
  accessScope?: 'team' | 'user'
  teamId?: string | null
  requestId?: string
  directRunBinding?: {
    runId: string
    sessionId: string
    origin: 'direct_chat' | 'channel_event' | 'api'
  }
  actionContextV2?: string
  destination?: Readonly<{ kind: 'host' | 'mcp_server'; ref: string; url: string }>
} {
  const authorized = req.authorizedActionV2
  const actionContextV2 = trustedEdgeActionContextHeader(req)
  if (actionContextV2 && authorized?.checkpoint.destination) {
    return { ...extra, actionContextV2, destination: authorized.checkpoint.destination }
  }
  return {
    ...extra,
    teamId: req.auth?.teamId ?? null,
  }
}
