import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'
import { submitProviderWorkflowApprovalDecision } from './providerWorkflowApprovalDecisionClient'
import type { McpHostRuntimeAuth } from './userApprovalRequester'

const mockFetch = vi.fn() as Mock

function auth(overrides: Partial<McpHostRuntimeAuth> = {}): McpHostRuntimeAuth {
  return {
    accessToken: 'runtime-access',
    refreshToken: 'runtime-refresh',
    baseUrl: 'http://gateway:8092',
    hostRef: 'mcp-host/standalone',
    recipeNamespace: 'mcp-host',
    recipeName: 'standalone',
    mcpHostControlToken: 'control-token',
    ...overrides,
  }
}

describe('submitProviderWorkflowApprovalDecision', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('posts provider decisions to control-api with the mcp-host control token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, duplicate: false, run: { id: 'run-1' } }),
    })

    const result = await submitProviderWorkflowApprovalDecision(
      {
        approvalRequestId: '00000000-0000-0000-0000-000000000111',
        decision: 'approve',
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: 'tg-chat-1',
          providerEventId: 'telegram:tg-chat-1:42',
        },
      },
      auth(),
      mockFetch as unknown as typeof fetch
    )

    expect(result).toEqual({ success: true, duplicate: false, run: { id: 'run-1' } })
    expect(mockFetch).toHaveBeenCalledWith(
      'http://gateway:8092/api/v1/workflow-approvals/00000000-0000-0000-0000-000000000111/provider-decision',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer control-token',
          'Content-Type': 'application/json',
        }),
      })
    )
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      decision: 'approve',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
        providerEventId: 'telegram:tg-chat-1:42',
      },
    })
  })

  it('refuses to call control-api without a workflow-control token', async () => {
    await expect(
      submitProviderWorkflowApprovalDecision(
        {
          approvalRequestId: '00000000-0000-0000-0000-000000000111',
          decision: 'deny',
          providerIdentity: {
            medium: 'slack',
            providerUserId: 'U123',
            providerWorkspaceId: 'T123',
            providerChannelId: 'C123',
            providerEventId: 'slack:T123:C123:1700000001.000001',
          },
        },
        auth({ mcpHostControlToken: '' }),
        mockFetch as unknown as typeof fetch
      )
    ).rejects.toThrow('MCP_HOST_WORKFLOW_CONTROL_TOKEN is required')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('preserves HTTP status when control-api returns a non-JSON error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => '<html>bad gateway</html>',
    })

    const result = await submitProviderWorkflowApprovalDecision(
      {
        approvalRequestId: '00000000-0000-0000-0000-000000000111',
        decision: 'approve',
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: 'tg-chat-1',
          providerEventId: 'telegram:tg-chat-1:42',
        },
      },
      auth(),
      mockFetch as unknown as typeof fetch
    )

    expect(result).toEqual({
      success: false,
      error: 'provider decision rejected (502)',
    })
  })
})
