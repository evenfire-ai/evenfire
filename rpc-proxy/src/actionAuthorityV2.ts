import {
  ACTION_AUTHORITY_CHECKPOINT_PATH,
  type ActionAuthorityCheckpointRequestV2,
  type ActionAuthorityCheckpointResponseV2,
  type ActionOperationId,
  type CanonicalActionTarget,
  type TrustedEdgeActionContextV2,
  canonicalActionTargetJson,
  validateActionAuthorityCheckpointResponse,
} from '@clerum/action-context-contracts'
import { config } from './config.js'
import type { UserDelegationV2Claims } from './userDelegationV2.js'

export type BoundActionV2 = Readonly<{
  operationId: ActionOperationId
  target: CanonicalActionTarget
  targetHash: string
}>

export type AuthorizedActionV2 = Readonly<{
  claims: UserDelegationV2Claims
  bound: BoundActionV2
  checkpoint: Extract<ActionAuthorityCheckpointResponseV2, { status: 'allowed' }>
  trustedEdgeContext: TrustedEdgeActionContextV2
  trustedEdgeHeader: string
}>

export class ActionAuthorityCheckpointError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    readonly code:
      | 'invalid_binding'
      | 'forbidden'
      | 'not_found'
      | 'access_path_stale'
      | 'authority_unavailable',
    readonly currentAuthorizationRevision?: string
  ) {
    super(code)
    this.name = 'ActionAuthorityCheckpointError'
  }
}

export function actionAuthorityCacheKey(
  claims: UserDelegationV2Claims,
  bound: BoundActionV2
): string {
  // JSON framing is collision-safe even if a future identifier contains the
  // delimiter characters used by older cache keys.
  return JSON.stringify([
    claims.sub,
    claims.sid,
    claims.jti,
    claims.resource.environmentId,
    claims.resource.type,
    claims.resource.canonicalId,
    claims.resource.logicalId,
    claims.accessPathId,
    claims.pathKind,
    claims.effectiveTeamId,
    [...claims.operationIds].sort(),
    [...claims.scopes].sort(),
    bound.operationId,
    canonicalActionTargetJson(bound.target),
    bound.targetHash,
    claims.authorizationRevision,
    claims.behaviorBindingHash,
    claims.exp,
  ])
}

export function actionAuthorityCheckpointRequest(
  claims: UserDelegationV2Claims,
  bound: BoundActionV2
): ActionAuthorityCheckpointRequestV2 {
  return {
    version: 2,
    principal: { sub: claims.sub, sid: claims.sid, sessionVersion: claims.sv },
    delegationJti: claims.jti,
    resource: claims.resource,
    operationId: bound.operationId,
    target: bound.target,
    targetHash: bound.targetHash,
    accessPathId: claims.accessPathId,
    authorizationRevision: claims.authorizationRevision,
    behaviorBindingHash: claims.behaviorBindingHash,
    domain: {
      service: config.controlApiServiceName,
      resource: claims.resource,
      targetHash: bound.targetHash,
    },
  }
}

function checkpointError(
  response: Exclude<ActionAuthorityCheckpointResponseV2, { status: 'allowed' }>
): ActionAuthorityCheckpointError {
  switch (response.status) {
    case 'denied':
      return new ActionAuthorityCheckpointError(403, 'forbidden')
    case 'not_found':
      return new ActionAuthorityCheckpointError(404, 'not_found')
    case 'access_path_stale':
      return new ActionAuthorityCheckpointError(
        409,
        'access_path_stale',
        response.currentAuthorizationRevision
      )
    case 'authority_unavailable':
      return new ActionAuthorityCheckpointError(503, 'authority_unavailable')
    case 'invalid_binding':
      return new ActionAuthorityCheckpointError(400, 'invalid_binding')
  }
}

function assertCheckpointMatchesDelegation(
  claims: UserDelegationV2Claims,
  bound: BoundActionV2,
  response: Extract<ActionAuthorityCheckpointResponseV2, { status: 'allowed' }>
): void {
  const attribution = response.attribution
  if (
    response.authorizationRevision !== claims.authorizationRevision ||
    response.behaviorBindingHash !== claims.behaviorBindingHash ||
    attribution.userId !== claims.sub ||
    attribution.sid !== claims.sid ||
    attribution.sessionVersion !== claims.sv ||
    attribution.accessPathId !== claims.accessPathId ||
    attribution.pathKind !== claims.pathKind ||
    attribution.effectiveTeamId !== claims.effectiveTeamId
  ) {
    throw new ActionAuthorityCheckpointError(400, 'invalid_binding')
  }
  const target = bound.target
  const expectedDestination =
    target && typeof target.hostRef === 'string'
      ? { kind: 'host' as const, ref: target.hostRef }
      : target &&
          typeof target.serverNamespace === 'string' &&
          typeof target.serverName === 'string'
        ? {
            kind: 'mcp_server' as const,
            ref: `${target.serverNamespace}/${target.serverName}`,
          }
        : null
  if (
    !expectedDestination ||
    !response.destination ||
    response.destination.kind !== expectedDestination.kind ||
    response.destination.ref !== expectedDestination.ref
  ) {
    throw new ActionAuthorityCheckpointError(400, 'invalid_binding')
  }
}

export async function authorizeActionV2(
  claims: UserDelegationV2Claims,
  bound: BoundActionV2,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<AuthorizedActionV2> {
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${config.controlApiBaseUrl.replace(/\/+$/, '')}${ACTION_AUTHORITY_CHECKPOINT_PATH.replace(/^\/api\/v1/, '')}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.controlApiServiceToken}`,
          'content-type': 'application/json',
          'x-service-token': config.controlApiServiceName,
        },
        body: JSON.stringify(actionAuthorityCheckpointRequest(claims, bound)),
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      }
    )
  } catch {
    throw new ActionAuthorityCheckpointError(503, 'authority_unavailable')
  }

  let parsed: ActionAuthorityCheckpointResponseV2 | null = null
  try {
    parsed = validateActionAuthorityCheckpointResponse(await response.json())
  } catch {
    // Invalid/missing authority response is an outage, never an alternate deny.
  }
  if (!parsed) throw new ActionAuthorityCheckpointError(503, 'authority_unavailable')
  const expectedStatus = {
    allowed: 200,
    denied: 403,
    not_found: 404,
    access_path_stale: 409,
    authority_unavailable: 503,
    invalid_binding: 400,
  }[parsed.status]
  if (response.status !== expectedStatus) {
    throw new ActionAuthorityCheckpointError(503, 'authority_unavailable')
  }
  if (parsed.status !== 'allowed') throw checkpointError(parsed)
  assertCheckpointMatchesDelegation(claims, bound, parsed)

  const now = Date.now()
  if (parsed.validUntil !== null && Date.parse(parsed.validUntil) <= now) {
    throw new ActionAuthorityCheckpointError(409, 'access_path_stale')
  }

  const tokenExpiry = new Date(claims.exp * 1000).toISOString()
  const expiresAt =
    parsed.validUntil && Date.parse(parsed.validUntil) < Date.parse(tokenExpiry)
      ? parsed.validUntil
      : tokenExpiry
  const trustedEdgeContext: TrustedEdgeActionContextV2 = {
    version: 2,
    userId: claims.sub,
    sid: claims.sid,
    sessionVersion: claims.sv,
    delegationJti: claims.jti,
    operationId: bound.operationId,
    resource: claims.resource,
    target: bound.target,
    targetHash: bound.targetHash,
    accessPathId: claims.accessPathId,
    authorizationRevision: parsed.authorizationRevision,
    pathKind: claims.pathKind,
    effectiveTeamId: claims.effectiveTeamId,
    behaviorBindingHash: parsed.behaviorBindingHash,
    behavior: parsed.behavior,
    checkedAt: parsed.checkedAt,
    expiresAt,
  }
  const trustedEdgeHeader = Buffer.from(JSON.stringify(trustedEdgeContext), 'utf8').toString(
    'base64url'
  )
  return Object.freeze({ claims, bound, checkpoint: parsed, trustedEdgeContext, trustedEdgeHeader })
}
