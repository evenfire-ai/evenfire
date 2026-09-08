import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_ACTION_TRANSITIONS,
  deriveApprovalConsumeAuthority,
} from '../src/services/workflows/workflowActionTransition.js'

const parent = {
  binding: {
    version: 2,
    userId: '11111111-1111-4111-8111-111111111111',
    sid: '22222222-2222-4222-8222-222222222222',
    sessionVersion: 2,
    delegationJti: '33333333-3333-4333-8333-333333333333',
    operationId: 'workflow.approval.decide',
    resource: { type: 'workflow_approval', logicalId: 'approval-1' },
    target: { approvalId: 'approval-1', decision: 'approve' },
    targetHash: 'ath2_parent',
    accessPathId: 'ap1_path',
    authorizationRevision: 'ar1_revision',
    pathKind: 'direct',
    effectiveTeamId: null,
    behaviorBindingHash: 'bh2_behavior',
  },
  sourceIssuedAt: 1_700_000_000,
  sourceExpiresAt: 1_700_000_300,
  bindingHash: 'parent-hash',
} as never

describe('workflow action transition registry', () => {
  it('contains exactly the owner-approved approval decide to consume edge', () => {
    expect(WORKFLOW_ACTION_TRANSITIONS).toEqual([
      { source: 'workflow.approval.decide', child: 'workflow.approval.consume' },
    ])
  })

  it('derives an exact one-shot child bounded by parent and approval expiry', () => {
    const child = deriveApprovalConsumeAuthority({
      parent,
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'demo',
      approvalExpiresAt: new Date(1_700_000_120 * 1000),
    })

    expect(child.binding).toMatchObject({
      operationId: 'workflow.approval.consume',
      accessPathId: 'ap1_path',
      authorizationRevision: 'ar1_revision',
      target: {
        approvalId: 'approval-1',
        decision: 'approve',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'demo',
      },
    })
    expect(child.binding.delegationJti).not.toBe(parent.binding.delegationJti)
    expect(child.sourceExpiresAt).toBe(1_700_000_120)
  })

  it('rejects any non-approve or non-decision parent', () => {
    expect(() =>
      deriveApprovalConsumeAuthority({
        parent: {
          ...parent,
          binding: { ...parent.binding, operationId: 'workflow.trigger' },
        } as never,
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'demo',
        approvalExpiresAt: new Date(1_700_000_120 * 1000),
      })
    ).toThrow('workflow_approval_consume_parent_invalid')
  })
})
