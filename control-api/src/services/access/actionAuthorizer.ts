import type { K8sGateway } from '../../k8s.js'
import type { ExternalSessionAuthorityContext } from '../auth/externalSessionAuthentication.js'
import type { LogicalSessionCheckpointAuthority } from './accessAuthorityStore.js'
import { AccessExecutionBudget } from './accessExecutionBudget.js'
import {
  ActionContextV2Error,
  type RequestedActionContextV2,
  type ValidatedActionContextV2,
  buildValidatedActionContextV2,
} from './actionContextV2.js'
import {
  type PreparedActionOperationTarget,
  prepareActionOperationTarget,
} from './actionMessageId.js'
import {
  type ActionOperationDefinition,
  type ActionOperationId,
  getActionOperationDefinition,
  selectedPathHasRequiredBehavior,
  selectedPathSupportsActionOperation,
  validateActionOperationTarget,
} from './actionOperationRegistry.js'
import {
  type LiveAuthorizationResult,
  resolveLiveAuthorization,
} from './liveAuthorizationResolver.js'
import { actionOperationTargetHash } from './operationTarget.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'

export type ActionAuthorizationV2Result =
  | Readonly<{
      status: 'allowed'
      context: ValidatedActionContextV2
      behaviorBindingHash: string
      operation: ActionOperationDefinition
      preparedTarget: PreparedActionOperationTarget
    }>
  | Readonly<{ status: 'invalid_binding'; code: 'invalid_binding' }>
  | Readonly<{ status: 'denied'; code: 'forbidden' | 'session_not_live' }>
  | Readonly<{ status: 'not_found'; code: 'not_found' }>
  | Readonly<{
      status: 'access_path_required'
      code: 'access_path_required'
      paths: readonly Readonly<{ id: string; kind: 'direct' | 'team'; teamId?: string }>[]
    }>
  | Readonly<{
      status: 'access_path_stale'
      code: 'access_path_stale'
      currentAuthorizationRevision: string
    }>
  | Readonly<{
      status: 'authority_unavailable'
      code: 'authority_unavailable'
      retryable: true
    }>

type Resolver = typeof resolveLiveAuthorization

function unavailable(): Extract<ActionAuthorizationV2Result, { status: 'authority_unavailable' }> {
  return { status: 'authority_unavailable', code: 'authority_unavailable', retryable: true }
}

function mapResolverOutcome(
  result: Exclude<LiveAuthorizationResult, { status: 'allowed' }>
): Exclude<ActionAuthorizationV2Result, { status: 'allowed' }> {
  if (result.status === 'unavailable') return unavailable()
  if (result.status === 'not_found') return result
  if (result.status === 'access_path_stale') return result
  if (result.status === 'access_path_required') {
    return {
      status: 'access_path_required',
      code: 'access_path_required',
      paths: result.safePathDescriptors,
    }
  }
  if (result.status === 'invalid') return { status: 'invalid_binding', code: 'invalid_binding' }
  return {
    status: 'denied',
    code: result.code === 'session_not_live' ? 'session_not_live' : 'forbidden',
  }
}

export async function authorizeActionV2(
  input: Readonly<{
    session: ExternalSessionAuthorityContext | LogicalSessionCheckpointAuthority
    requested: RequestedActionContextV2
    operationId: ActionOperationId
    resource: CanonicalResourceIdentity
    operationTarget?: unknown
    allocateChatMessageId: boolean
    budget?: AccessExecutionBudget
    gateway?: Pick<K8sGateway, 'getResourceExact'>
    correlationId?: string
  }>,
  dependencies: Readonly<{ resolve?: Resolver; messageId?: () => string }> = {}
): Promise<ActionAuthorizationV2Result> {
  if (input.session.contract !== 'v2') return { status: 'denied', code: 'session_not_live' }
  const operation = getActionOperationDefinition(input.operationId)
  if (operation.pathMode !== 'selected_path' || operation.delegation === 'none') {
    return { status: 'invalid_binding', code: 'invalid_binding' }
  }

  let preparedTarget: PreparedActionOperationTarget
  try {
    if (input.allocateChatMessageId) {
      preparedTarget = prepareActionOperationTarget({
        operationId: input.operationId,
        resource: input.resource,
        operationTarget: input.operationTarget,
        ...(dependencies.messageId ? { allocateMessageId: dependencies.messageId } : {}),
      })
    } else {
      const target = validateActionOperationTarget({
        operationId: input.operationId,
        resource: input.resource,
        operationTarget: input.operationTarget,
      })
      preparedTarget = Object.freeze({ target, targetHash: actionOperationTargetHash(target) })
    }
  } catch {
    return { status: 'invalid_binding', code: 'invalid_binding' }
  }

  const ownedBudget = input.budget ? null : AccessExecutionBudget.create('action')
  const budget = input.budget ?? ownedBudget!
  try {
    const resolve = dependencies.resolve ?? resolveLiveAuthorization
    const result = await resolve(
      {
        session: input.session,
        requiredCapability: operation.requiredCapabilities[0],
        resource: input.resource,
        operationTarget: preparedTarget.target,
        ...(input.requested.requestedAccessPathId
          ? { requestedAccessPathId: input.requested.requestedAccessPathId }
          : {}),
      },
      {
        budget,
        ...(input.gateway ? { gateway: input.gateway } : {}),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }
    )
    if (result.status !== 'allowed') return mapResolverOutcome(result)
    if (
      input.requested.expectedAuthorizationRevision !== undefined &&
      input.requested.expectedAuthorizationRevision !== result.authorizationRevision
    ) {
      return {
        status: 'access_path_stale',
        code: 'access_path_stale',
        currentAuthorizationRevision: result.authorizationRevision,
      }
    }
    if (
      !selectedPathSupportsActionOperation(operation, result.selectedPath.behavior.capabilities)
    ) {
      return { status: 'denied', code: 'forbidden' }
    }
    if (!selectedPathHasRequiredBehavior(operation, result.selectedPath.behavior)) {
      return unavailable()
    }
    try {
      const context = buildValidatedActionContextV2({
        session: input.session,
        requested: input.requested,
        operation,
        resource: input.resource,
        preparedTarget,
        authorization: result,
      })
      return Object.freeze({
        status: 'allowed',
        context,
        behaviorBindingHash: context.behaviorBindingHash,
        operation,
        preparedTarget,
      })
    } catch (error) {
      if (error instanceof ActionContextV2Error && error.code === 'access_path_stale') {
        return {
          status: 'access_path_stale',
          code: 'access_path_stale',
          currentAuthorizationRevision: result.authorizationRevision,
        }
      }
      if (
        error instanceof ActionContextV2Error &&
        error.code === 'selected_path_capability_missing'
      ) {
        return { status: 'denied', code: 'forbidden' }
      }
      throw error
    }
  } catch {
    return unavailable()
  } finally {
    ownedBudget?.close()
  }
}
