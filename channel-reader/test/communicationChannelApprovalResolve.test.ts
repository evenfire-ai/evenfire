import { describe, expect, it, vi } from 'vitest'
import type { ChannelAdapter } from '../src/types'
import {
  ChannelReader,
  makeChannel,
  makeMessage,
  makeRpcClient,
} from './communicationChannelApprovalHarness'

function telegramAdapter(replies: string[]): ChannelAdapter {
  return {
    channelType: 'telegram',
    connect: vi.fn(),
    disconnect: vi.fn(),
    fetchMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async (_channelId, content) => {
      replies.push(content)
      return `reply-${replies.length}`
    }),
    editMessage: vi.fn(),
  }
}

describe('CommunicationChannel approval resolution path', () => {
  it('resolves Telegram approval button callbacks by exact approval request id', async () => {
    const replies: string[] = []
    const approvalRequestId = '00000000-0000-0000-0000-000000000222'
    const rpcClient = makeRpcClient()
    const reader = new ChannelReader({
      rpcClient,
      notificationDeliveryClient: {
        fetchDeliveries: vi.fn(async () => []),
        acknowledge: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
      },
      adapters: new Map([['telegram', telegramAdapter(replies)]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    await reader.handleMessages([
      {
        ...makeMessage('/approve ' + approvalRequestId),
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'telegram-chat-1',
          providerEventId: 'telegram:telegram-chat-1:callback:callback-approve-1',
        },
        rawData: {
          telegramCallbackApprovalRequestId: approvalRequestId,
          telegramCallbackDecision: 'approve',
        },
      },
    ])

    expect(rpcClient.resolveWorkflowApproval).not.toHaveBeenCalled()
    expect(rpcClient.sendWorkflowApprovalDecision).toHaveBeenCalledWith({
      approvalRequestId,
      decision: 'approve',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'telegram-chat-1',
        providerEventId: 'telegram:telegram-chat-1:callback:callback-approve-1',
      },
    })
    expect(replies.at(-1)).toBe('Approved. Workflow approval recorded.')
  })

  it('resolves /approve <workflow-name> to the pending workflow approval', async () => {
    const replies: string[] = []
    const approvalRequestId = '00000000-0000-0000-0000-000000000222'
    const rpcClient = makeRpcClient()
    const notificationDeliveryClient = {
      fetchDeliveries: vi.fn(async () => [
        {
          id: 'delivery-1',
          eventType: 'approval.requested' as const,
          medium: 'telegram' as const,
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'telegram-chat-1',
          attempts: 1,
          payload: {
            approvalRequestId,
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'due-diligence',
            title: 'Approve workflow trigger',
            body: 'Approval requested for sandbox-recipes/due-diligence',
            actions: [
              { id: 'approve', label: 'Approve' },
              { id: 'deny', label: 'Deny' },
            ],
          },
        },
      ]),
      acknowledge: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    }

    const reader = new ChannelReader({
      rpcClient,
      notificationDeliveryClient,
      adapters: new Map([['telegram', telegramAdapter(replies)]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    await reader.pollCycle()
    await reader.handleMessages([makeMessage('/approve due-diligence')])

    expect(rpcClient.sendWorkflowApprovalDecision).toHaveBeenCalledWith({
      approvalRequestId,
      decision: 'approve',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'telegram-chat-1',
        providerEventId: 'telegram:telegram-chat-1:msg--approve-due-diligence',
      },
    })
    expect(replies.at(-1)).toBe('Approved. Workflow approval recorded.')
  })

  it('resolves /approve <workflow-name> through mcp-host when local pending state was lost', async () => {
    const replies: string[] = []
    const approvalRequestId = '00000000-0000-0000-0000-000000000333'
    const rpcClient = makeRpcClient({
      resolveWorkflowApproval: vi.fn(async () => ({ approvalRequestId })),
    })
    const notificationDeliveryClient = {
      fetchDeliveries: vi.fn(async () => []),
      acknowledge: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    }

    const reader = new ChannelReader({
      rpcClient,
      notificationDeliveryClient,
      adapters: new Map([['telegram', telegramAdapter(replies)]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    await reader.handleMessages([makeMessage('/approve due-diligence')])

    expect(rpcClient.resolveWorkflowApproval).toHaveBeenCalledWith({
      recipeName: 'due-diligence',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'telegram-chat-1',
        providerEventId: 'telegram:telegram-chat-1:msg--approve-due-diligence',
      },
    })
    expect(rpcClient.sendWorkflowApprovalDecision).toHaveBeenCalledWith({
      approvalRequestId,
      decision: 'approve',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'telegram-chat-1',
        providerEventId: 'telegram:telegram-chat-1:msg--approve-due-diligence',
      },
    })
    expect(replies.at(-1)).toBe('Approved. Workflow approval recorded.')
  })

  it('reconciles ambiguous local workflow approval cache through mcp-host before blocking', async () => {
    const replies: string[] = []
    const staleApprovalRequestId = '00000000-0000-0000-0000-000000000222'
    const liveApprovalRequestId = '00000000-0000-0000-0000-000000000333'
    const rpcClient = makeRpcClient({
      resolveWorkflowApproval: vi.fn(async () => ({ approvalRequestId: liveApprovalRequestId })),
    })
    const notificationDeliveryClient = {
      fetchDeliveries: vi.fn(async () => [
        {
          id: 'delivery-1',
          eventType: 'approval.requested' as const,
          medium: 'telegram' as const,
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'telegram-chat-1',
          attempts: 1,
          payload: {
            approvalRequestId: staleApprovalRequestId,
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'due-diligence',
            title: 'Approve workflow trigger',
            body: 'Approval requested for sandbox-recipes/due-diligence',
            actions: [
              { id: 'approve', label: 'Approve' },
              { id: 'deny', label: 'Deny' },
            ],
          },
        },
        {
          id: 'delivery-2',
          eventType: 'approval.requested' as const,
          medium: 'telegram' as const,
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'telegram-chat-1',
          attempts: 1,
          payload: {
            approvalRequestId: liveApprovalRequestId,
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'due-diligence',
            title: 'Approve workflow trigger',
            body: 'Approval requested for sandbox-recipes/due-diligence',
            actions: [
              { id: 'approve', label: 'Approve' },
              { id: 'deny', label: 'Deny' },
            ],
          },
        },
      ]),
      acknowledge: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    }

    const reader = new ChannelReader({
      rpcClient,
      notificationDeliveryClient,
      adapters: new Map([['telegram', telegramAdapter(replies)]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    await reader.pollCycle()
    await reader.handleMessages([makeMessage('/approve due-diligence')])

    expect(rpcClient.resolveWorkflowApproval).toHaveBeenCalledWith({
      recipeName: 'due-diligence',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'telegram-chat-1',
        providerEventId: 'telegram:telegram-chat-1:msg--approve-due-diligence',
      },
    })
    expect(rpcClient.sendWorkflowApprovalDecision).toHaveBeenCalledWith({
      approvalRequestId: liveApprovalRequestId,
      decision: 'approve',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'telegram-chat-1',
        providerEventId: 'telegram:telegram-chat-1:msg--approve-due-diligence',
      },
    })
    expect(rpcClient.sendWorkflowApprovalDecision).not.toHaveBeenCalledWith(
      expect.objectContaining({ approvalRequestId: staleApprovalRequestId })
    )
    expect(replies.at(-1)).toBe('Approved. Workflow approval recorded.')
  })

  it('fails visibly when the mcp-host pending approval resolution route is unavailable', async () => {
    const replies: string[] = []
    const rpcClient = makeRpcClient({
      resolveWorkflowApproval: vi.fn(async () => {
        throw new Error('pending workflow approval resolve failed (404)')
      }),
    })
    const notificationDeliveryClient = {
      fetchDeliveries: vi.fn(async () => []),
      acknowledge: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    }

    const reader = new ChannelReader({
      rpcClient,
      notificationDeliveryClient,
      adapters: new Map([['telegram', telegramAdapter(replies)]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    await reader.handleMessages([makeMessage('/approve due-diligence')])

    expect(rpcClient.resolveWorkflowApproval).toHaveBeenCalledWith(
      expect.objectContaining({ recipeName: 'due-diligence' })
    )
    expect(replies.at(-1)).toContain('Could not verify the pending workflow approval')
    expect(replies.at(-1)).not.toContain('No pending workflow approval found')
  })
})
