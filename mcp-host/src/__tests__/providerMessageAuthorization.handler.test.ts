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

  // A null context is not a thrown broker failure, so classifyAuthorizationFailure
  // never sees it and its reason is hardcoded. 'error' keeps channel-reader silent:
  // we have no 404/403 substantiating "this account is unlinked", so we must not
  // claim it.
  it('reports a null caller context as authorized:false, reason:error', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce(null)

    await expect(handleProviderMessageAuthorization({ providerIdentity })).resolves.toEqual({
      authorized: false,
      reason: 'error',
    })
  })

  it('reports a context with no targetUserId as authorized:false, reason:error', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce({
      targetUserId: '',
    } as never)

    await expect(handleProviderMessageAuthorization({ providerIdentity })).resolves.toEqual({
      authorized: false,
      reason: 'error',
    })
  })
})
