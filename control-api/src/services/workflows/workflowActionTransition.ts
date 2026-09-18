import { createHash, randomUUID } from 'node:crypto'
import { type AuthorityBindingV2, hashActionTarget } from '@clerum/action-context-contracts'
import { stableStringify } from '../../utils/stableStringify.js'
import type { WorkflowAuthorityBinding } from './workflowAuthorityBindingService.js'

export const WORKFLOW_ACTION_TRANSITIONS = Object.freeze([
  Object.freeze({
    source: 'workflow.approval.decide' as const,
    child: 'workflow.approval.consume' as const,
  }),
])

export const WORKFLOW_APPROVAL_CONSUME_TRANSITION_ID =
  'workflow.approval.decide->workflow.approval.consume'

export function deriveApprovalConsumeAuthority(input: {
  parent: WorkflowAuthorityBinding
  recipeNamespace: string
  recipeName: string
  approvalExpiresAt: string | Date
}): WorkflowAuthorityBinding {
  if (
    input.parent.binding.operationId !== 'workflow.approval.decide' ||
    !input.parent.binding.target ||
    input.parent.binding.target.decision !== 'approve'
  ) {
    throw new Error('workflow_approval_consume_parent_invalid')
  }
  const target = Object.freeze({
    approvalId: input.parent.binding.target.approvalId,
    decision: 'approve',
    recipeNamespace: input.recipeNamespace,
    recipeName: input.recipeName,
  })
  const binding: AuthorityBindingV2 = Object.freeze({
    ...input.parent.binding,
    delegationJti: randomUUID(),
    operationId: 'workflow.approval.consume',
    target,
    targetHash: hashActionTarget(target),
  })
  return Object.freeze({
    binding,
    sourceIssuedAt: input.parent.sourceIssuedAt,
    sourceExpiresAt: Math.min(
      input.parent.sourceExpiresAt,
      Math.floor(new Date(input.approvalExpiresAt).getTime() / 1000)
    ),
    bindingHash: createHash('sha256').update(stableStringify(binding)).digest('hex'),
  })
}
