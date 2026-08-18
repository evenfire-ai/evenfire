import {
  ACTION_CONTEXT_VERSION,
  type ActionAuthorityCheckpointRequestV2,
  type ActionAuthorityCheckpointResponseV2,
  type CanonicalResourceIdentityWire,
  canonicalActionTarget,
  hashActionTarget,
  requireActionOperationId,
} from '@clerum/action-context-contracts'
import type { K8sGateway } from '../../k8s.js'
import type { ActionCheckpointCallerIdentity } from '../../middleware/actionCheckpointCaller.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import { authorizeActionV2 } from './actionAuthorizer.js'
import { requestedActionContextV2 } from './actionContextV2.js'
import { resolveActionDestination } from './actionDestination.js'
import {
  type CanonicalResourceIdentity,
  canonicalResourceIdentity,
  resourceIdentityKey,
} from './resourceIdentity.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,127}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function parseResource(value: unknown): CanonicalResourceIdentity {
  if (!isPlainObject(value)) throw new Error('invalid_binding')
  const keys = ['environmentId', 'type', 'canonicalId', 'logicalId', 'displayName']
  if (Object.prototype.hasOwnProperty.call(value, 'providerUid')) keys.push('providerUid')
  if (!hasExactKeys(value, keys)) throw new Error('invalid_binding')
  const resource = canonicalResourceIdentity({
    environmentId: value.environmentId,
    type: value.type,
    logicalId: value.logicalId,
    displayName: value.displayName,
    ...(value.providerUid !== undefined ? { providerUid: value.providerUid } : {}),
  })
  if (JSON.stringify(resource) !== JSON.stringify(value)) throw new Error('invalid_binding')
  return resource
}

export function parseActionAuthorityCheckpointRequest(
  value: unknown,
  caller: ActionCheckpointCallerIdentity
): ActionAuthorityCheckpointRequestV2 {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'version',
      'principal',
      'delegationJti',
      'resource',
      'operationId',
      'target',
      'targetHash',
      'accessPathId',
      'authorizationRevision',
      'behaviorBindingHash',
      'domain',
    ]) ||
    value.version !== ACTION_CONTEXT_VERSION ||
    !isPlainObject(value.principal) ||
    !hasExactKeys(value.principal, ['sub', 'sid', 'sessionVersion']) ||
    !UUID_PATTERN.test(String(value.principal.sub)) ||
    !UUID_PATTERN.test(String(value.principal.sid)) ||
    !Number.isSafeInteger(value.principal.sessionVersion) ||
    Number(value.principal.sessionVersion) < 1 ||
    !UUID_PATTERN.test(String(value.delegationJti)) ||
    typeof value.targetHash !== 'string' ||
    !HASH_PATTERN.test(value.targetHash) ||
    typeof value.behaviorBindingHash !== 'string' ||
    !HASH_PATTERN.test(value.behaviorBindingHash) ||
    !isPlainObject(value.domain) ||
    !hasExactKeys(value.domain, ['service', 'resource', 'targetHash']) ||
    value.domain.service !== caller.service ||
    value.domain.targetHash !== value.targetHash
  ) {
    throw new Error('invalid_binding')
  }
  const operationId = requireActionOperationId(value.operationId)
  const resource = parseResource(value.resource)
  const domainResource = parseResource(value.domain.resource)
  if (
    resourceIdentityKey(resource) !== resourceIdentityKey(domainResource) ||
    JSON.stringify(resource) !== JSON.stringify(domainResource)
  ) {
    throw new Error('invalid_binding')
  }
  const target = canonicalActionTarget(value.target)
  if (
    JSON.stringify(target) !== JSON.stringify(value.target) ||
    hashActionTarget(target) !== value.targetHash
  ) {
    throw new Error('invalid_binding')
  }
  let requested
  try {
    requested = requestedActionContextV2({
      accessPathId: value.accessPathId,
      authorizationRevision: value.authorizationRevision,
    })
  } catch {
    throw new Error('invalid_binding')
  }
  if (!requested.requestedAccessPathId || !requested.expectedAuthorizationRevision) {
    throw new Error('invalid_binding')
  }
  return Object.freeze({
    version: ACTION_CONTEXT_VERSION,
    principal: Object.freeze({
      sub: String(value.principal.sub),
      sid: String(value.principal.sid),
      sessionVersion: Number(value.principal.sessionVersion),
    }),
    delegationJti: String(value.delegationJti),
    resource,
    operationId,
    target,
    targetHash: value.targetHash,
    accessPathId: requested.requestedAccessPathId,
    authorizationRevision: requested.expectedAuthorizationRevision,
    behaviorBindingHash: value.behaviorBindingHash,
    domain: Object.freeze({
      service: caller.service,
      resource: domainResource as CanonicalResourceIdentityWire,
      targetHash: value.targetHash,
    }),
  })
}

export async function checkpointActionAuthority(
  input: {
    request: ActionAuthorityCheckpointRequestV2
    gateway: Pick<K8sGateway, 'getResourceExact'>
    budget: AccessExecutionBudget
    correlationId?: string
    now?: Date
  },
  dependencies: Readonly<{
    authorize?: typeof authorizeActionV2
    resolveDestination?: typeof resolveActionDestination
  }> = {}
): Promise<ActionAuthorityCheckpointResponseV2> {
  const authorize = dependencies.authorize ?? authorizeActionV2
  const result = await authorize({
    session: Object.freeze({
      contract: 'v2',
      authorityMode: 'logical_session_checkpoint',
      userId: input.request.principal.sub,
      sid: input.request.principal.sid,
      sessionVersion: input.request.principal.sessionVersion,
    }),
    requested: requestedActionContextV2({
      accessPathId: input.request.accessPathId,
      authorizationRevision: input.request.authorizationRevision,
    }),
    operationId: input.request.operationId,
    resource: input.request.resource as CanonicalResourceIdentity,
    operationTarget: input.request.target,
    allocateChatMessageId: false,
    budget: input.budget,
    gateway: input.gateway,
    correlationId: input.correlationId,
  })
  if (result.status === 'authority_unavailable') {
    return {
      version: ACTION_CONTEXT_VERSION,
      status: 'authority_unavailable',
      code: 'authority_unavailable',
      retryable: true,
    }
  }
  if (result.status === 'not_found') {
    return { version: ACTION_CONTEXT_VERSION, status: 'not_found', code: 'not_found' }
  }
  if (result.status === 'access_path_stale') {
    return {
      version: ACTION_CONTEXT_VERSION,
      status: 'access_path_stale',
      code: 'access_path_stale',
      currentAuthorizationRevision: result.currentAuthorizationRevision,
    }
  }
  if (result.status === 'denied') return { version: 2, status: 'denied', code: 'forbidden' }
  if (result.status === 'access_path_required' || result.status === 'invalid_binding') {
    return { version: 2, status: 'invalid_binding', code: 'invalid_binding' }
  }
  if (
    result.context.targetHash !== input.request.targetHash ||
    result.context.behaviorBindingHash !== input.request.behaviorBindingHash
  ) {
    return { version: 2, status: 'invalid_binding', code: 'invalid_binding' }
  }
  const destinationResolver = dependencies.resolveDestination ?? resolveActionDestination
  const destination = await destinationResolver({
    resource: result.context.resource,
    gateway: input.gateway,
    budget: input.budget,
  })
  if (destination.status !== 'resolved') {
    return destination.status === 'unavailable'
      ? {
          version: ACTION_CONTEXT_VERSION,
          status: 'authority_unavailable',
          code: 'authority_unavailable',
          retryable: true,
        }
      : { version: ACTION_CONTEXT_VERSION, status: 'not_found', code: 'not_found' }
  }
  const checkedAt = (input.now ?? new Date()).toISOString()
  return Object.freeze({
    version: ACTION_CONTEXT_VERSION,
    status: 'allowed',
    authorizationRevision: result.context.authorizationRevision,
    behaviorBindingHash: result.context.behaviorBindingHash,
    behavior: Object.freeze({
      budget: result.context.behavior.budget,
      credentialPolicy: result.context.behavior.credentialPolicy,
      approvalPolicy: result.context.behavior.approvalPolicy,
      filesystemScope: result.context.behavior.filesystemScope,
      runtime: result.context.behavior.runtime,
      providerModelPolicy: result.context.behavior.providerModelPolicy,
      audit: result.context.behavior.audit,
    }),
    destination: destination.destination,
    checkedAt,
    validUntil: result.context.validUntil,
    attribution: Object.freeze({
      userId: result.context.principal.userId,
      sid: result.context.principal.sid,
      sessionVersion: result.context.principal.sessionVersion,
      accessPathId: result.context.accessPathId,
      pathKind: result.context.pathKind,
      effectiveTeamId: result.context.effectiveTeamId,
    }),
  })
}
