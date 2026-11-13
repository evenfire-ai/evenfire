import { randomUUID } from 'node:crypto'
import {
  type ActionOperationId,
  type CanonicalActionTarget,
  type DelegationV2IssuanceResponse,
  canonicalActionTarget,
} from '@clerum/action-context-contracts'
import {
  ActionOperationTargetError,
  validateActionOperationTarget,
} from './actionOperationRegistry.js'
import { actionOperationTargetHash } from './operationTarget.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type PreparedActionOperationTarget = Readonly<{
  target: CanonicalActionTarget
  targetHash: string
  messageId?: string
}>

export function prepareActionOperationTarget(input: {
  operationId: ActionOperationId
  resource: CanonicalResourceIdentity
  operationTarget?: unknown
  allocateMessageId?: () => string
}): PreparedActionOperationTarget {
  let operationTarget = input.operationTarget
  let messageId: string | undefined
  if (input.operationId === 'chat.message.invoke') {
    let callerTarget: CanonicalActionTarget
    try {
      callerTarget = canonicalActionTarget(operationTarget)
    } catch {
      throw new ActionOperationTargetError('invalid')
    }
    if (!callerTarget || 'messageId' in callerTarget) {
      throw new ActionOperationTargetError('invalid')
    }
    const allocate = input.allocateMessageId ?? randomUUID
    messageId = allocate().toLowerCase()
    if (!UUID_PATTERN.test(messageId)) throw new Error('message_id_allocator_invalid')
    operationTarget = { ...callerTarget, messageId }
  }
  const target = validateActionOperationTarget({
    operationId: input.operationId,
    resource: input.resource,
    operationTarget,
  })
  return Object.freeze({
    target,
    targetHash: actionOperationTargetHash(target),
    ...(messageId ? { messageId } : {}),
  })
}

export function delegationV2IssuanceResponse(input: {
  operationId: ActionOperationId
  delegationToken: string
  prepared: PreparedActionOperationTarget
}): DelegationV2IssuanceResponse {
  if (!input.delegationToken.trim()) throw new Error('delegation_token_missing')
  if (input.operationId === 'chat.message.invoke' && !input.prepared.messageId) {
    throw new Error('message_id_missing')
  }
  if (input.operationId !== 'chat.message.invoke' && input.prepared.messageId) {
    throw new Error('message_id_unexpected')
  }
  return Object.freeze({
    delegationToken: input.delegationToken,
    ...(input.prepared.messageId ? { messageId: input.prepared.messageId } : {}),
  })
}
