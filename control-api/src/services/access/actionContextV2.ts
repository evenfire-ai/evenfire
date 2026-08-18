import {
  ACTION_CONTEXT_VERSION,
  type ActionOperationId,
  type CanonicalActionTarget,
  actionBehaviorBindingHash,
} from '@clerum/action-context-contracts'
import type { ExternalSessionAuthorityContext } from '../auth/externalSessionAuthentication.js'
import type { AccessPathBehavior, AccessPathKind } from './accessPath.js'
import type { PreparedActionOperationTarget } from './actionMessageId.js'
import {
  type ActionOperationDefinition,
  selectedPathHasRequiredBehavior,
  selectedPathSupportsActionOperation,
} from './actionOperationRegistry.js'
import type { AccessCapability } from './capabilityRegistry.js'
import type { LiveAuthorizationResult } from './liveAuthorizationResolver.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'

export const ACCESS_PATH_HEADER = 'x-evenfire-access-path-id'
export const AUTHORIZATION_REVISION_HEADER = 'x-evenfire-authorization-revision'

const ACCESS_PATH_PATTERN = /^ap1_[A-Za-z0-9_-]{43}$/
const AUTHORIZATION_REVISION_PATTERN = /^ar1_[A-Za-z0-9_-]{43}$/

export type RequestedActionContextV2 = Readonly<{
  version: 2
  requestedAccessPathId?: string
  expectedAuthorizationRevision?: string
}>

export type ValidatedActionContextV2 = Readonly<{
  version: 2
  principal: Readonly<{ userId: string; sid: string; sessionVersion: number }>
  operationId: ActionOperationId
  resource: CanonicalResourceIdentity
  target: CanonicalActionTarget
  targetHash: string
  accessPathId: string
  authorizationRevision: string
  behaviorBindingHash: string
  pathKind: AccessPathKind
  effectiveTeamId: string | null
  selectedPathCapabilities: readonly AccessCapability[]
  behavior: AccessPathBehavior
  validUntil: string | null
}>

export type ActionContextV2Outcome =
  | Readonly<{ status: 'allowed'; context: ValidatedActionContextV2 }>
  | Readonly<{ status: 'denied'; code: 'forbidden' | 'session_not_live' }>
  | Readonly<{ status: 'not_found'; code: 'not_found' }>
  | Readonly<{ status: 'access_path_required'; code: 'access_path_required' }>
  | Readonly<{
      status: 'access_path_stale'
      code: 'access_path_stale'
      currentAuthorizationRevision: string
    }>
  | Readonly<{
      status: 'authority_unavailable'
      retryable: true
      dependencyClass: 'authorization_store' | 'operational_resource_store' | 'capacity'
    }>
  | Readonly<{ status: 'operational_partial'; complete: false }>

export class ActionContextV2Error extends Error {
  constructor(
    readonly code:
      | 'invalid_request_context'
      | 'v2_session_required'
      | 'access_path_stale'
      | 'selected_path_capability_missing'
      | 'behavior_dimension_unavailable'
  ) {
    super(code)
    this.name = 'ActionContextV2Error'
  }
}

function optionalBoundHeader(value: unknown, pattern: RegExp): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value !== value.trim() || !pattern.test(value)) {
    throw new ActionContextV2Error('invalid_request_context')
  }
  return value
}

export function requestedActionContextV2(input: {
  accessPathId?: unknown
  authorizationRevision?: unknown
}): RequestedActionContextV2 {
  const requestedAccessPathId = optionalBoundHeader(input.accessPathId, ACCESS_PATH_PATTERN)
  const expectedAuthorizationRevision = optionalBoundHeader(
    input.authorizationRevision,
    AUTHORIZATION_REVISION_PATTERN
  )
  return Object.freeze({
    version: ACTION_CONTEXT_VERSION,
    ...(requestedAccessPathId ? { requestedAccessPathId } : {}),
    ...(expectedAuthorizationRevision ? { expectedAuthorizationRevision } : {}),
  })
}

export function buildValidatedActionContextV2(input: {
  session: Readonly<{
    contract: 'v2'
    userId: string
    sid: string
    sessionVersion: number
  }>
  requested: RequestedActionContextV2
  operation: ActionOperationDefinition
  resource: CanonicalResourceIdentity
  preparedTarget: PreparedActionOperationTarget
  authorization: Extract<LiveAuthorizationResult, { status: 'allowed' }>
}): ValidatedActionContextV2 {
  if (input.session.contract !== 'v2') throw new ActionContextV2Error('v2_session_required')
  const selectedPath = input.authorization.selectedPath
  if (
    selectedPath.authorizationRevision !== input.authorization.authorizationRevision ||
    (input.requested.expectedAuthorizationRevision !== undefined &&
      input.requested.expectedAuthorizationRevision !== input.authorization.authorizationRevision)
  ) {
    throw new ActionContextV2Error('access_path_stale')
  }
  if (
    input.requested.requestedAccessPathId !== undefined &&
    input.requested.requestedAccessPathId !== selectedPath.id
  ) {
    throw new ActionContextV2Error('access_path_stale')
  }
  if (!selectedPathSupportsActionOperation(input.operation, selectedPath.behavior.capabilities)) {
    throw new ActionContextV2Error('selected_path_capability_missing')
  }
  if (!selectedPathHasRequiredBehavior(input.operation, selectedPath.behavior)) {
    throw new ActionContextV2Error('behavior_dimension_unavailable')
  }
  const behaviorBindingHash = actionBehaviorBindingHash({
    accessPathId: selectedPath.id,
    authorizationRevision: input.authorization.authorizationRevision,
    behavior: selectedPath.behavior,
  })
  return Object.freeze({
    version: ACTION_CONTEXT_VERSION,
    principal: Object.freeze({
      userId: input.session.userId,
      sid: input.session.sid,
      sessionVersion: input.session.sessionVersion,
    }),
    operationId: input.operation.operationId,
    resource: input.resource,
    target: input.preparedTarget.target,
    targetHash: input.preparedTarget.targetHash,
    accessPathId: selectedPath.id,
    authorizationRevision: input.authorization.authorizationRevision,
    behaviorBindingHash,
    pathKind: selectedPath.kind,
    effectiveTeamId: selectedPath.teamId ?? null,
    selectedPathCapabilities: Object.freeze([...selectedPath.behavior.capabilities]),
    behavior: selectedPath.behavior,
    validUntil: input.authorization.validUntil,
  })
}
