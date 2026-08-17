import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamsAdapter } from '../channels/teams'
import type { TeamsMessageHandoff } from '../handoffServer'
import { ChannelReader, type ChannelReaderOptions } from '../main'
import { createProgressStream } from '../progressClient'
import type { MessageResponse } from '../rpcClient'
import type { ChannelAdapter, Message } from '../types'

vi.mock('../progressClient', () => ({
  createProgressStream: vi.fn(),
}))

vi.hoisted(() => {
  process.env.CLERUM_HOST_REF = process.env.CLERUM_HOST_REF ?? 'test-host'
})

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(createProgressStream).mockReset()
})

const completedResponse: MessageResponse = {
  success: true,
  status: 'completed',
  response: 'ok',
}

function rpcClient(): NonNullable<ChannelReaderOptions['rpcClient']> {
  return {
    healthCheck: vi.fn(async () => true),
    sendMessage: vi.fn(async () => completedResponse),
    getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
    getTaskResult: vi.fn(async () => completedResponse),
    sendApproval: vi.fn(async () => ({ success: true })),
    sendDenial: vi.fn(async () => ({ success: true })),
    sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
    resolveWorkflowApproval: vi.fn(async () => null),
    fetchDeliveries: vi.fn(async () => []),
    acknowledge: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    confirmTelegramChallenge: vi.fn(async () => ({
      ok: true as const,
      accountId: 'account-1',
      userEmail: 'user@example.com',
    })),
    getCronResults: vi.fn(async () => []),
    acknowledgeCronResult: vi.fn(async () => undefined),
  }
}

function telegramMessage(overrides: Partial<Message> = {}): Message {
  return {
    channelType: 'telegram',
    channelId: '424242',
    sender: '123456',
    content: 'list workflows',
    timestamp: new Date('2026-05-28T10:00:00.000Z'),
    messageId: '9001',
    providerIdentity: {
      medium: 'telegram',
      providerUserId: '123456',
      providerChannelId: '424242',
      providerEventId: 'telegram:424242:9001',
    },
    ...overrides,
  }
}

describe('ChannelReader provider event idempotency', () => {
  it('does not forward a provider message when current access is denied', async () => {
    const rpc = rpcClient()
    rpc.authorizeProviderMessage = vi.fn(async () => ({ authorized: false }))
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map(),
    })

    await reader.handleMessages([telegramMessage()])

    expect(rpc.authorizeProviderMessage).toHaveBeenCalledOnce()
    expect(rpc.sendMessage).not.toHaveBeenCalled()
  })

  it('records denied provider events so duplicate redelivery does not reauthorize', async () => {
    const rpc = rpcClient()
    rpc.authorizeProviderMessage = vi
      .fn()
      .mockResolvedValueOnce({ authorized: false })
      .mockResolvedValueOnce({ authorized: true })
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map(),
    })

    const denied = telegramMessage()
    const deniedDuplicate = telegramMessage({
      messageId: '9001-redelivered',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: '424242',
        providerEventId: 'telegram:424242:9001',
      },
    })
    const allowed = telegramMessage({
      messageId: '9002',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: '424242',
        providerEventId: 'telegram:424242:9002',
      },
    })

    await reader.handleMessages([denied, deniedDuplicate, allowed])

    expect(rpc.authorizeProviderMessage).toHaveBeenCalledTimes(2)
    expect(rpc.authorizeProviderMessage).toHaveBeenNthCalledWith(1, denied.providerIdentity)
    expect(rpc.authorizeProviderMessage).toHaveBeenNthCalledWith(2, allowed.providerIdentity)
    expect(rpc.sendMessage).toHaveBeenCalledOnce()
    expect(rpc.sendMessage).toHaveBeenCalledWith(
      allowed,
      expect.objectContaining({
        traceContext: expect.objectContaining({ origin: 'channel_event' }),
      })
    )
  })

  it('forwards a redelivered provider event to mcp-host only once', async () => {
    const rpc = rpcClient()
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map(),
    })

    const first = telegramMessage()
    const duplicate = telegramMessage({
      messageId: '9001-redelivered',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: '424242',
        providerEventId: 'telegram:424242:9001',
      },
    })

    await reader.handleMessages([first, duplicate])

    expect(rpc.sendMessage).toHaveBeenCalledTimes(1)
    expect(rpc.sendMessage).toHaveBeenCalledWith(
      first,
      expect.objectContaining({
        traceContext: expect.objectContaining({ origin: 'channel_event' }),
      })
    )
  })

  it('falls back to channel message identity when provider event id is absent', async () => {
    const rpc = rpcClient()
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map(),
    })
    const first = telegramMessage({ providerIdentity: undefined })
    const duplicate = telegramMessage({ providerIdentity: undefined })

    await reader.handleMessages([first, duplicate])

    expect(rpc.sendMessage).toHaveBeenCalledTimes(1)
  })
})

describe('ChannelReader bot mention normalization', () => {
  it('strips an addressed Telegram bot mention before forwarding to mcp-host', async () => {
    const rpc = rpcClient()
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map(),
    })

    await reader.handleMessages([
      telegramMessage({
        content: '@evenfire_test_bot download result',
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: '424242',
          providerEventId: 'telegram:424242:9002',
          providerTarget: {
            hostRef: 'agent-a',
            communicationChannelNamespace: 'channels',
            communicationChannelName: 'agent-a-telegram',
            providerBotUsername: 'evenfire_test_bot',
          },
        },
      }),
    ])

    expect(rpc.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'download result' }),
      expect.objectContaining({
        traceContext: expect.objectContaining({ origin: 'channel_event' }),
      })
    )
  })

  it('keeps a leading Telegram mention for a different bot', async () => {
    const rpc = rpcClient()
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map(),
    })

    await reader.handleMessages([
      telegramMessage({
        content: '@other_bot download result',
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: '424242',
          providerEventId: 'telegram:424242:9003',
          providerTarget: {
            hostRef: 'agent-a',
            communicationChannelNamespace: 'channels',
            communicationChannelName: 'agent-a-telegram',
            providerBotUsername: 'evenfire_test_bot',
          },
        },
      }),
    ])

    expect(rpc.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '@other_bot download result' }),
      expect.objectContaining({
        traceContext: expect.objectContaining({ origin: 'channel_event' }),
      })
    )
  })
})

describe('ChannelReader Telegram polling', () => {
  function telegramAdapter() {
    const adapter: ChannelAdapter = {
      channelType: 'telegram' as const,
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      fetchMessages: vi.fn<ChannelAdapter['fetchMessages']>(async () => []),
      sendMessage: vi.fn(async () => undefined),
      editMessage: vi.fn(async () => undefined),
    }
    return adapter
  }

  it('polls duplicate Telegram group rows as one operational conversation', async () => {
    const rpc = rpcClient()
    const adapter = telegramAdapter()
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['telegram', adapter as never]]),
      channels: [
        {
          name: 'agent-a-telegram',
          namespace: 'channels',
          spec: {
            hostRef: 'agent-a',
            telegramSettings: { replyOnlyWhenMentioned: true },
            telegram: [
              {
                channelId: 'group-777',
                chatType: 'group',
                confirmedByUserId: 'user-1',
              },
              {
                channelId: 'group-777',
                chatType: 'group',
                userIds: ['telegram-user-2'],
              },
            ],
          },
        },
      ],
    })

    await reader.pollCycle()

    expect(adapter.fetchMessages).toHaveBeenCalledTimes(1)
    const fetchMessages = vi.mocked(adapter.fetchMessages)
    const [channelId, allowedSenders, options] = fetchMessages.mock.calls[0]!
    expect(channelId).toBe('group-777')
    expect([...allowedSenders]).toEqual(['telegram-user-2'])
    expect(options).toMatchObject({
      allowUnlistedSender: true,
      replyOnlyWhenMentioned: true,
      telegramChatType: 'group',
      providerTarget: {
        hostRef: 'agent-a',
        communicationChannelNamespace: 'channels',
        communicationChannelName: 'agent-a-telegram',
      },
    })
  })
})

describe('ChannelReader Slack polling', () => {
  function slackAdapter() {
    const adapter: ChannelAdapter = {
      channelType: 'slack' as const,
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      fetchMessages: vi.fn<ChannelAdapter['fetchMessages']>(async () => []),
      sendMessage: vi.fn(async () => undefined),
      editMessage: vi.fn(async () => undefined),
    }
    return adapter
  }

  it('does not poll Slack CRDs because Slack app messages arrive through webhooks', async () => {
    const rpc = rpcClient()
    const adapter = slackAdapter()
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['slack', adapter as never]]),
      channels: [
        {
          name: 'agent-a-slack',
          namespace: 'channels',
          spec: {
            hostRef: 'agent-a',
            slackSettings: {
              workspaceId: 'T123',
              replyOnlyWhenMentioned: false,
              replyInThreads: false,
            },
            slack: [
              {
                channelId: 'C123',
                workspaceId: 'T123',
                userIds: ['U123'],
              },
            ],
          },
        },
      ],
    })

    await reader.pollCycle()

    expect(adapter.fetchMessages).not.toHaveBeenCalled()
    expect(rpc.sendMessage).not.toHaveBeenCalled()
  })
})

describe('ChannelReader Teams handoff', () => {
  it('uses the thread for replies and the stable Teams channel for authorization', () => {
    const reader = new ChannelReader({
      rpcClient: rpcClient(),
      notificationDeliveryClient: null,
      adapters: new Map(),
    })
    const handoff: TeamsMessageHandoff = {
      kind: 'teams.message',
      content: 'hello',
      providerUserId: 'teams-user-1',
      providerWorkspaceId: 'tenant-1',
      providerChannelId: '19:channel-1@thread.tacv2',
      providerConversationId: '19:channel-1@thread.tacv2;messageid=post-1',
      providerReplyToMessageId: 'post-1',
      providerChannelType: 'channel',
      providerEventId: 'teams:tenant-1:post-1:activity-1',
      providerMessageId: 'activity-1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      providerTarget: {
        hostRef: 'chatllm',
        communicationChannelNamespace: 'channels',
        communicationChannelName: 'teams-channel',
      },
    }
    const message = (
      reader as unknown as {
        teamsMessageFromHandoff: (input: TeamsMessageHandoff) => Message | null
      }
    ).teamsMessageFromHandoff(handoff)

    expect(message?.channelId).toBe('19:channel-1@thread.tacv2;messageid=post-1')
    expect(message?.threadId).toBe('post-1')
    expect(message?.providerIdentity?.providerChannelId).toBe('19:channel-1@thread.tacv2')
  })

  it('turns an exact-run Teams download action into a personal-chat file consent card', async () => {
    const workflowRunId = '11111111-2222-4333-8444-555555555555'
    const rpc = rpcClient()
    rpc.downloadWorkflowResultByRun = vi.fn(
      async (): Promise<MessageResponse> => ({
        success: true,
        status: 'completed',
        response: 'Result ready.',
        attachments: [
          {
            id: 'artifact-1',
            kind: 'file',
            mimeType: 'application/pdf',
            encoding: 'base64',
            dataBase64: Buffer.from('pdf bytes').toString('base64'),
            filename: 'result.pdf',
            sourceTool: 'workflow_result',
          },
        ],
      })
    )
    const adapter = new TeamsAdapter()
    const sendFileConsent = vi.spyOn(adapter, 'sendFileConsent').mockResolvedValue('consent-1')
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['teams:test', adapter]]),
    })
    ;(
      reader as unknown as {
        adapterKeysByCommunicationChannel: Map<string, string>
      }
    ).adapterKeysByCommunicationChannel.set('teams:channels/teams-channel', 'teams:test')

    const response = await reader.handleTeamsHandoff({
      kind: 'teams.message',
      content: 'Download the completed workflow result',
      workflowRunId,
      providerUserId: 'teams-user-1',
      providerWorkspaceId: 'tenant-1',
      providerChannelId: 'personal-conversation-1',
      providerConversationId: 'personal-conversation-1',
      providerReplyToMessageId: 'completion-card-1',
      providerChannelType: 'personal',
      providerEventId: 'teams:tenant-1:personal-conversation-1:activity-1',
      providerMessageId: 'activity-1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      providerTarget: {
        hostRef: 'chatllm',
        communicationChannelNamespace: 'channels',
        communicationChannelName: 'teams-channel',
      },
    })

    expect(response).toEqual({ ok: true })
    expect(rpc.downloadWorkflowResultByRun).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: 'teams', channelId: 'personal-conversation-1' }),
      workflowRunId
    )
    expect(sendFileConsent).toHaveBeenCalledWith(
      'personal-conversation-1',
      expect.objectContaining({ filename: 'result.pdf' }),
      { workflowRunId, artifactName: 'result.pdf' },
      'completion-card-1'
    )
  })

  it('uploads the exact artifact after Teams file consent is accepted', async () => {
    const workflowRunId = '11111111-2222-4333-8444-555555555555'
    const rpc = rpcClient()
    rpc.downloadWorkflowResultByRun = vi.fn(
      async (): Promise<MessageResponse> => ({
        success: true,
        status: 'completed',
        response: 'Result ready.',
        attachments: [
          {
            id: 'artifact-1',
            kind: 'file',
            mimeType: 'application/pdf',
            encoding: 'base64',
            dataBase64: Buffer.from('pdf bytes').toString('base64'),
            filename: 'result.pdf',
            sourceTool: 'workflow_result',
          },
        ],
      })
    )
    const adapter = new TeamsAdapter()
    const uploadConsentedFile = vi
      .spyOn(adapter, 'uploadConsentedFile')
      .mockResolvedValue('file-card-1')
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['teams:test', adapter]]),
    })
    ;(
      reader as unknown as {
        adapterKeysByCommunicationChannel: Map<string, string>
      }
    ).adapterKeysByCommunicationChannel.set('teams:channels/teams-channel', 'teams:test')

    const response = await reader.handleTeamsHandoff({
      kind: 'teams.file-consent',
      action: 'accept',
      workflowRunId,
      artifactName: 'result.pdf',
      providerUserId: 'teams-user-1',
      providerWorkspaceId: 'tenant-1',
      providerChannelId: 'personal-conversation-1',
      providerConversationId: 'personal-conversation-1',
      providerReplyToMessageId: 'completion-card-1',
      providerChannelType: 'personal',
      providerEventId: 'teams:tenant-1:personal-conversation-1:consent-1',
      providerMessageId: 'consent-1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      uploadInfo: {
        contentUrl: 'https://tenant.sharepoint.com/result.pdf',
        uploadUrl: 'https://tenant.sharepoint.com/upload/session',
        uniqueId: 'file-1',
        name: 'result.pdf',
        fileType: 'pdf',
      },
      providerTarget: {
        hostRef: 'chatllm',
        communicationChannelNamespace: 'channels',
        communicationChannelName: 'teams-channel',
      },
    })

    expect(response).toEqual({ ok: true })
    expect(rpc.downloadWorkflowResultByRun).toHaveBeenCalledWith(
      expect.any(Object),
      workflowRunId,
      'result.pdf'
    )
    expect(uploadConsentedFile).toHaveBeenCalledWith(
      'personal-conversation-1',
      expect.objectContaining({ filename: 'result.pdf' }),
      expect.objectContaining({ uniqueId: 'file-1' }),
      'completion-card-1'
    )
  })

  it('posts Teams replies at the conversation root when thread replies are disabled', async () => {
    const sendMessage = vi.fn(async () => 'teams-reply-1')
    const adapter: ChannelAdapter = {
      channelType: 'teams',
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      fetchMessages: vi.fn(async () => []),
      sendMessage,
      editMessage: vi.fn(async () => undefined),
    }
    const reader = new ChannelReader({
      rpcClient: rpcClient(),
      notificationDeliveryClient: null,
      adapters: new Map([['teams', adapter]]),
      channels: [
        {
          name: 'teams-channel',
          namespace: 'channels',
          spec: {
            hostRef: 'chatllm',
            teams: [
              {
                channelId: '19:channel-1@thread.tacv2',
                tenantId: 'tenant-1',
                replyInThreads: false,
              },
            ],
          },
        },
      ],
    })
    const message: Message = {
      channelType: 'teams',
      channelId: '19:channel-1@thread.tacv2;messageid=post-1',
      sender: 'teams-user-1',
      content: 'hello',
      timestamp: new Date(),
      messageId: 'activity-1',
      threadId: 'post-1',
      providerIdentity: {
        medium: 'teams',
        providerUserId: 'teams-user-1',
        providerWorkspaceId: 'tenant-1',
        providerChannelId: '19:channel-1@thread.tacv2',
        providerEventId: 'teams:tenant-1:conversation-1:activity-1',
        providerTarget: {
          hostRef: 'chatllm',
          communicationChannelNamespace: 'channels',
          communicationChannelName: 'teams-channel',
        },
      },
    }

    await reader.sendReply(message, 'Root response')

    expect(sendMessage).toHaveBeenCalledWith(
      '19:channel-1@thread.tacv2',
      'Root response',
      undefined,
      undefined,
      undefined
    )
  })

  it('remembers the Teams service URL again after confirmation before sending a reply', async () => {
    const rpc = rpcClient()
    rpc.confirmTeamsLinkSession = vi.fn(async () => ({
      ok: true as const,
      account: {
        userId: 'user-1',
        providerUserId: 'teams-user-1',
        providerWorkspaceId: '21e08d37-8d53-4144-87cb-557b8298aed3',
        providerChannelId: 'teams-channel-1',
      },
    }))
    const rememberConversation = vi.spyOn(TeamsAdapter.prototype, 'rememberConversation')
    const verifyCredentials = vi
      .spyOn(TeamsAdapter.prototype, 'verifyCredentials')
      .mockResolvedValue(undefined)
    const sendMessage = vi.spyOn(TeamsAdapter.prototype, 'sendMessage').mockResolvedValue(undefined)

    try {
      const reader = new ChannelReader({
        rpcClient: rpc,
        notificationDeliveryClient: null,
        channels: [
          {
            name: 'teams-channel',
            namespace: 'channels',
            spec: {
              hostRef: 'chatllm',
              credentialsSecretRef: { name: 'cc-teams-channel-credentials' },
              teams: [],
              teamsSettings: {
                appId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
                tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
                appName: 'evenfire',
                replyOnlyWhenMentioned: true,
              },
            },
          },
        ],
        credentialsResolver: {
          resolve: vi.fn(async () => ({ teamsAppPassword: 'client-secret' })),
        },
      })
      await reader.initializeAdapters()

      const response = await reader.handleTeamsHandoff({
        kind: 'teams.enrollment',
        nonce: '400479',
        providerUserId: 'teams-user-1',
        providerWorkspaceId: '21e08d37-8d53-4144-87cb-557b8298aed3',
        providerChannelId: 'teams-channel-1',
        providerConversationId: 'conversation-1',
        providerReplyToMessageId: 'root-message-1',
        providerChannelType: 'personal',
        providerEventId: 'teams:tenant:conversation-1:activity-1',
        providerMessageId: 'activity-1',
        serviceUrl: 'https://smba.trafficmanager.net/amer/21e08d37-8d53-4144-87cb-557b8298aed3/',
        providerTarget: {
          hostRef: 'chatllm',
          communicationChannelNamespace: 'channels',
          communicationChannelName: 'teams-channel',
        },
      })

      expect(response).toEqual({ ok: true })
      expect(verifyCredentials).toHaveBeenCalledOnce()
      expect(rpc.confirmTeamsLinkSession).toHaveBeenCalledOnce()
      expect(rpc.confirmTeamsLinkSession).toHaveBeenCalledWith(
        expect.objectContaining({
          providerChannelId: 'teams-channel-1',
        })
      )
      expect(rememberConversation).toHaveBeenCalledTimes(2)
      expect(rememberConversation).toHaveBeenLastCalledWith(
        'conversation-1',
        'https://smba.trafficmanager.net/amer/21e08d37-8d53-4144-87cb-557b8298aed3/'
      )
      expect(sendMessage).toHaveBeenCalledWith(
        'conversation-1',
        'Teams identity confirmed.',
        'root-message-1'
      )
    } finally {
      rememberConversation.mockRestore()
      verifyCredentials.mockRestore()
      sendMessage.mockRestore()
    }
  })

  it('does not confirm the Teams identity when bot authentication fails', async () => {
    const rpc = rpcClient()
    rpc.confirmTeamsLinkSession = vi.fn()
    const verifyCredentials = vi
      .spyOn(TeamsAdapter.prototype, 'verifyCredentials')
      .mockRejectedValue(new Error('teams_token_failed:invalid_client:AADSTS7000215'))

    try {
      const reader = new ChannelReader({
        rpcClient: rpc,
        notificationDeliveryClient: null,
        channels: [
          {
            name: 'teams-channel',
            namespace: 'channels',
            spec: {
              hostRef: 'chatllm',
              credentialsSecretRef: { name: 'cc-teams-channel-credentials' },
              teams: [],
              teamsSettings: {
                appId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
                tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
              },
            },
          },
        ],
        credentialsResolver: {
          resolve: vi.fn(async () => ({ teamsAppPassword: 'invalid-client-secret' })),
        },
      })
      await reader.initializeAdapters()

      await expect(
        reader.handleTeamsHandoff({
          kind: 'teams.enrollment',
          nonce: '400479',
          providerUserId: 'teams-user-1',
          providerWorkspaceId: '21e08d37-8d53-4144-87cb-557b8298aed3',
          providerChannelId: 'teams-channel-1',
          providerConversationId: 'conversation-1',
          providerReplyToMessageId: 'root-message-1',
          providerChannelType: 'personal',
          providerEventId: 'teams:tenant:conversation-1:activity-1',
          providerMessageId: 'activity-1',
          serviceUrl: 'https://smba.trafficmanager.net/amer/21e08d37-8d53-4144-87cb-557b8298aed3/',
          providerTarget: {
            hostRef: 'chatllm',
            communicationChannelNamespace: 'channels',
            communicationChannelName: 'teams-channel',
          },
        })
      ).rejects.toThrow('teams_token_failed:invalid_client:AADSTS7000215')

      expect(rpc.confirmTeamsLinkSession).not.toHaveBeenCalled()
    } finally {
      verifyCredentials.mockRestore()
    }
  })
})

describe('ChannelReader Teams final delivery', () => {
  it('posts the Teams async status at the conversation root when thread replies are disabled', async () => {
    vi.mocked(createProgressStream).mockReturnValue({
      close: vi.fn(),
      get steps() {
        return []
      },
    })
    const rpc = rpcClient()
    rpc.sendMessage = vi.fn(async () => ({
      success: true,
      status: 'pending' as const,
      taskId: 'teams-task-1',
    }))
    const sendMessage = vi.fn(async () => 'teams-status-message')
    const adapter: ChannelAdapter = {
      channelType: 'teams',
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      fetchMessages: vi.fn(async () => []),
      sendMessage,
      editMessage: vi.fn(async () => undefined),
    }
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      channels: [
        {
          name: 'teams-channel',
          namespace: 'channels',
          spec: {
            hostRef: 'chatllm',
            teams: [
              {
                channelId: '19:channel-1@thread.tacv2',
                tenantId: 'tenant-1',
                replyInThreads: false,
              },
            ],
          },
        },
      ],
    })
    const handleMessageWithProgress = reader as unknown as {
      handleMessageWithProgress(message: Message, channelAdapter: ChannelAdapter): Promise<void>
    }

    await handleMessageWithProgress.handleMessageWithProgress(
      {
        channelType: 'teams',
        channelId: '19:channel-1@thread.tacv2;messageid=post-1',
        sender: 'teams-user-1',
        content: 'Hello',
        timestamp: new Date('2026-07-10T17:09:33.539Z'),
        messageId: 'activity-1',
        threadId: 'post-1',
        providerIdentity: {
          medium: 'teams',
          providerUserId: 'teams-user-1',
          providerWorkspaceId: 'tenant-1',
          providerChannelId: '19:channel-1@thread.tacv2',
          providerEventId: 'teams:tenant-1:conversation-1:activity-1',
          providerTarget: {
            hostRef: 'chatllm',
            communicationChannelNamespace: 'channels',
            communicationChannelName: 'teams-channel',
          },
        },
      },
      adapter
    )

    expect(sendMessage).toHaveBeenCalledWith(
      '19:channel-1@thread.tacv2',
      '\u23f3 Processing your request...',
      undefined
    )
  })

  it('posts a threaded fallback when a completed Teams result cannot edit the status', async () => {
    vi.useFakeTimers()
    const closeStream = vi.fn()
    vi.mocked(createProgressStream).mockReturnValue({
      close: closeStream,
      get steps() {
        return []
      },
    })
    const rpc = rpcClient()
    rpc.sendMessage = vi.fn(async () => ({
      success: true,
      status: 'pending' as const,
      taskId: 'teams-task-1',
    }))
    rpc.getTaskResult = vi.fn(async () => ({
      success: true,
      status: 'completed' as const,
      response: 'Final answer',
    }))
    const editMessage = vi
      .fn<ChannelAdapter['editMessage']>()
      .mockRejectedValueOnce(new Error('teams_activity_edit_failed_503'))
      .mockResolvedValue(undefined)
    const sendMessage = vi.fn(async () => 'teams-status-message')
    const adapter: ChannelAdapter = {
      channelType: 'teams',
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      fetchMessages: vi.fn(async () => []),
      sendMessage,
      editMessage,
    }
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map(),
    })
    const handleMessageWithProgress = reader as unknown as {
      handleMessageWithProgress(message: Message, channelAdapter: ChannelAdapter): Promise<void>
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await handleMessageWithProgress.handleMessageWithProgress(
        {
          channelType: 'teams',
          channelId: 'conversation-1',
          sender: 'teams-user-1',
          content: 'Hello',
          timestamp: new Date('2026-07-10T17:09:33.539Z'),
          messageId: 'activity-1',
        },
        adapter
      )

      await vi.advanceTimersByTimeAsync(2_000)
      expect(editMessage).toHaveBeenCalledTimes(1)
      expect(editMessage).toHaveBeenLastCalledWith(
        'conversation-1',
        'teams-status-message',
        'Final answer',
        undefined
      )
      expect(sendMessage).toHaveBeenLastCalledWith('conversation-1', 'Final answer', 'activity-1')
      expect(closeStream).toHaveBeenCalledOnce()
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('TeamsAdapter authentication', () => {
  it('reports the Microsoft AADSTS code without exposing the full error description', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({
        error: 'invalid_client',
        error_description:
          'AADSTS7000215: Invalid client secret provided. Trace ID: private-trace-id',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new TeamsAdapter()

    try {
      await adapter.connect({
        teamsAppId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
        teamsAppPassword: 'invalid-client-secret',
        teamsTenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
      })

      await expect(adapter.verifyCredentials()).rejects.toThrow(
        'teams_token_failed:invalid_client:AADSTS7000215'
      )
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a failed Bot Connector edit so final delivery can retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          access_token: 'bot-token',
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new TeamsAdapter()

    try {
      await adapter.connect({
        teamsAppId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
        teamsAppPassword: 'client-secret',
        teamsTenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
      })
      adapter.rememberConversation('conversation-1', 'https://smba.trafficmanager.net/amer/')

      await expect(
        adapter.editMessage('conversation-1', 'activity-1', 'Final answer')
      ).rejects.toThrow('teams_activity_edit_failed_503')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({
          method: 'PUT',
          signal: expect.any(AbortSignal),
        })
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('sends adaptive card actions as replies to the source Teams thread', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          access_token: 'bot-token',
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ id: 'bot-reply-1' }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new TeamsAdapter()

    try {
      await adapter.connect({
        teamsAppId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
        teamsAppPassword: 'client-secret',
        teamsTenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
      })
      adapter.rememberConversation('conversation-1', 'https://smba.trafficmanager.net/amer/')

      const messageId = await adapter.sendMessage(
        'conversation-1',
        'Approval needed',
        'root-activity-1',
        undefined,
        {
          teamsActions: [
            { title: 'Approve', value: 'approve:approval-1', style: 'positive' },
            { title: 'Deny', value: 'deny:approval-1', style: 'destructive' },
          ],
        }
      )

      expect(messageId).toBe('bot-reply-1')
      expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
        'https://smba.trafficmanager.net/amer/v3/conversations/conversation-1/activities/root-activity-1'
      )
      const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
      expect(body.replyToId).toBe('root-activity-1')
      expect(body.attachments[0].content.actions).toEqual([
        expect.objectContaining({
          title: 'Approve',
          data: expect.objectContaining({ action: 'approve:approval-1' }),
          style: 'positive',
        }),
        expect.objectContaining({
          title: 'Deny',
          data: expect.objectContaining({ action: 'deny:approval-1' }),
          style: 'destructive',
        }),
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('uses the root Teams conversation serviceUrl for thread conversation replies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          access_token: 'bot-token',
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ id: 'bot-reply-1' }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new TeamsAdapter()

    try {
      await adapter.connect({
        teamsAppId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
        teamsAppPassword: 'client-secret',
        teamsTenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
      })
      adapter.rememberConversation(
        '19:channel-1@thread.tacv2',
        'https://smba.trafficmanager.net/amer/'
      )

      await adapter.sendMessage(
        '19:channel-1@thread.tacv2;messageid=root-post-1',
        'Workflow completed',
        'root-post-1'
      )

      expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
        'https://smba.trafficmanager.net/amer/v3/conversations/19%3Achannel-1%40thread.tacv2%3Bmessageid%3Droot-post-1/activities/root-post-1'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('updates a Teams progress activity with tool actions and then clears them', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ access_token: 'bot-token', expires_in: 3600 }),
      })
      .mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({}) })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new TeamsAdapter()

    try {
      await adapter.connect({
        teamsAppId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
        teamsAppPassword: 'client-secret',
        teamsTenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
      })
      adapter.rememberConversation('conversation-1', 'https://smba.trafficmanager.net/amer/')

      await adapter.editMessage('conversation-1', 'status-activity-1', 'Approval needed', {
        teamsActions: [
          { title: 'Approve', value: 'tool:a:abcdefghijklmnop', style: 'positive' },
          { title: 'Deny', value: 'tool:d:abcdefghijklmnop', style: 'destructive' },
        ],
      })
      await adapter.editMessage('conversation-1', 'status-activity-1', 'Approved. Processing...')

      const approvalBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
      expect(approvalBody.attachments[0].content.actions).toEqual([
        expect.objectContaining({ title: 'Approve', style: 'positive' }),
        expect.objectContaining({ title: 'Deny', style: 'destructive' }),
      ])
      const clearedBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))
      expect(clearedBody).toMatchObject({
        type: 'message',
        text: 'Approved. Processing...',
        attachments: [],
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps Teams file attachment follow-ups in the source thread', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          access_token: 'bot-token',
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ id: 'bot-reply-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ id: 'bot-file-1' }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new TeamsAdapter()

    try {
      await adapter.connect({
        teamsAppId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
        teamsAppPassword: 'client-secret',
        teamsTenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
      })
      adapter.rememberConversation('conversation-1', 'https://smba.trafficmanager.net/amer/')

      await adapter.sendMessage('conversation-1', '', 'root-activity-1', [
        {
          id: 'result-1',
          kind: 'file',
          mimeType: 'text/plain',
          encoding: 'base64',
          dataBase64: Buffer.from('file contents').toString('base64'),
          filename: 'result.txt',
          sourceTool: 'workflow_result',
        },
      ])

      expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
        'https://smba.trafficmanager.net/amer/v3/conversations/conversation-1/activities/root-activity-1'
      )
      const body = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))
      expect(body.replyToId).toBe('root-activity-1')
      expect(body.text).toContain('Generated file: result.txt')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('ChannelReader cron result delivery', () => {
  function cronResult(overrides: Record<string, unknown> = {}) {
    return {
      id: 'cron-result-1',
      origin: { channelType: 'telegram' as const, channelId: '424242', sender: '123456' },
      response: 'cron output',
      cronJobId: 'job-1',
      cronJobName: 'HN News',
      timestamp: new Date('2026-05-28T10:00:00.000Z').toISOString(),
      status: 'completed' as const,
      ...overrides,
    }
  }

  function telegramAdapter() {
    return {
      channelType: 'telegram' as const,
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
    }
  }

  it('delivers a completed cron result and acknowledges it', async () => {
    const rpc = rpcClient()
    const result = cronResult()
    rpc.getCronResults = vi.fn(async () => [result])

    const adapter = telegramAdapter()
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['telegram', adapter as never]]),
    })

    await (reader as unknown as { pollCronResults: () => Promise<void> }).pollCronResults()

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1)
    expect(adapter.sendMessage).toHaveBeenCalledWith('424242', 'cron output', undefined, undefined)
    expect(rpc.acknowledgeCronResult).toHaveBeenCalledTimes(1)
    expect(rpc.acknowledgeCronResult).toHaveBeenCalledWith('cron-result-1', result.origin)
  })

  it('skips delivery when no adapter is registered for the origin channel', async () => {
    const rpc = rpcClient()
    rpc.getCronResults = vi.fn(async () => [cronResult()])

    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map(),
    })

    await (reader as unknown as { pollCronResults: () => Promise<void> }).pollCronResults()

    expect(rpc.acknowledgeCronResult).not.toHaveBeenCalled()
  })
})
