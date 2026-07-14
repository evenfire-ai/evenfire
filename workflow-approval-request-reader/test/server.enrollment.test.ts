import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import { AddressInfo } from 'node:net'
import type { ReaderConfig } from '../src/config.js'

vi.mock('../src/mcpHostClient.js', () => ({
  submitMcpHostDecision: vi.fn().mockResolvedValue({ ok: true }),
  submitMcpHostEnrollment: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('../src/channelReaderClient.js', () => ({
  handoffSlackEnrollmentToChannelReader: vi.fn().mockResolvedValue({ ok: true }),
  handoffSlackMessageToChannelReader: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('../src/controlApiClient.js', () => ({
  verifySlackTargetSignature: vi.fn().mockResolvedValue({
    ok: true,
    hostRef: 'sandbox-recipes/figure-d-recipe',
    communicationChannelRef: 'channels/slack-app',
    providerWorkspaceId: 'T123',
    channelName: 'slack-app',
    channelNamespace: 'channels',
  }),
}))

let createServer: (cfg: ReaderConfig) => http.Server
let handoffSlackEnrollmentToChannelReader: ReturnType<typeof vi.fn>
let submitMcpHostDecision: ReturnType<typeof vi.fn>
let submitMcpHostEnrollment: ReturnType<typeof vi.fn>
let verifySlackTargetSignature: ReturnType<typeof vi.fn>
const SLACK_TARGET_ID = 'slack:test-target'

const baseConfig: ReaderConfig = {
  port: 0,
  mcpHostBaseUrl: 'http://wf-figure-d-recipe-mcp-host.sandbox-recipes.svc.cluster.local:8080',
  mcpHostRef: 'sandbox-recipes/figure-d-recipe',
  mcpHostTargets: [
    {
      hostRef: 'sandbox-recipes/figure-d-recipe',
      baseUrl: 'http://wf-figure-d-recipe-mcp-host.sandbox-recipes.svc.cluster.local:8080',
    },
  ],
  enabledMedia: new Set(['telegram', 'slack']),
  mcpHostTimeoutMs: 5000,
  mcpHostMessageTimeoutMs: 120_000,
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 120,
  controlApiBaseUrl: '',
  controlApiToken: '',
  controlApiTimeoutMs: 4000,
  channelReaderUrlTemplate: 'http://channel-reader-{host}:8099',
  channelReaderHandoffToken: 'handoff-token',
  channelReaderHandoffTimeoutMs: 5000,
}

async function postWebhook(
  cfg: ReaderConfig,
  medium: string,
  body: string,
  headers: Record<string, string> = {},
  targetId?: string
): Promise<{ status: number; body: unknown }> {
  const server = createServer(cfg)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const path = targetId
    ? `/webhooks/${medium}/${encodeURIComponent(targetId)}`
    : `/webhooks/${medium}`

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body,
    })
    return { status: response.status, body: await response.json() }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe('workflow approval request reader enrollment callbacks', () => {
  beforeAll(async () => {
    ;({ createServer } = await import('../src/server.js'))
    ;({ handoffSlackEnrollmentToChannelReader } = await import('../src/channelReaderClient.js'))
    ;({ submitMcpHostDecision, submitMcpHostEnrollment } = await import('../src/mcpHostClient.js'))
    ;({ verifySlackTargetSignature } = await import('../src/controlApiClient.js'))
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(handoffSlackEnrollmentToChannelReader).mockResolvedValue({ ok: true })
    vi.mocked(verifySlackTargetSignature).mockResolvedValue({
      ok: true,
      hostRef: 'sandbox-recipes/figure-d-recipe',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
  })

  it('confirms Telegram /start link sessions through mcp-host', async () => {
    const body = JSON.stringify({
      message: {
        text: '/start nonce_1234567890123456',
        from: { id: 123 },
        chat: { id: 456 },
      },
    })

    const response = await postWebhook(
      { ...baseConfig, telegramWebhookSecret: 'telegram-secret' },
      'telegram',
      body,
      { 'x-telegram-bot-api-secret-token': 'telegram-secret' }
    )

    expect(response.status).toBe(200)
    expect(submitMcpHostEnrollment).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        medium: 'telegram',
        nonce: 'nonce_1234567890123456',
        providerUserId: '123',
        providerChannelId: '456',
      })
    )
    expect(submitMcpHostDecision).not.toHaveBeenCalled()
  })

  it('hands Slack link actions to channel-reader after signature verification', async () => {
    const payload = JSON.stringify({
      actions: [{ value: 'workflow_approval_link:123456' }],
      user: { id: 'U123' },
      team: { id: 'T123' },
      channel: { id: 'D123' },
    })
    const body = new URLSearchParams({ payload }).toString()
    const timestamp = `${Math.floor(Date.now() / 1000)}`

    const response = await postWebhook(
      baseConfig,
      'slack',
      body,
      {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': 'v0=signature',
      },
      SLACK_TARGET_ID
    )

    expect(response.status).toBe(200)
    expect(verifySlackTargetSignature).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        targetId: SLACK_TARGET_ID,
        timestamp,
        signature: 'v0=signature',
      })
    )
    expect(handoffSlackEnrollmentToChannelReader).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        hostRef: 'sandbox-recipes/figure-d-recipe',
        communicationChannelRef: 'channels/slack-app',
        providerWorkspaceId: 'T123',
      }),
      expect.objectContaining({
        medium: 'slack',
        nonce: '123456',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'D123',
      }),
      null,
      null
    )
    expect(submitMcpHostEnrollment).not.toHaveBeenCalled()
    expect(submitMcpHostDecision).not.toHaveBeenCalled()
  })

  it('confirms mentioned Slack verify messages delivered as message events', async () => {
    vi.mocked(verifySlackTargetSignature).mockResolvedValueOnce({
      ok: true,
      hostRef: 'sandbox-recipes/figure-d-recipe',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      channelName: 'slack-app',
      channelNamespace: 'channels',
      replyOnlyWhenMentioned: true,
    })
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev123',
      event: {
        type: 'message',
        user: 'U123',
        channel: 'C123',
        text: '<@UBOT888> verify 123456',
        ts: '1710000000.000001',
      },
    })
    const timestamp = `${Math.floor(Date.now() / 1000)}`

    const response = await postWebhook(
      baseConfig,
      'slack',
      body,
      {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': 'v0=signature',
      },
      SLACK_TARGET_ID
    )

    expect(response.status).toBe(200)
    await vi.waitFor(() => {
      expect(handoffSlackEnrollmentToChannelReader).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          hostRef: 'sandbox-recipes/figure-d-recipe',
          communicationChannelRef: 'channels/slack-app',
          providerWorkspaceId: 'T123',
          replyOnlyWhenMentioned: true,
        }),
        expect.objectContaining({
          medium: 'slack',
          nonce: '123456',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
        }),
        '1710000000.000001',
        null
      )
    })
    expect(submitMcpHostEnrollment).not.toHaveBeenCalled()
    expect(submitMcpHostDecision).not.toHaveBeenCalled()
  })
})
