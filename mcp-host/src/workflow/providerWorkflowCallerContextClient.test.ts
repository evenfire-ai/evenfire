import { type Mock, afterEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from '../server'
import { resolveProviderWorkflowCallerContext } from './providerWorkflowCallerContextClient'

const fetchMock = vi.fn() as Mock

function getEnv(key: string): string | undefined {
  const values: Record<string, string> = {
    MCP_HOST_GATEWAY_URL: 'http://gateway:8092',
    MCP_HOST_WORKFLOW_CONTROL_TOKEN: 'control-token',
  }
  return values[key]
}

function telegramMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    content: 'List workflows',
    channelType: 'telegram',
    channelId: 'tg-chat-1',
    sender: '123456',
    timestamp: '2026-05-28T12:00:00.000Z',
    messageId: 'telegram:tg-chat-1:42',
    hostRef: 'chatllm',
    providerIdentity: {
      medium: 'telegram',
      providerUserId: '123456',
      providerChannelId: 'tg-chat-1',
      providerEventId: 'telegram:tg-chat-1:42',
    },
    ...overrides,
  }
}

describe('resolveProviderWorkflowCallerContext', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('resolves stable provider identity into an authenticated workflow caller context', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ userId: '00000000-0000-4000-8000-000000000001' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveProviderWorkflowCallerContext(telegramMessage(), getEnv)

    expect(result).toEqual({
      targetUserId: '00000000-0000-4000-8000-000000000001',
      conversationId: 'telegram:tg-chat-1:123456',
      originChannelType: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: 'tg-chat-1',
      providerEventId: 'telegram:tg-chat-1:42',
      sourceMessageId: 'telegram:tg-chat-1:42',
      sourceMessageContent: 'List workflows',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gateway:8092/api/v1/workflow-approval-mediums/resolve',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer control-token',
          'Content-Type': 'application/json',
        }),
      })
    )
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
      },
    })
  })

  it('adds the server-bindable channel trace facts when a session is available', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ userId: '00000000-0000-4000-8000-000000000001' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await resolveProviderWorkflowCallerContext(telegramMessage(), getEnv, {
      version: 1,
      runId: '00000000-0000-4000-8000-000000000123',
      sessionId: 'conv-telegram-session-1',
      origin: 'channel_event',
      correlationRefs: [],
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
      },
      traceBinding: {
        runId: '00000000-0000-4000-8000-000000000123',
        sessionId: 'conv-telegram-session-1',
        origin: 'channel_event',
      },
    })
  })

  it('does not derive team context from provider channel identity', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        userId: '00000000-0000-4000-8000-000000000001',
        targetTeamId: '00000000-0000-4000-8000-0000000000aa',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveProviderWorkflowCallerContext(telegramMessage(), getEnv)

    expect(result).toEqual({
      targetUserId: '00000000-0000-4000-8000-000000000001',
      conversationId: 'telegram:tg-chat-1:123456',
      originChannelType: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: 'tg-chat-1',
      providerEventId: 'telegram:tg-chat-1:42',
      sourceMessageId: 'telegram:tg-chat-1:42',
      sourceMessageContent: 'List workflows',
    })
    expect(result).not.toHaveProperty('targetTeamId')
  })

  it('fails closed without a provider identity', async () => {
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveProviderWorkflowCallerContext(
      telegramMessage({ providerIdentity: undefined }),
      getEnv
    )

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires stable Slack workspace identity before resolving', async () => {
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveProviderWorkflowCallerContext(
      {
        ...telegramMessage(),
        channelType: 'slack',
        channelId: 'C123',
        sender: 'U123',
        providerIdentity: {
          medium: 'slack',
          providerUserId: 'U123',
          providerChannelId: 'C123',
          providerEventId: 'slack:T123:C123:1700000001.000001',
        },
      },
      getEnv
    )

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves Slack provider identity with stable workspace and channel ids', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ userId: '00000000-0000-4000-8000-000000000002' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveProviderWorkflowCallerContext(
      {
        ...telegramMessage(),
        channelType: 'slack',
        channelId: 'C123',
        sender: 'U123',
        messageId: '1700000001.000001',
        providerIdentity: {
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
          providerEventId: 'slack:T123:C123:1700000001.000001',
        },
      },
      getEnv
    )

    expect(result).toEqual({
      targetUserId: '00000000-0000-4000-8000-000000000002',
      conversationId: 'slack:C123:U123',
      originChannelType: 'slack',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:1700000001.000001',
      sourceMessageId: '1700000001.000001',
      sourceMessageContent: 'List workflows',
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      providerIdentity: {
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
      },
    })
  })

  it('preserves Slack source thread identity for workflow approval routing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ userId: '00000000-0000-4000-8000-000000000002' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveProviderWorkflowCallerContext(
      {
        ...telegramMessage(),
        channelType: 'slack',
        channelId: 'C123',
        sender: 'U123',
        messageId: '1700000001.000002',
        threadId: '1700000001.000001',
        providerIdentity: {
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
          providerEventId: 'slack:T123:C123:1700000001.000002',
        },
      },
      getEnv
    )

    expect(result).toMatchObject({
      conversationId: '1700000001.000001',
      sourceThreadId: '1700000001.000001',
    })
  })

  it('keeps Teams conversation and reply targets separate for approval routing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ userId: '00000000-0000-4000-8000-000000000003' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveProviderWorkflowCallerContext(
      {
        ...telegramMessage(),
        channelType: 'teams',
        channelId: '19:channel-1@thread.tacv2',
        sender: 'teams-user-1',
        messageId: 'activity-1',
        threadId: 'root-message-1',
        providerIdentity: {
          medium: 'teams',
          providerUserId: 'teams-user-1',
          providerWorkspaceId: 'tenant-1',
          providerChannelId: '19:channel-1@thread.tacv2',
          providerChannelType: 'channel',
          providerEventId: 'teams:tenant-1:19:channel-1@thread.tacv2:activity-1',
        },
      },
      getEnv
    )

    expect(result).toMatchObject({
      targetUserId: '00000000-0000-4000-8000-000000000003',
      conversationId: '19:channel-1@thread.tacv2',
      originChannelType: 'teams',
      providerUserId: 'teams-user-1',
      providerWorkspaceId: 'tenant-1',
      providerChannelId: '19:channel-1@thread.tacv2',
      providerEventId: 'teams:tenant-1:19:channel-1@thread.tacv2:activity-1',
      sourceThreadId: 'root-message-1',
      sourceMessageId: 'activity-1',
    })
  })

  it('requires stable provider channel identity before resolving', async () => {
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveProviderWorkflowCallerContext(
      telegramMessage({
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: '',
          providerEventId: 'telegram:tg-chat-1:42',
        },
      }),
      getEnv
    )

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
