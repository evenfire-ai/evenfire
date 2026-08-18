import type {
  ActionOperationId,
  AuthorityBindingV2,
  TrustedEdgeActionContextV2,
} from '@clerum/action-context-contracts'

export class RuntimeActionAuthorityError extends Error {
  constructor(readonly code: 'authority_unavailable' | 'access_path_stale' | 'operation_mismatch') {
    super(code)
    this.name = 'RuntimeActionAuthorityError'
  }
}

export function authorityBindingFromTrustedEdge(
  context: TrustedEdgeActionContextV2
): AuthorityBindingV2 {
  return Object.freeze({
    version: 2,
    userId: context.userId,
    sid: context.sid,
    sessionVersion: context.sessionVersion,
    delegationJti: context.delegationJti,
    operationId: context.operationId,
    resource: context.resource,
    target: context.target,
    targetHash: context.targetHash,
    accessPathId: context.accessPathId,
    authorizationRevision: context.authorizationRevision,
    pathKind: context.pathKind,
    effectiveTeamId: context.effectiveTeamId,
    behaviorBindingHash: context.behaviorBindingHash,
  })
}

export function assertRuntimeActionCurrent(
  context: TrustedEdgeActionContextV2,
  operationId: ActionOperationId,
  now = Date.now()
): void {
  if (context.operationId !== operationId) {
    throw new RuntimeActionAuthorityError('operation_mismatch')
  }
  if (!Number.isFinite(Date.parse(context.expiresAt))) {
    throw new RuntimeActionAuthorityError('authority_unavailable')
  }
  if (Date.parse(context.expiresAt) <= now) {
    throw new RuntimeActionAuthorityError('access_path_stale')
  }
}

export async function executeRuntimeEffect<T>(input: {
  context: TrustedEdgeActionContextV2
  operationId: ActionOperationId
  checkpoint: (binding: AuthorityBindingV2) => Promise<'allowed' | 'denied' | 'unavailable'>
  effect: () => Promise<T>
  now?: number
}): Promise<T> {
  assertRuntimeActionCurrent(input.context, input.operationId, input.now)
  let decision: 'allowed' | 'denied' | 'unavailable'
  try {
    decision = await input.checkpoint(authorityBindingFromTrustedEdge(input.context))
  } catch {
    throw new RuntimeActionAuthorityError('authority_unavailable')
  }
  if (decision === 'unavailable') throw new RuntimeActionAuthorityError('authority_unavailable')
  if (decision === 'denied') throw new RuntimeActionAuthorityError('access_path_stale')
  return input.effect()
}
