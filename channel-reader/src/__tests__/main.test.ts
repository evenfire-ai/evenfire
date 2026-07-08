import { describe, expect, it, vi } from 'vitest'
import { ChannelReader, type ChannelReaderOptions } from '../main'
import type { MessageResponse } from '../rpcClient'
import type { ChannelAdapter, Message } from '../types'

vi.hoisted(() => {
  process.env.CLERUM_HOST_REF = process.env.CLERUM_HOST_REF ?? 'test-host'
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
    rpc.authorizeProviderMessage = vi.fn(async () => false)
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map(),
    })

    await reader.handleMessages([telegramMessage()])

    expect(rpc.authorizeProviderMessage).toHaveBeenCalledOnce()
    expect(rpc.sendMessage).not.toHaveBeenCalled()
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
    expect(rpc.sendMessage).toHaveBeenCalledWith(first)
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
      expect.objectContaining({ content: 'download result' })
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
      expect.objectContaining({ content: '@other_bot download result' })
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
