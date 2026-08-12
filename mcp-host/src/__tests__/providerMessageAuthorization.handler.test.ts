import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowBrokerRequestError } from '../core/tools/workflowBrokerClient'
import { handleProviderMessageAuthorization } from '../main'
import { resolveProviderWorkflowCallerContext } from '../workflow/providerWorkflowCallerContextClient'

vi.mock('../workflow/providerWorkflowCallerContextClient', () => ({
  resolveProviderWorkflowCallerContext: vi.fn(),
}))

const providerIdentity = {
  medium: 'slack' as const,
  providerUserId: 'U123',
  providerChannelId: 'C123',
  providerChannelType: 'im',
  providerTarget: {
    hostRef: 'agent-a',
    communicationChannelNamespace: 'channels',
    communicationChannelName: 'agent-a-slack',
  },
}

describe('handleProviderMessageAuthorization', () => {
  beforeEach(() => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockReset()
  })

  it('classifies a thrown 404 medium_account_not_found as authorized:false, reason:unresolved', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockRejectedValueOnce(
      new WorkflowBrokerRequestError(404, 'medium_account_not_found', 'not found')
    )

    await expect(handleProviderMessageAuthorization({ providerIdentity })).resolves.toEqual({
      authorized: false,
      reason: 'unresolved',
    })
  })

  it('classifies a thrown 500 as authorized:false, reason:error', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockRejectedValueOnce(
      new WorkflowBrokerRequestError(500, null, 'boom')
    )

    await expect(handleProviderMessageAuthorization({ providerIdentity })).resolves.toEqual({
      authorized: false,
      reason: 'error',
    })
  })
})
