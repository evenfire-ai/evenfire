import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ApprovalGateParams,
  type McpHostRuntimeAuth,
  gateStep,
} from '../userApprovalRequester'

describe('user approval requester retired approver mapping', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('names the removed approver in the step error without retrying or polling', async () => {
    // Body copied from control-api's POST /workflow-approvals/request refusal.
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({ error: 'approval_target_retired' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const params: ApprovalGateParams = {
      stepId: 'approve-step',
      executionId: 'attempt-1',
      target: { userId: '00000000-0000-4000-8000-000000000001' },
      message: 'Approve the step',
      approvalRecipe: { recipeNamespace: 'default', recipeName: 'removed-approver' },
    }
    const auth = {
      ['access' + 'Token']: 'a',
      ['refresh' + 'Token']: 'r',
      baseUrl: 'http://control-api.test',
      hostRef: 'default/removed-approver',
      recipeNamespace: 'default',
      recipeName: 'removed-approver',
    } as unknown as McpHostRuntimeAuth

    await expect(gateStep(params, auth)).rejects.toThrow(
      'The approver for this approval request has been removed. Choose another approver.'
    )
    // One request call, and no status poll after it.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const calls = fetchMock.mock.calls as unknown as unknown[][]
    expect(String(calls[0][0])).toContain('/workflow-approvals/request')
  })
})
