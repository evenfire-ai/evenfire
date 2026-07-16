import { describe, expect, it, vi } from 'vitest'
import { telegramWorkflowApprovalCallbackData } from '../src/telegramCallbackData'
import type { ChannelAdapter, CommunicationChannelCRD } from '../src/types'
import {
  ChannelReader,
  makeChannel,
  makeMessage,
  makeRpcClient,
} from './communicationChannelApprovalHarness'

describe('CommunicationChannel approval delivery path', () => {
  it('routes /approve through channel-reader to the shared mcp-host approval endpoint', async () => {
    const replies: string[] = []
    const adapter: ChannelAdapter = {
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
    const rpcClient = makeRpcClient({
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-q3',
          requestId: 'approval-q3',
          userId: 'user-q3',
          notification: 'Approval needed',
        },
      })),
      sendApproval: vi.fn(async () => ({ success: true })),
      sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
    })

    const reader = new ChannelReader({
      rpcClient,
      adapters: new Map([['telegram', adapter]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    await reader.handleMessages([makeMessage('run the shared-host approval flow')])
    await reader.handleMessages([makeMessage('/approve')])

    expect(rpcClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: 'telegram',
        channelId: 'telegram-chat-1',
        sender: '123456',
      }),
      { async: true }
    )
    expect(rpcClient.sendApproval).toHaveBeenCalledWith(
      'user-q3',
      'approval-q3',
      false,
      'telegram',
      'telegram-chat-1'
    )
    expect(replies).toEqual(['Approval needed', 'Approved. Processing...'])
  })

  it('delivers queued workflow approval notifications through the configured channel adapter', async () => {
    const replies: Array<{
      channelId: string
      content: string
      options?: Parameters<ChannelAdapter['sendMessage']>[4]
    }> = []
    const adapter: ChannelAdapter = {
      channelType: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async (channelId, content, _replyTo, _attachments, options) => {
        replies.push({ channelId, content, options })
        return `reply-${replies.length}`
      }),
      editMessage: vi.fn(),
    }
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
            approvalRequestId: '00000000-0000-0000-0000-000000000222',
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
      adapters: new Map([['telegram', adapter]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    await reader.pollCycle()

    expect(notificationDeliveryClient.fetchDeliveries).toHaveBeenCalledWith({
      medium: 'telegram',
      providerChannelIds: ['telegram-chat-1'],
      providerWorkspaceId: null,
      hostRef: 'chatllm',
      limit: expect.any(Number),
    })
    expect(replies).toEqual([
      {
        channelId: 'telegram-chat-1',
        content: 'Approve workflow due-diligence?',
        options: {
          telegramInlineKeyboard: [
            [
              {
                text: 'Approve',
                callbackData: telegramWorkflowApprovalCallbackData(
                  'approve',
                  '00000000-0000-0000-0000-000000000222'
                ),
              },
              {
                text: 'Deny',
                callbackData: telegramWorkflowApprovalCallbackData(
                  'deny',
                  '00000000-0000-0000-0000-000000000222'
                ),
              },
            ],
          ],
        },
      },
    ])
    expect(notificationDeliveryClient.acknowledge).toHaveBeenCalledWith('delivery-1', {
      medium: 'telegram',
      providerUserId: '123456',
      providerChannelId: 'telegram-chat-1',
      providerWorkspaceId: null,
      hostRef: 'chatllm',
    })
    expect(notificationDeliveryClient.fail).not.toHaveBeenCalled()
    expect(rpcClient.sendMessage).not.toHaveBeenCalled()
    expect(rpcClient.sendApproval).not.toHaveBeenCalled()
  })

  it('uses approval.updated notifications to clear stale workflow approval cache entries', async () => {
    const replies: string[] = []
    const approvalRequestId = '00000000-0000-0000-0000-000000000222'
    const adapter: ChannelAdapter = {
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
        {
          id: 'delivery-2',
          eventType: 'approval.updated' as const,
          medium: 'telegram' as const,
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'telegram-chat-1',
          attempts: 1,
          payload: {
            approvalRequestId,
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'due-diligence',
            status: 'cancelled' as const,
          },
        },
      ]),
      acknowledge: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    }

    const reader = new ChannelReader({
      rpcClient,
      notificationDeliveryClient,
      adapters: new Map([['telegram', adapter]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    await reader.pollCycle()
    await reader.handleMessages([makeMessage('/approve due-diligence')])

    expect(replies).toEqual([
      'Approve workflow due-diligence?',
      'No pending workflow approval found for due-diligence. Use the workflow name shown in the approval request.',
    ])
    expect(notificationDeliveryClient.acknowledge).toHaveBeenCalledWith('delivery-2', {
      medium: 'telegram',
      providerUserId: '123456',
      providerChannelId: 'telegram-chat-1',
      providerWorkspaceId: null,
      hostRef: 'chatllm',
    })
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
    expect(rpcClient.sendWorkflowApprovalDecision).not.toHaveBeenCalled()
  })

  it('logs when legacy Slack configs cannot claim workflow approval notifications', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const adapter: ChannelAdapter = {
      channelType: 'slack',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(),
      editMessage: vi.fn(),
    }
    const notificationDeliveryClient = {
      fetchDeliveries: vi.fn(async () => []),
      acknowledge: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    }
    const legacySlackChannel: CommunicationChannelCRD = {
      name: 'legacy-slack',
      namespace: 'channels',
      spec: {
        hostRef: 'chatllm',
        slack: [{ channelId: '#general', userNames: ['alice'] }],
      },
    }

    try {
      const reader = new ChannelReader({
        rpcClient: makeRpcClient(),
        notificationDeliveryClient,
        adapters: new Map([['slack', adapter]]),
        channels: [legacySlackChannel],
        sleep: async () => undefined,
      })

      await reader.pollCycle()

      expect(notificationDeliveryClient.fetchDeliveries).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('workspace/tenant id is required for workflow approval delivery')
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})
