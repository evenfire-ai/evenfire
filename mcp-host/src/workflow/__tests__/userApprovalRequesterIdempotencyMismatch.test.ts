import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ApprovalGateParams,
  type McpHostRuntimeAuth,
  gateStep,
} from '../userApprovalRequester'

describe('user approval requester mismatch mapping', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('maps approval idempotency payload mismatch to a safe action message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        json: async () => ({ error: 'idempotency_key_payload_mismatch' }),
      }))
    )

    const params: ApprovalGateParams = {
      stepId: 'workflow_trigger:sandbox-recipes/due-diligence',
      executionId: 'attempt-1',
      target: { userId: '00000000-0000-4000-8000-000000000001' },
      message: 'Approve workflow trigger for due-diligence',
      approvalRecipe: { recipeNamespace: 'sandbox-recipes', recipeName: 'due-diligence' },
    }
    const auth = {
      ['access' + 'Token']: 'a',
      ['refresh' + 'Token']: 'r',
      baseUrl: 'http://control-api.test',
      hostRef: 'sandbox-recipes/source-recipe',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'source-recipe',
    } as unknown as McpHostRuntimeAuth

    await expect(gateStep(params, auth)).rejects.toThrow(
      'Workflow approval request conflicted with an earlier trigger attempt'
    )
  })
})
