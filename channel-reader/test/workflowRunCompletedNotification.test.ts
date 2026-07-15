import { beforeAll, describe, expect, it, vi } from 'vitest'
import { telegramWorkflowResultCallbackData } from '../src/telegramCallbackData'
import type { ChannelAdapter, CommunicationChannelCRD, Message } from '../src/types'
import type { WorkflowApprovalDecisionCommand } from '../src/workflowApprovalDecision'

let WorkflowApprovalCoordinator: typeof import('../src/workflowApprovalCoordinator').WorkflowApprovalCoordinator

beforeAll(async () => {
  process.env.CLERUM_DEV_MODE = 'true'
  ;({ WorkflowApprovalCoordinator } = await import('../src/workflowApprovalCoordinator'))
})

function telegramChannel(): CommunicationChannelCRD {
  return {
    name: 'telegram',
    namespace: 'channels',
    spec: {
      hostRef: 'chatllm',
      telegram: [{ channelId: 'telegram-chat-1', userIds: ['123456'] }],
    },
  }
}

function message(content: string): Message {
  return {
    channelType: 'telegram',
    channelId: 'telegram-chat-1',
    sender: '123456',
    content,
    timestamp: new Date('2026-06-01T00:00:00.000Z'),
    messageId: 'msg-1',
  }
}

function adapter(channelType: 'telegram' | 'slack'): ChannelAdapter {
  return {
    channelType,
    connect: vi.fn(),
    disconnect: vi.fn(),
    fetchMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => 'sent-1'),
    editMessage: vi.fn(),
  }
}

describe('workflow.run.completed notification delivery', () => {
  it('sends Telegram completion text without creating pending approval state', async () => {
    const workflowRunId = '11111111-2222-4333-8444-555555555555'
    const telegram = adapter('telegram')
    const sendReply = vi.fn(async () => undefined)
    const rpcClient = {
      sendWorkflowApprovalDecision: vi.fn(),
      resolveWorkflowApproval: vi.fn(async () => null),
    }
    const notificationDeliveryClient = {
      fetchDeliveries: vi.fn(async () => [
        {
          id: 'delivery-1',
          eventType: 'workflow.run.completed' as const,
          medium: 'telegram' as const,
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'telegram-chat-1',
          attempts: 1,
          payload: {
            workflowRunId,
            approvalRequestId: 'approval-1',
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'due-diligence',
            phase: 'Succeeded' as const,
            providerMedium: 'telegram' as const,
            providerChannelId: 'telegram-chat-1',
            providerWorkspaceId: null,
            hasDownloadableItems: true,
            message: 'Workflow due-diligence completed. Results are ready.',
          },
        },
      ]),
      acknowledge: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    }
    const coordinator = new WorkflowApprovalCoordinator({
      rpcClient,
      notificationDeliveryClient,
      getAdapters: () => new Map([['telegram', telegram]]),
      getChannels: () => [telegramChannel()],
      sendReply,
    })

    await coordinator.pollNotifications()

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      'telegram-chat-1',
      '<a href="tg://user?id=123456">User</a> Workflow due-diligence completed. Results are ready for the verified user.',
      undefined,
      undefined,
      {
        parseMode: 'telegram-html',
        telegramInlineKeyboard: [
          [
            {
              text: 'Download result',
              callbackData: telegramWorkflowResultCallbackData(workflowRunId),
            },
          ],
        ],
      }
    )
    expect(notificationDeliveryClient.acknowledge).toHaveBeenCalledWith('delivery-1', {
      medium: 'telegram',
      providerUserId: '123456',
      providerChannelId: 'telegram-chat-1',
      providerWorkspaceId: null,
      hostRef: 'chatllm',
    })
    expect(notificationDeliveryClient.fail).not.toHaveBeenCalled()

    const command: WorkflowApprovalDecisionCommand = {
      recipeName: 'due-diligence',
      decision: 'approve',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'telegram-chat-1',
        providerEventId: 'telegram:telegram-chat-1:msg-1',
      },
    }
    await coordinator.handleDecisionCommand(message('/approve due-diligence'), command)
    expect(rpcClient.sendWorkflowApprovalDecision).not.toHaveBeenCalled()
    expect(sendReply).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('No pending workflow approval found')
    )
  })

  it('claims and acknowledges Slack completion through the workspace binding', async () => {
    const slack = adapter('slack')
    const notificationDeliveryClient = {
      fetchDeliveries: vi.fn(async () => [
        {
          id: 'delivery-2',
          eventType: 'workflow.run.completed' as const,
          medium: 'slack' as const,
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
          attempts: 1,
          payload: {
            workflowRunId: 'run-2',
            approvalRequestId: 'approval-2',
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'due-diligence',
            phase: 'Failed' as const,
            providerMedium: 'slack' as const,
            providerChannelId: 'C123',
            providerWorkspaceId: 'T123',
          },
        },
      ]),
      acknowledge: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    }
    const coordinator = new WorkflowApprovalCoordinator({
      rpcClient: { sendWorkflowApprovalDecision: vi.fn() },
      notificationDeliveryClient,
      getAdapters: () => new Map([['slack', slack]]),
      getChannels: () => [
        {
          name: 'slack',
          namespace: 'channels',
          spec: {
            hostRef: 'chatllm',
            slack: [{ channelId: 'C123', workspaceId: 'T123', userIds: ['U123'] }],
          },
        },
      ],
      sendReply: vi.fn(),
    })

    await coordinator.pollNotifications()

    expect(notificationDeliveryClient.fetchDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({ medium: 'slack', providerWorkspaceId: 'T123' })
    )
    expect(slack.sendMessage).toHaveBeenCalledWith(
      'C123',
      '<@U123> Workflow due-diligence finished with status Failed.',
      undefined,
      undefined,
      undefined
    )
    expect(notificationDeliveryClient.acknowledge).toHaveBeenCalledWith('delivery-2', {
      medium: 'slack',
      providerUserId: 'U123',
      providerChannelId: 'C123',
      providerWorkspaceId: 'T123',
      hostRef: 'chatllm',
    })
  })

  it('marks workflow.run.completed delivery failed when channel send fails', async () => {
    const telegram = adapter('telegram')
    vi.mocked(telegram.sendMessage).mockRejectedValueOnce(new Error('telegram unavailable'))
    const notificationDeliveryClient = {
      fetchDeliveries: vi.fn(async () => [
        {
          id: 'delivery-3',
          eventType: 'workflow.run.completed' as const,
          medium: 'telegram' as const,
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'telegram-chat-1',
          attempts: 1,
          payload: {
            workflowRunId: 'run-3',
            approvalRequestId: 'approval-3',
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'due-diligence',
            phase: 'Canceled' as const,
            providerMedium: 'telegram' as const,
            providerChannelId: 'telegram-chat-1',
            providerWorkspaceId: null,
          },
        },
      ]),
      acknowledge: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    }
    const coordinator = new WorkflowApprovalCoordinator({
      rpcClient: { sendWorkflowApprovalDecision: vi.fn() },
      notificationDeliveryClient,
      getAdapters: () => new Map([['telegram', telegram]]),
      getChannels: () => [telegramChannel()],
      sendReply: vi.fn(),
    })

    await coordinator.pollNotifications()

    expect(notificationDeliveryClient.acknowledge).not.toHaveBeenCalled()
    expect(notificationDeliveryClient.fail).toHaveBeenCalledWith('delivery-3', {
      medium: 'telegram',
      providerUserId: '123456',
      providerChannelId: 'telegram-chat-1',
      providerWorkspaceId: null,
      hostRef: 'chatllm',
    })
  })
})
