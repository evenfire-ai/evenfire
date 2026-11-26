import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReaderConfig } from '../src/config.js'
import {
  canApprove,
  resolveCommunicationChannelRef,
  sendTeamsTargetMessage,
  verifySlackTargetSignature,
} from '../src/controlApiClient.js'

const cfg = (overrides: Partial<ReaderConfig> = {}): ReaderConfig =>
  ({
    port: 8098,
    mcpHostBaseUrl: 'http://mcp-host:8080',
    mcpHostRef: 'sandbox-recipes/r1',
    mcpHostTargets: [],
    enabledMedia: new Set(['telegram']),
    mcpHostTimeoutMs: 5000,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 120,
    controlApiBaseUrl: 'http://control-api:8090',
    controlApiToken: 'test-token',
    controlApiTimeoutMs: 4000,
    ...overrides,
  }) as ReaderConfig

const params = {
  approvalRequestId: '00000000-0000-4000-8000-000000000001',
  medium: 'telegram',
  providerUserId: '12345',
  channelAlias: 'abcdef01',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('canApprove', () => {
  it('returns null when controlApiBaseUrl or controlApiToken is empty (skip consulta)', async () => {
    const result = await canApprove(cfg({ controlApiToken: '' }), params)
    expect(result).toBeNull()
  })

  it('returns canApprove:true on a 200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ canApprove: true }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await canApprove(cfg(), params)
    expect(result).toEqual({ canApprove: true })
    // Verify auth headers
    const [, init] = fetchMock.mock.calls[0]!
    const headers = init!.headers as Record<string, string>
    expect(headers['x-service-token']).toBe('workflow-approval-reader')
    expect(headers['Authorization']).toBe('Bearer test-token')
  })

  it('returns canApprove:false with reason on a non-2xx response (fail-safe)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ canApprove: false, reason: 'cross_bot_mismatch' }),
      })
    )
    const result = await canApprove(cfg(), params)
    expect(result).toEqual({ canApprove: false, reason: 'consulta_failed' })
  })

  it('returns canApprove:false when fetch throws (timeout/network — fail-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))
    const result = await canApprove(cfg(), params)
    expect(result).toEqual({ canApprove: false, reason: 'consulta_error' })
  })
})

describe('resolveCommunicationChannelRef', () => {
  it('returns null when control-api is not configured', async () => {
    const result = await resolveCommunicationChannelRef(cfg({ controlApiToken: '' }), {
      medium: 'slack',
      providerWorkspaceId: 'T123',
      providerChannelId: 'D123',
    })
    expect(result).toBeNull()
  })

  it('returns the resolved CommunicationChannel ref on a 200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ communicationChannelRef: 'channels/slack-a' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveCommunicationChannelRef(cfg(), {
      medium: 'slack',
      providerWorkspaceId: 'T123',
      providerChannelId: 'D123',
    })

    expect(result).toEqual({ ok: true, communicationChannelRef: 'channels/slack-a' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/api/v1/internal/workflow-approval-reader/channel-ref')
    expect(String(url)).toContain('providerWorkspaceId=T123')
    expect(String(url)).toContain('providerChannelId=D123')
    const headers = init!.headers as Record<string, string>
    expect(headers['x-service-token']).toBe('workflow-approval-reader')
  })

  it('returns a fail-closed error on non-2xx responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: 'communication_channel_ambiguous' }),
      })
    )

    await expect(
      resolveCommunicationChannelRef(cfg(), {
        medium: 'slack',
        providerWorkspaceId: 'T123',
        providerChannelId: 'D123',
      })
    ).resolves.toEqual({ ok: false, error: 'communication_channel_ambiguous' })
  })
})

describe('sendTeamsTargetMessage', () => {
  const message = {
    targetId: 'teams:eyJuYW1lc3BhY2UiOiJjaGFubmVscyJ9',
    conversationId: '19:channel-1@thread.tacv2',
    threadConversationId: '19:channel-1@thread.tacv2;messageid=root-post-1',
    replyToId: 'root-post-1',
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    text: 'I could not approve this workflow approval. Try again in a moment.',
  }

  it('posts the message to the control-api Teams send route with the service headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, id: 'activity-2' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendTeamsTargetMessage(cfg(), message)

    expect(result).toEqual({ ok: true, ts: null, id: 'activity-2' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(
      `http://control-api:8090/api/v1/internal/workflow-approval-reader/teams-targets/${encodeURIComponent(
        message.targetId
      )}/send-message`
    )
    expect(init!.method).toBe('POST')
    const headers = init!.headers as Record<string, string>
    expect(headers['x-service-token']).toBe('workflow-approval-reader')
    expect(headers['Authorization']).toBe('Bearer test-token')
    expect(JSON.parse(String(init!.body))).toEqual({
      conversationId: message.conversationId,
      threadConversationId: message.threadConversationId,
      replyToId: message.replyToId,
      serviceUrl: message.serviceUrl,
      text: message.text,
    })
  })

  it('returns the control-api refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({ error: 'teams_send_failed', providerError: 'http_403' }),
      })
    )

    await expect(sendTeamsTargetMessage(cfg(), message)).resolves.toEqual({
      ok: false,
      status: 502,
      error: 'teams_send_failed',
    })
  })

  it('answers 503 without a call when control-api is not configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendTeamsTargetMessage(cfg({ controlApiToken: '' }), message)).resolves.toEqual({
      ok: false,
      status: 503,
      error: 'control_api_not_configured',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('verifySlackTargetSignature', () => {
  it('propagates botUserId when supplied by control-api', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          hostRef: 'host-1',
          communicationChannelRef: 'channels/slack-app',
          providerWorkspaceId: 'T123',
          replyOnlyWhenMentioned: true,
          replyInThreads: false,
          botUserId: 'UBOT123',
          channelName: 'slack-app',
          channelNamespace: 'channels',
        }),
      })
    )

    const result = await verifySlackTargetSignature(cfg(), {
      targetId: 'slack:t1',
      timestamp: '1710000000',
      signature: 'v0=abc',
      rawBody: Buffer.from('{}'),
    })

    expect(result).toEqual({
      ok: true,
      hostRef: 'host-1',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyOnlyWhenMentioned: true,
      replyInThreads: false,
      botUserId: 'UBOT123',
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
  })
})
