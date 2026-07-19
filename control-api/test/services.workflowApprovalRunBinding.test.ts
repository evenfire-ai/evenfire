import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import {
  InvalidWorkflowApprovalRunBindingError,
  resolveWorkflowApprovalRunBinding,
} from '../src/services/userApprovalRequestService.js'

const RUN_ID = '22222222-2222-4222-8222-222222222222'
const PROOF = '33333333-3333-4333-8333-333333333333'
const CHILD_RECIPE = 'risk-review-22222222'

describe('workflow approval authoritative run binding', () => {
  it('binds only an exact running WRC workflow run and step', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ runId: RUN_ID, stepId: 'approval-gated-step' }],
      rowCount: 1,
    })

    await expect(
      resolveWorkflowApprovalRunBinding({ query } as unknown as DbClient, {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
        correlation: {
          taskId: `${RUN_ID}:${CHILD_RECIPE}:2026-07-12T01:00:00.000Z`,
          stepId: 'approval-gated-step',
        },
        runBindingProof: PROOF,
      })
    ).resolves.toEqual({ runId: RUN_ID, stepId: 'approval-gated-step' })
    const sql = String(query.mock.calls[0]![0])
    expect(sql).toContain("step.phase = 'Running'")
    expect(sql).toContain("root.source_kind = 'wrc_internal_control'")
    expect(sql).toContain("root.source_service = 'workflow-recipes'")
    expect(sql).toContain('step.approval_binding_sha256 = $5')
    expect(sql).toContain('wr.child_recipe_namespace = $2')
    expect(sql).toContain('wr.child_recipe_name = $6')
    expect(query.mock.calls[0]![1]).toEqual([
      RUN_ID,
      'sandbox-recipes',
      'risk-review',
      'approval-gated-step',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      CHILD_RECIPE,
    ])
  })

  it('rejects a UUID correlation without an authoritative run-step relation', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await expect(
      resolveWorkflowApprovalRunBinding({ query } as unknown as DbClient, {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
        correlation: {
          taskId: `${RUN_ID}:${CHILD_RECIPE}:2026-07-12T01:00:00.000Z`,
          stepId: 'approval-gated-step',
        },
        runBindingProof: PROOF,
      })
    ).rejects.toBeInstanceOf(InvalidWorkflowApprovalRunBindingError)
  })

  it('leaves pre-run trigger approvals unbound', async () => {
    const query = vi.fn()
    await expect(
      resolveWorkflowApprovalRunBinding({ query } as unknown as DbClient, {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
        correlation: { taskId: 'telegram:group:message', stepId: 'trigger' },
      })
    ).resolves.toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects a workflow run hint without its run-specific proof', async () => {
    const query = vi.fn()
    await expect(
      resolveWorkflowApprovalRunBinding({ query } as unknown as DbClient, {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
        correlation: {
          taskId: `${RUN_ID}:${CHILD_RECIPE}:2026-07-12T01:00:00.000Z`,
          stepId: 'approval-gated-step',
        },
      })
    ).rejects.toBeInstanceOf(InvalidWorkflowApprovalRunBindingError)
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects a malformed child runtime name before querying the database', async () => {
    const query = vi.fn()
    await expect(
      resolveWorkflowApprovalRunBinding({ query } as unknown as DbClient, {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
        correlation: {
          taskId: `${RUN_ID}:Risk Review:2026-07-12T01:00:00.000Z`,
          stepId: 'approval-gated-step',
        },
        runBindingProof: PROOF,
      })
    ).rejects.toBeInstanceOf(InvalidWorkflowApprovalRunBindingError)
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects a run-specific proof when correlation cannot name the exact run', async () => {
    const query = vi.fn()
    await expect(
      resolveWorkflowApprovalRunBinding({ query } as unknown as DbClient, {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
        correlation: { taskId: 'telegram:group:message', stepId: 'approval-gated-step' },
        runBindingProof: PROOF,
      })
    ).rejects.toBeInstanceOf(InvalidWorkflowApprovalRunBindingError)
    expect(query).not.toHaveBeenCalled()
  })
})
