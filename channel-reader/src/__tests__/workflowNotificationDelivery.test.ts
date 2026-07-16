import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type {
  ApprovalRequestedNotificationDelivery,
  NotificationDelivery,
  PluginWorkloadSdkNotificationDelivery,
  WorkflowRunCompletedNotificationDelivery,
} from '../notificationDeliveryClient'
import { telegramWorkflowResultCallbackData } from '../telegramCallbackData'
import type { ChannelAdapter, CommunicationChannelCRD } from '../types'
import { WorkflowApprovalCoordinator } from '../workflowApprovalCoordinator'

const WORKFLOW_RUN_ID = '11111111-2222-3333-4444-555555555555'

vi.hoisted(() => {
  process.env.CLERUM_HOST_REF = process.env.CLERUM_HOST_REF ?? 'test-host'
})

function adapter(channelType: 'telegram' | 'slack' | 'teams') {
  const sendMessage = vi.fn(
    async (
      _channelId: string,
      _content: string,
      _replyToMessageId?: string,
      _attachments?: Parameters<ChannelAdapter['sendMessage']>[3],
      _options?: Parameters<ChannelAdapter['sendMessage']>[4]
    ) => 'sent-1'
  )
  return {
    channelType,
    connect: vi.fn(),
    disconnect: vi.fn(),
    fetchMessages: vi.fn(),
    sendMessage,
    editMessage: vi.fn(),
  } satisfies ChannelAdapter
}

function coordinatorFor(params: {
  delivery: NotificationDelivery
  medium: 'telegram' | 'slack' | 'teams'
  adapter: ChannelAdapter
  teamsReplyInThreads?: boolean
}) {
  const notificationDeliveryClient = {
    fetchDeliveries: vi.fn(async () => [params.delivery]),
    acknowledge: vi.fn(),
    fail: vi.fn(),
  }
  const channels: CommunicationChannelCRD[] = [
    {
      name: 'test-channel',
      namespace: 'channels',
      spec: {
        hostRef: 'agent-a',
        telegram:
          params.medium === 'telegram'
            ? [{ channelId: params.delivery.providerChannelId, chatType: 'group' }]
            : [],
        slack:
          params.medium === 'slack'
            ? [
                {
                  channelId: params.delivery.providerChannelId,
                  workspaceId: params.delivery.providerWorkspaceId || 'T123',
                },
              ]
            : [],
        teams:
          params.medium === 'teams'
            ? [
                {
                  channelId: params.delivery.providerChannelId,
                  tenantId: params.delivery.providerWorkspaceId || 'tenant-1',
                  ...(params.teamsReplyInThreads === undefined
                    ? {}
                    : { replyInThreads: params.teamsReplyInThreads }),
                },
              ]
            : [],
      },
    },
  ]
  const coordinator = new WorkflowApprovalCoordinator({
    rpcClient: { sendWorkflowApprovalDecision: vi.fn(), resolveWorkflowApproval: vi.fn() },
    notificationDeliveryClient,
    getAdapters: () => new Map([[params.medium, params.adapter]]),
    getChannels: () => channels,
    sendReply: vi.fn(),
  })
  return { coordinator, notificationDeliveryClient }
}

function completedDelivery(
  overrides: Partial<Omit<WorkflowRunCompletedNotificationDelivery, 'payload'>> & {
    payload?: Partial<WorkflowRunCompletedNotificationDelivery['payload']>
  } = {}
): WorkflowRunCompletedNotificationDelivery {
  const base: WorkflowRunCompletedNotificationDelivery = {
    id: 'delivery-1',
    medium: 'telegram',
    providerUserId: '123456',
    providerChannelId: '-100987',
    attempts: 0,
    eventType: 'workflow.run.completed',
    payload: {
      workflowRunId: WORKFLOW_RUN_ID,
      approvalRequestId: 'approval-1',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'due-diligence-package',
      phase: 'Succeeded',
      providerMedium: 'telegram',
      providerChannelId: '-100987',
      hasDownloadableItems: true,
      message: 'legacy artifact copy should not win',
    },
  }
  return {
    ...base,
    ...overrides,
    payload: {
      ...base.payload,
      ...overrides.payload,
    },
  }
}

function approvalDelivery(
  overrides: Partial<Omit<ApprovalRequestedNotificationDelivery, 'payload'>> & {
    payload?: Partial<ApprovalRequestedNotificationDelivery['payload']>
  } = {}
): ApprovalRequestedNotificationDelivery {
  const base: ApprovalRequestedNotificationDelivery = {
    id: 'approval-delivery-1',
    medium: 'slack',
    providerUserId: 'U123',
    providerWorkspaceId: 'T123',
    providerChannelId: 'C123',
    attempts: 0,
    eventType: 'approval.requested',
    payload: {
      approvalRequestId: '99999999-8888-7777-6666-555555555555',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'due-diligence-package',
      title: 'Approve workflow trigger for due-diligence-package',
      body: 'Approval requested for workflow due-diligence-package.',
    },
  }
  return {
    ...base,
    ...overrides,
    payload: { ...base.payload, ...overrides.payload },
  }
}

function sdkDelivery(
  overrides: Partial<Omit<PluginWorkloadSdkNotificationDelivery, 'payload'>> & {
    payload?: Partial<PluginWorkloadSdkNotificationDelivery['payload']>
  } = {}
): PluginWorkloadSdkNotificationDelivery {
  const base: PluginWorkloadSdkNotificationDelivery = {
    id: 'sdk-delivery-1',
    medium: 'telegram',
    providerUserId: '424242',
    providerChannelId: '424242',
    providerWorkspaceId: null,
    attempts: 1,
    eventType: 'plugin_workload_sdk.notification',
    payload: {
      notificationId: 'invocation-1',
      origin: 'plugin_workload_sdk',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'sdk-recipe',
      callerRef: 'sdk-caller',
      eventType: 'lead.followup.due',
      title: 'Follow up',
      body: 'Lead is due today',
    },
  }
  return {
    ...base,
    ...overrides,
    payload: { ...base.payload, ...overrides.payload },
  }
}

describe('WorkflowApprovalCoordinator — plugin_workload_sdk.notification poll→send→ack (S6)', () => {
  it('formats, sends, and acknowledges an SDK notification on the channel fallback path', async () => {
    const telegram = adapter('telegram')
    const { coordinator, notificationDeliveryClient } = coordinatorFor({
      delivery: sdkDelivery(),
      medium: 'telegram',
      adapter: telegram,
    })

    await coordinator.pollNotifications()

    // Verbatim title/body (formatter contract) — no approval/Desktop copy.
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      '424242',
      'Follow up\nLead is due today',
      undefined,
      undefined,
      undefined
    )
    // The ack that the terminal-service fix now actually matches in the DB.
    expect(notificationDeliveryClient.acknowledge).toHaveBeenCalledWith(
      'sdk-delivery-1',
      expect.objectContaining({
        medium: 'telegram',
        providerUserId: '424242',
        providerChannelId: '424242',
        hostRef: 'agent-a',
      })
    )
    expect(notificationDeliveryClient.fail).not.toHaveBeenCalled()
  })

  it('records a delivery failure (not an ack) when the channel send throws', async () => {
    const telegram = adapter('telegram')
    telegram.sendMessage = vi.fn(async () => {
      throw new Error('telegram send failed')
    })
    const { coordinator, notificationDeliveryClient } = coordinatorFor({
      delivery: sdkDelivery(),
      medium: 'telegram',
      adapter: telegram,
    })

    await coordinator.pollNotifications()

    expect(notificationDeliveryClient.fail).toHaveBeenCalledWith(
      'sdk-delivery-1',
      expect.objectContaining({ medium: 'telegram', hostRef: 'agent-a' })
    )
    expect(notificationDeliveryClient.acknowledge).not.toHaveBeenCalled()
  })
})

describe('WorkflowApprovalCoordinator notification delivery', () => {
  it('renders Slack approve and deny buttons with workflow route and channel alias', async () => {
    const slack = adapter('slack')
    const { coordinator } = coordinatorFor({
      delivery: approvalDelivery(),
      medium: 'slack',
      adapter: slack,
    })
    const channelAlias = createHash('sha256')
      .update('channels/test-channel')
      .digest('hex')
      .slice(0, 16)

    await coordinator.pollNotifications()

    const sendOptions = slack.sendMessage.mock.calls[0]?.[4]
    expect(slack.sendMessage).toHaveBeenCalledWith(
      'C123',
      'Approve workflow due-diligence-package?',
      undefined,
      undefined,
      expect.any(Object)
    )
    expect(sendOptions?.slackBlocks).toEqual([
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Approve workflow due-diligence-package?',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'workflow_approval_approve',
            text: { type: 'plain_text', text: 'Approve' },
            value:
              'approve:99999999-8888-7777-6666-555555555555:' +
              `sandbox-recipes/due-diligence-package:${channelAlias}`,
            style: 'primary',
          },
          {
            type: 'button',
            action_id: 'workflow_approval_deny',
            text: { type: 'plain_text', text: 'Deny' },
            value:
              'deny:99999999-8888-7777-6666-555555555555:' +
              `sandbox-recipes/due-diligence-package:${channelAlias}`,
            style: 'danger',
          },
        ],
      },
    ])
  })

  it('renders Teams approve and deny buttons with workflow route and channel alias', async () => {
    const teams = adapter('teams')
    const { coordinator } = coordinatorFor({
      delivery: approvalDelivery({
        medium: 'teams',
        providerUserId: 'teams-user-1',
        providerWorkspaceId: 'tenant-1',
        providerChannelId: '19:channel-1@thread.tacv2',
        payload: {
          ...approvalDelivery().payload,
        },
      }),
      medium: 'teams',
      adapter: teams,
    })
    const channelAlias = createHash('sha256')
      .update('channels/test-channel')
      .digest('hex')
      .slice(0, 16)

    await coordinator.pollNotifications()

    const sendOptions = teams.sendMessage.mock.calls[0]?.[4]
    expect(teams.sendMessage).toHaveBeenCalledWith(
      '19:channel-1@thread.tacv2',
      'Approve workflow due-diligence-package?',
      undefined,
      undefined,
      expect.any(Object)
    )
    expect(sendOptions?.teamsActions).toEqual([
      {
        title: 'Approve',
        value:
          'approve:99999999-8888-7777-6666-555555555555:' +
          `sandbox-recipes/due-diligence-package:${channelAlias}`,
        style: 'positive',
      },
      {
        title: 'Deny',
        value:
          'deny:99999999-8888-7777-6666-555555555555:' +
          `sandbox-recipes/due-diligence-package:${channelAlias}`,
        style: 'destructive',
      },
    ])
  })

  it('delivers Teams workflow approvals in the source thread by default', async () => {
    const teams = adapter('teams')
    const conversationId = '19:channel-1@thread.tacv2;messageid=root-post-1'
    const { coordinator } = coordinatorFor({
      delivery: approvalDelivery({
        medium: 'teams',
        providerUserId: 'teams-user-1',
        providerWorkspaceId: 'tenant-1',
        providerChannelId: '19:channel-1@thread.tacv2',
        payload: {
          metadata: {
            workflowTrigger: {
              conversationId,
              providerBinding: {
                medium: 'teams',
                providerChannelId: '19:channel-1@thread.tacv2',
                providerWorkspaceId: 'tenant-1',
                providerThreadId: 'root-post-1',
              },
            },
          },
        },
      }),
      medium: 'teams',
      adapter: teams,
    })

    await coordinator.pollNotifications()

    expect(teams.sendMessage).toHaveBeenCalledWith(
      conversationId,
      expect.any(String),
      'root-post-1',
      undefined,
      expect.any(Object)
    )
  })

  it('posts Teams workflow approvals at the root when thread replies are disabled', async () => {
    const teams = adapter('teams')
    const providerChannelId = '19:channel-1@thread.tacv2'
    const { coordinator } = coordinatorFor({
      delivery: approvalDelivery({
        medium: 'teams',
        providerUserId: 'teams-user-1',
        providerWorkspaceId: 'tenant-1',
        providerChannelId,
        payload: {
          metadata: {
            workflowTrigger: {
              conversationId: `${providerChannelId};messageid=root-post-1`,
              providerBinding: {
                medium: 'teams',
                providerChannelId,
                providerWorkspaceId: 'tenant-1',
                providerThreadId: 'root-post-1',
              },
            },
          },
        },
      }),
      medium: 'teams',
      adapter: teams,
      teamsReplyInThreads: false,
    })

    await coordinator.pollNotifications()

    expect(teams.sendMessage).toHaveBeenCalledWith(
      providerChannelId,
      expect.any(String),
      undefined,
      undefined,
      expect.any(Object)
    )
  })

  it('routes notifications through the adapter for the owning CommunicationChannel', async () => {
    const fallback = adapter('telegram')
    const first = adapter('telegram')
    const second = adapter('telegram')
    const delivery = sdkDelivery({ providerChannelId: 'chat-b' })
    const notificationDeliveryClient = {
      fetchDeliveries: vi.fn(async (params: { providerChannelIds: string[] }) =>
        params.providerChannelIds.includes('chat-b') ? [delivery] : []
      ),
      acknowledge: vi.fn(),
      fail: vi.fn(),
    }
    const channels: CommunicationChannelCRD[] = [
      {
        name: 'cc-first',
        namespace: 'channels',
        spec: {
          hostRef: 'agent-a',
          telegram: [{ channelId: 'chat-a', chatType: 'private' }],
        },
      },
      {
        name: 'cc-second',
        namespace: 'channels',
        spec: {
          hostRef: 'agent-a',
          telegram: [{ channelId: 'chat-b', chatType: 'private' }],
        },
      },
    ]
    const coordinator = new WorkflowApprovalCoordinator({
      rpcClient: { sendWorkflowApprovalDecision: vi.fn(), resolveWorkflowApproval: vi.fn() },
      notificationDeliveryClient,
      getAdapters: () => new Map([['telegram', fallback]]),
      getAdapterForChannel: (_medium, channelRef) =>
        channelRef.name === 'cc-first'
          ? first
          : channelRef.name === 'cc-second'
            ? second
            : undefined,
      getChannels: () => channels,
      sendReply: vi.fn(),
    })

    await coordinator.pollNotifications()

    expect(second.sendMessage).toHaveBeenCalledWith(
      'chat-b',
      'Follow up\nLead is due today',
      undefined,
      undefined,
      undefined
    )
    expect(first.sendMessage).not.toHaveBeenCalled()
    expect(fallback.sendMessage).not.toHaveBeenCalled()
  })

  it('mentions the verified Telegram actor in shared chats with safe HTML', async () => {
    const telegram = adapter('telegram')
    const { coordinator, notificationDeliveryClient } = coordinatorFor({
      delivery: completedDelivery(),
      medium: 'telegram',
      adapter: telegram,
    })

    await coordinator.pollNotifications()

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      '-100987',
      '<a href="tg://user?id=123456">User</a> Workflow due-diligence-package completed. Results are ready for the verified user.',
      undefined,
      undefined,
      {
        parseMode: 'telegram-html',
        telegramInlineKeyboard: [
          [
            {
              text: 'Download result',
              callbackData: telegramWorkflowResultCallbackData(WORKFLOW_RUN_ID),
            },
          ],
        ],
      }
    )
    expect(String(telegram.sendMessage.mock.calls[0]?.[1] || '')).not.toContain('Desktop')
    expect(String(telegram.sendMessage.mock.calls[0]?.[1] || '')).not.toContain(
      'receive the artifact'
    )
    expect(notificationDeliveryClient.acknowledge).toHaveBeenCalledWith(
      'delivery-1',
      expect.objectContaining({
        providerUserId: '123456',
        providerChannelId: '-100987',
        hostRef: 'agent-a',
      })
    )
    expect(notificationDeliveryClient.fail).not.toHaveBeenCalled()
  })

  it('does not mention Telegram private chats', async () => {
    const telegram = adapter('telegram')
    const { coordinator } = coordinatorFor({
      delivery: completedDelivery({
        providerUserId: '123456',
        providerChannelId: '123456',
        payload: {
          ...completedDelivery().payload,
          providerChannelId: '123456',
        },
      }),
      medium: 'telegram',
      adapter: telegram,
    })

    await coordinator.pollNotifications()

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      '123456',
      'Workflow due-diligence-package completed. Results are ready.',
      undefined,
      undefined,
      {
        telegramInlineKeyboard: [
          [
            {
              text: 'Download result',
              callbackData: telegramWorkflowResultCallbackData(WORKFLOW_RUN_ID),
            },
          ],
        ],
      }
    )
  })

  it('keeps Telegram result buttons independent of recipe-name length', async () => {
    const telegram = adapter('telegram')
    const longRecipeName = 'due-diligence-' + 'x'.repeat(60)
    const { coordinator } = coordinatorFor({
      delivery: completedDelivery({
        payload: {
          ...completedDelivery().payload,
          recipeName: longRecipeName,
        },
      }),
      medium: 'telegram',
      adapter: telegram,
    })

    await coordinator.pollNotifications()

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      '-100987',
      '<a href="tg://user?id=123456">User</a> Workflow ' +
        longRecipeName +
        ' completed. Results are ready for the verified user.',
      undefined,
      undefined,
      {
        parseMode: 'telegram-html',
        telegramInlineKeyboard: [
          [
            {
              text: 'Download result',
              callbackData: telegramWorkflowResultCallbackData(WORKFLOW_RUN_ID),
            },
          ],
        ],
      }
    )
  })

  it('mentions Slack users in shared channels without Desktop copy', async () => {
    const slack = adapter('slack')
    const { coordinator } = coordinatorFor({
      delivery: completedDelivery({
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
        payload: {
          ...completedDelivery().payload,
          providerMedium: 'slack',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
        },
      }),
      medium: 'slack',
      adapter: slack,
    })

    await coordinator.pollNotifications()

    expect(slack.sendMessage).toHaveBeenCalledWith(
      'C123',
      '<@U123> Workflow due-diligence-package completed. Results are ready for the verified user.',
      undefined,
      undefined,
      {
        slackBlocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '<@U123> Workflow due-diligence-package completed. Results are ready for the verified user.',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: 'workflow_result_download',
                text: { type: 'plain_text', text: 'Download result' },
                value: `workflow_result_run:${WORKFLOW_RUN_ID}`,
              },
            ],
          },
        ],
      }
    )
  })

  it('renders Teams workflow result download buttons', async () => {
    const teams = adapter('teams')
    const conversationId = '19:channel-1@thread.tacv2;messageid=root-post-1'
    const { coordinator } = coordinatorFor({
      delivery: completedDelivery({
        medium: 'teams',
        providerUserId: 'teams-user-1',
        providerWorkspaceId: 'tenant-1',
        providerChannelId: '19:channel-1@thread.tacv2',
        payload: {
          ...completedDelivery().payload,
          providerMedium: 'teams',
          providerWorkspaceId: 'tenant-1',
          providerChannelId: '19:channel-1@thread.tacv2',
          providerConversationId: conversationId,
          providerThreadId: 'root-post-1',
        },
      }),
      medium: 'teams',
      adapter: teams,
    })

    await coordinator.pollNotifications()

    expect(teams.sendMessage).toHaveBeenCalledWith(
      conversationId,
      'Verified user Workflow due-diligence-package completed. Results are ready for the verified user.',
      'root-post-1',
      undefined,
      {
        teamsActions: [
          { title: 'Download result', value: `workflow_result_run:${WORKFLOW_RUN_ID}` },
        ],
      }
    )
  })

  it('omits Teams workflow result download buttons when completion has no downloadable items', async () => {
    const teams = adapter('teams')
    const conversationId = '19:channel-1@thread.tacv2;messageid=root-post-1'
    const { coordinator } = coordinatorFor({
      delivery: completedDelivery({
        medium: 'teams',
        providerUserId: 'teams-user-1',
        providerWorkspaceId: 'tenant-1',
        providerChannelId: '19:channel-1@thread.tacv2',
        payload: {
          ...completedDelivery().payload,
          providerMedium: 'teams',
          providerWorkspaceId: 'tenant-1',
          providerChannelId: '19:channel-1@thread.tacv2',
          providerConversationId: conversationId,
          providerThreadId: 'root-post-1',
          hasDownloadableItems: false,
        },
      }),
      medium: 'teams',
      adapter: teams,
    })

    await coordinator.pollNotifications()

    expect(teams.sendMessage).toHaveBeenCalledWith(
      conversationId,
      'Verified user Workflow due-diligence-package completed.',
      'root-post-1',
      undefined,
      undefined
    )
  })

  it('does not render malformed Slack provider user ids as mentions', async () => {
    const slack = adapter('slack')
    const { coordinator } = coordinatorFor({
      delivery: completedDelivery({
        medium: 'slack',
        providerUserId: '<!channel>',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
        payload: {
          ...completedDelivery().payload,
          providerMedium: 'slack',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
        },
      }),
      medium: 'slack',
      adapter: slack,
    })

    await coordinator.pollNotifications()

    const content = String(slack.sendMessage.mock.calls[0]?.[1] || '')
    expect(content).toContain(
      'Verified user Workflow due-diligence-package completed. Results are ready for the verified user.'
    )
    expect(content).not.toContain('<!channel>')
    expect(content).not.toContain('<@')
  })
})
