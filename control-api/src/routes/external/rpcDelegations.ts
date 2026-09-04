import { Router } from 'express'
import { requireActionOperationId } from '@clerum/action-context-contracts'
import { sendPublicApiError } from '../../http/publicApiError.js'
import type { K8sGateway } from '../../k8s.js'
import { attachAccessExecutionBudget } from '../../middleware/accessExecutionBudget.js'
import {
  type ExternalAuthedRequest,
  requireExternalSessionRateLimitContext,
} from '../../middleware/externalSessionAuth.js'
import {
  externalUserRateLimitOptions,
  requireAuthenticatedExternalUserRateLimitContext,
} from '../../middleware/externalUserRateLimitPolicy.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { authorizeActionV2 } from '../../services/access/actionAuthorizer.js'
import {
  type RequestedActionContextV2,
  requestedActionContextV2,
} from '../../services/access/actionContextV2.js'
import { delegationV2IssuanceResponse } from '../../services/access/actionMessageId.js'
import { getActionOperationDefinition } from '../../services/access/actionOperationRegistry.js'
import { canonicalEnvironmentId } from '../../services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../../services/access/resourceIdentity.js'
import { resolveEffectiveUserAccessPolicy } from '../../services/access/userAccessRuntimePolicy.js'
import { issueUserDelegationV2 } from '../../utils/auth/userDelegationV2Token.js'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = [...allowed].sort()
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function parseIssuanceRequest(req: ExternalAuthedRequest) {
  if (!isPlainObject(req.body)) throw new Error('invalid_request')
  const hasTarget = Object.prototype.hasOwnProperty.call(req.body, 'target')
  if (
    !exactKeys(
      req.body,
      hasTarget
        ? ['version', 'operationId', 'resource', 'target']
        : ['version', 'operationId', 'resource']
    )
  ) {
    throw new Error('invalid_request')
  }
  if (req.body.version !== 2 || !isPlainObject(req.body.resource)) {
    throw new Error('invalid_request')
  }
  if (!exactKeys(req.body.resource, ['type', 'logicalId'])) throw new Error('invalid_request')
  const operationId = requireActionOperationId(req.body.operationId)
  const operation = getActionOperationDefinition(operationId)
  if (operation.delegation === 'none' || operation.pathMode !== 'selected_path') {
    throw new Error('invalid_request')
  }
  const resource = canonicalResourceIdentity({
    environmentId: canonicalEnvironmentId(),
    type: req.body.resource.type,
    logicalId: req.body.resource.logicalId,
  })
  const requested: RequestedActionContextV2 = requestedActionContextV2({
    accessPathId: req.header('x-evenfire-access-path-id'),
    authorizationRevision: req.header('x-evenfire-authorization-revision'),
  })
  return Object.freeze({
    operationId,
    resource,
    requested,
    ...(hasTarget ? { operationTarget: req.body.target } : {}),
  })
}

function sendAuthorizationOutcome(
  req: ExternalAuthedRequest,
  res: Parameters<typeof sendPublicApiError>[1],
  result: Exclude<Awaited<ReturnType<typeof authorizeActionV2>>, { status: 'allowed' }>
): void {
  if (result.status === 'authority_unavailable') {
    sendPublicApiError(
      req,
      res,
      503,
      result.code,
      'Authorization is temporarily unavailable.',
      true
    )
    return
  }
  if (result.status === 'not_found') {
    sendPublicApiError(req, res, 404, result.code, 'The resource was not found.')
    return
  }
  if (result.status === 'access_path_required') {
    sendPublicApiError(
      req,
      res,
      409,
      result.code,
      'Choose an access path for this operation.',
      false,
      {
        paths: result.paths,
      }
    )
    return
  }
  if (result.status === 'access_path_stale') {
    sendPublicApiError(
      req,
      res,
      409,
      result.code,
      'The access path is stale; refresh access before retrying.'
    )
    return
  }
  if (result.status === 'invalid_binding') {
    sendPublicApiError(req, res, 400, 'invalid_request', 'The delegation request is invalid.')
    return
  }
  sendPublicApiError(
    req,
    res,
    result.code === 'session_not_live' ? 401 : 403,
    result.code === 'session_not_live' ? 'invalid_session' : 'forbidden',
    result.code === 'session_not_live'
      ? 'The session is not valid.'
      : 'The requested operation is not allowed.'
  )
}

export function createExternalRpcDelegationsRouter(gateway: K8sGateway): Router {
  const router = Router()

  router.post(
    '/external/rpc/delegations',
    rateLimitMiddleware(externalUserRateLimitOptions('rpc_token', 'pre_auth')),
    attachAccessExecutionBudget,
    requireExternalSessionRateLimitContext({
      purpose: 'protected',
      requireV2: true,
      client: req => ({ version: req.header('x-evenfire-client-version') || undefined }),
    }),
    requireAuthenticatedExternalUserRateLimitContext,
    rateLimitMiddleware(externalUserRateLimitOptions('rpc_token', 'authenticated')),
    async (req: ExternalAuthedRequest, res, next) => {
      try {
        const policy = await resolveEffectiveUserAccessPolicy({
          budget: req.accessExecutionBudget,
        })
        if (!policy.actionContextV2 || !policy.rpcDelegationV2) {
          sendPublicApiError(req, res, 409, 'conflict', 'RPC delegation v2 is not enabled.')
          return
        }
        let parsed: ReturnType<typeof parseIssuanceRequest>
        try {
          parsed = parseIssuanceRequest(req)
        } catch {
          sendPublicApiError(req, res, 400, 'invalid_request', 'The delegation request is invalid.')
          return
        }
        const result = await authorizeActionV2({
          session: req.externalSessionAuthority!,
          requested: parsed.requested,
          operationId: parsed.operationId,
          resource: parsed.resource,
          ...(parsed.operationTarget !== undefined
            ? { operationTarget: parsed.operationTarget }
            : {}),
          allocateChatMessageId: true,
          budget: req.accessExecutionBudget,
          gateway,
          correlationId: req.correlationId,
        })
        if (result.status !== 'allowed') {
          sendAuthorizationOutcome(req, res, result)
          return
        }
        const delegationToken = issueUserDelegationV2({
          principal: result.context.principal,
          operationIds: [result.context.operationId],
          resource: result.context.resource,
          preparedTargets: { [result.context.operationId]: result.preparedTarget },
          accessPathId: result.context.accessPathId,
          authorizationRevision: result.context.authorizationRevision,
          behaviorBindingHash: result.context.behaviorBindingHash,
          pathKind: result.context.pathKind,
          effectiveTeamId: result.context.effectiveTeamId,
        })
        res.status(200).json(
          delegationV2IssuanceResponse({
            operationId: result.context.operationId,
            delegationToken,
            prepared: result.preparedTarget,
          })
        )
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
