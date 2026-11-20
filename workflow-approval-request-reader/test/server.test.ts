import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import { createServer as createHttpServer } from 'node:http'
import { AddressInfo } from 'node:net'
import type { ReaderConfig } from '../src/config.js'

vi.mock('../src/mcpHostClient.js', () => ({
  submitMcpHostDecision: vi.fn().mockResolvedValue({ ok: true }),
  submitMcpHostEnrollment: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('../src/channelReaderClient.js', () => ({
  handoffSlackEnrollmentToChannelReader: vi.fn().mockResolvedValue({ ok: true }),
  handoffSlackMessageToChannelReader: vi.fn().mockResolvedValue({ ok: true }),
  handoffTeamsEnrollmentToChannelReader: vi.fn().mockResolvedValue({ ok: true }),
  handoffTeamsFileConsentToChannelReader: vi.fn().mockResolvedValue({ ok: true }),
  handoffTeamsMessageToChannelReader: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('../src/controlApiClient.js', () => ({
  resolveTeamsTarget: vi.fn().mockResolvedValue({
    ok: true,
    hostRef: 'sandbox-recipes/figure-d-recipe',
    communicationChannelRef: 'channels/teams-bot',
    providerWorkspaceId: 'tenant-1',
    replyOnlyWhenMentioned: true,
    appId: 'teams-app-1',
    appName: 'evenfire',
  }),
  resolveCommunicationChannelRef: vi.fn(),
  sendSlackTargetMessage: vi.fn().mockResolvedValue({ ok: true }),
  sendTeamsTargetMessage: vi.fn().mockResolvedValue({ ok: true }),
  updateSlackTargetMessage: vi.fn().mockResolvedValue({ ok: true }),
  updateTeamsTargetMessage: vi.fn().mockResolvedValue({ ok: true }),
  verifySlackTargetSignature: vi.fn().mockResolvedValue({
    ok: true,
    hostRef: 'sandbox-recipes/figure-d-recipe',
    communicationChannelRef: 'channels/slack-app',
    providerWorkspaceId: 'T123',
    channelName: 'slack-app',
    channelNamespace: 'channels',
  }),
}))

vi.mock('../src/teamsAuth.js', () => ({
  verifyTeamsAuthorization: vi.fn().mockResolvedValue({ ok: true }),
}))

const APPROVAL_ID = '99999999-8888-7777-6666-555555555555'
const SLACK_TARGET_ID = 'slack:test-target'
const TEAMS_TARGET_ID = 'teams:test-target'
const WORKFLOW_RUN_ID = '11111111-2222-3333-4444-555555555555'

let createServer: (cfg: ReaderConfig) => http.Server
let handoffSlackMessageToChannelReader: ReturnType<typeof vi.fn>
let handoffTeamsMessageToChannelReader: ReturnType<typeof vi.fn>
let handoffTeamsFileConsentToChannelReader: ReturnType<typeof vi.fn>
let resolveCommunicationChannelRef: ReturnType<typeof vi.fn>
let resolveTeamsTarget: ReturnType<typeof vi.fn>
let sendSlackTargetMessage: ReturnType<typeof vi.fn>
let sendTeamsTargetMessage: ReturnType<typeof vi.fn>
let submitMcpHostDecision: ReturnType<typeof vi.fn>
let submitMcpHostEnrollment: ReturnType<typeof vi.fn>
let updateSlackTargetMessage: ReturnType<typeof vi.fn>
let updateTeamsTargetMessage: ReturnType<typeof vi.fn>
let verifySlackTargetSignature: ReturnType<typeof vi.fn>
let verifyTeamsAuthorization: ReturnType<typeof vi.fn>

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

async function waitForMockCall(mock: ReturnType<typeof vi.fn>, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mock.mock.calls.length >= count) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for mock to be called ${count} time(s)`)
}

describe('workflow approval request reader server', () => {
  beforeAll(async () => {
    ;({ createServer } = await import('../src/server.js'))
    ;({ submitMcpHostDecision, submitMcpHostEnrollment } = await import('../src/mcpHostClient.js'))
    ;({
      handoffSlackMessageToChannelReader,
      handoffTeamsFileConsentToChannelReader,
      handoffTeamsMessageToChannelReader,
    } = await import('../src/channelReaderClient.js'))
    ;({
      resolveCommunicationChannelRef,
      resolveTeamsTarget,
      sendSlackTargetMessage,
      sendTeamsTargetMessage,
      updateSlackTargetMessage,
      updateTeamsTargetMessage,
      verifySlackTargetSignature,
    } = await import('../src/controlApiClient.js'))
    ;({ verifyTeamsAuthorization } = await import('../src/teamsAuth.js'))
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(handoffSlackMessageToChannelReader).mockResolvedValue({ ok: true })
    vi.mocked(handoffTeamsMessageToChannelReader).mockResolvedValue({ ok: true })
    vi.mocked(handoffTeamsFileConsentToChannelReader).mockResolvedValue({ ok: true })
    vi.mocked(resolveTeamsTarget).mockResolvedValue({
      ok: true,
      hostRef: 'sandbox-recipes/figure-d-recipe',
      communicationChannelRef: 'channels/teams-bot',
      providerWorkspaceId: 'tenant-1',
      replyOnlyWhenMentioned: true,
      appId: 'teams-app-1',
      appName: 'evenfire',
    })
    vi.mocked(sendSlackTargetMessage).mockResolvedValue({ ok: true })
    vi.mocked(sendTeamsTargetMessage).mockResolvedValue({ ok: true })
    vi.mocked(updateSlackTargetMessage).mockResolvedValue({ ok: true })
    vi.mocked(updateTeamsTargetMessage).mockResolvedValue({ ok: true })
    vi.mocked(verifySlackTargetSignature).mockResolvedValue({
      ok: true,
      hostRef: 'sandbox-recipes/figure-d-recipe',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
    vi.mocked(verifyTeamsAuthorization).mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects enabled Telegram callbacks when the webhook secret is not configured', async () => {
    const body = JSON.stringify({
      approvalRequestId: APPROVAL_ID,
      providerUserId: '123',
      providerEventId: 'tg-event',
      decision: 'approve',
    })

    const response = await postWebhook(baseConfig, 'telegram', body)

    expect(response).toEqual({
      status: 401,
      body: { error: 'invalid_provider_signature' },
    })
    expect(submitMcpHostDecision).not.toHaveBeenCalled()
  })

  it('accepts Telegram callbacks only with the configured webhook secret', async () => {
    const body = JSON.stringify({
      callback_query: {
        id: 'tg-event',
        data: `approve:${APPROVAL_ID}`,
        from: { id: 123 },
        message: { chat: { id: 456 } },
      },
    })

    const response = await postWebhook(
      { ...baseConfig, telegramWebhookSecret: 'telegram-secret' },
      'telegram',
      body,
      { 'x-telegram-bot-api-secret-token': 'telegram-secret' }
    )

    expect(response.status).toBe(200)
    expect(submitMcpHostDecision).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        medium: 'telegram',
        approvalRequestId: APPROVAL_ID,
        providerUserId: '123',
        providerChannelId: '456',
        providerEventId: 'telegram:456:tg-event',
        decision: 'approve',
      })
    )
  })

  it('preserves mcp-host rejection status for valid provider callbacks', async () => {
    vi.mocked(submitMcpHostDecision).mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'medium_identity_not_verified',
    })
    const body = JSON.stringify({
      callback_query: {
        id: 'tg-event',
        data: `approve:${APPROVAL_ID}`,
        from: { id: 123 },
        message: { chat: { id: 456 } },
      },
    })

    const response = await postWebhook(
      { ...baseConfig, telegramWebhookSecret: 'telegram-secret' },
      'telegram',
      body,
      { 'x-telegram-bot-api-secret-token': 'telegram-secret' }
    )

    expect(response).toEqual({
      status: 403,
      body: { ok: false, error: 'medium_identity_not_verified' },
    })
  })

  it('rejects oversized webhook bodies before provider auth or mcp-host calls', async () => {
    const response = await postWebhook(
      { ...baseConfig, telegramWebhookSecret: 'telegram-secret' },
      'telegram',
      'x'.repeat(1024 * 1024 + 1),
      { 'x-telegram-bot-api-secret-token': 'telegram-secret' }
    )

    expect(response).toEqual({
      status: 413,
      body: { error: 'payload_too_large' },
    })
    expect(submitMcpHostDecision).not.toHaveBeenCalled()
  })

  it('returns generic 500 errors without leaking internal exception messages', async () => {
    vi.mocked(submitMcpHostDecision).mockRejectedValueOnce(
      new Error('database password leaked in stack')
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const body = JSON.stringify({
      callback_query: {
        id: 'tg-event',
        data: `approve:${APPROVAL_ID}`,
        from: { id: 123 },
        message: { chat: { id: 456 } },
      },
    })

    const response = await postWebhook(
      { ...baseConfig, telegramWebhookSecret: 'telegram-secret' },
      'telegram',
      body,
      { 'x-telegram-bot-api-secret-token': 'telegram-secret' }
    )

    expect(response).toEqual({
      status: 500,
      body: { error: 'internal_error' },
    })
    expect(consoleError).toHaveBeenCalledTimes(1)
    const logEntry = JSON.parse(String(consoleError.mock.calls[0][0]))
    expect(logEntry).toMatchObject({
      level: 'error',
      svc: 'workflow-approval-request-reader',
      module: 'server',
      msg: 'unhandled error',
      stage: 'mcp_host',
      medium: 'telegram',
      error: 'Error',
    })
    expect(String(consoleError.mock.calls[0][0])).not.toContain('database password')
  })

  it('returns 400 for malformed JSON instead of silently dropping provider actions', async () => {
    const response = await postWebhook(
      { ...baseConfig, telegramWebhookSecret: 'telegram-secret' },
      'telegram',
      '{"callback_query":',
      { 'x-telegram-bot-api-secret-token': 'telegram-secret' }
    )

    expect(response).toEqual({
      status: 400,
      body: { error: 'invalid_json' },
    })
    expect(submitMcpHostDecision).not.toHaveBeenCalled()
  })

  it('rejects enabled Slack callbacks without a target id', async () => {
    const body = JSON.stringify({
      approvalRequestId: APPROVAL_ID,
      providerUserId: 'U123',
      providerEventId: 'slack-event',
      decision: 'deny',
    })

    const response = await postWebhook(baseConfig, 'slack', body)

    expect(response).toEqual({
      status: 400,
      body: { error: 'slack_target_required' },
    })
    expect(submitMcpHostDecision).not.toHaveBeenCalled()
  })

  it('accepts Slack callbacks when control-api verifies the target signature', async () => {
    const body = JSON.stringify({
      actions: [{ value: `deny:${APPROVAL_ID}` }],
      user: { id: 'U123' },
      team: { id: 'T123' },
      channel: { id: 'C123' },
      trigger_id: 'slack-event',
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
    expect(verifySlackTargetSignature).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        targetId: SLACK_TARGET_ID,
        timestamp,
        signature: 'v0=signature',
      })
    )
    expect(submitMcpHostDecision).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        medium: 'slack',
        approvalRequestId: APPROVAL_ID,
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
        providerEventId: 'slack:T123:C123:slack-event',
        decision: 'deny',
      })
    )
  })

  it('accepts Slack form-encoded interactive callbacks with a verified target signature', async () => {
    const payload = JSON.stringify({
      type: 'block_actions',
      actions: [{ value: `approve:${APPROVAL_ID}` }],
      user: { id: 'U123' },
      team: { id: 'T123' },
      channel: { id: 'C123' },
      trigger_id: 'slack-form-event',
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
    expect(submitMcpHostDecision).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        medium: 'slack',
        approvalRequestId: APPROVAL_ID,
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
        providerEventId: 'slack:T123:C123:slack-form-event',
        decision: 'approve',
      })
    )
  })

  it('acknowledges Slack block actions before the mcp-host decision completes', async () => {
    let resolveDecision: ((value: { ok: true }) => void) | undefined
    vi.mocked(submitMcpHostDecision).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveDecision = resolve
        })
    )
    const body = JSON.stringify({
      type: 'block_actions',
      actions: [{ value: `approve:${APPROVAL_ID}` }],
      user: { id: 'U123' },
      team: { id: 'T123' },
      channel: { id: 'C123' },
      container: { message_ts: '1710000000.000001' },
      trigger_id: 'slack-slow-event',
    })
    const timestamp = `${Math.floor(Date.now() / 1000)}`
    const timeout = Symbol('timeout')

    const response = await Promise.race([
      postWebhook(
        baseConfig,
        'slack',
        body,
        {
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': 'v0=signature',
        },
        SLACK_TARGET_ID
      ),
      new Promise<typeof timeout>(resolve => setTimeout(() => resolve(timeout), 250)),
    ])

    if (response === timeout) {
      resolveDecision?.({ ok: true })
      throw new Error('Slack block action response waited for mcp-host decision completion')
    }
    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(submitMcpHostDecision).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        medium: 'slack',
        approvalRequestId: APPROVAL_ID,
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
        providerEventId: 'slack:T123:C123:slack-slow-event',
        decision: 'approve',
      })
    )
    resolveDecision?.({ ok: true })
    await waitForMockCall(updateSlackTargetMessage)
    expect(updateSlackTargetMessage).toHaveBeenCalledWith(expect.any(Object), {
      targetId: SLACK_TARGET_ID,
      channelId: 'C123',
      messageTs: '1710000000.000001',
      text: 'Approved. Workflow approval recorded.',
      blocks: [],
    })
  })

  it('acknowledges Teams approval actions before the mcp-host decision completes', async () => {
    let resolveDecision: ((value: { ok: true }) => void) | undefined
    vi.mocked(submitMcpHostDecision).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveDecision = resolve
        })
    )
    const channelAlias = '0123456789abcdef'
    const conversationId = '19:channel-1@thread.tacv2;messageid=root-post-1'
    const body = JSON.stringify({
      type: 'message',
      id: 'teams-approval-action-1',
      text: 'Approve',
      value: {
        action: `approve:${APPROVAL_ID}:sandbox-recipes/research-summary-workflow:` + channelAlias,
      },
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'teams-user-1' },
      conversation: {
        id: conversationId,
        conversationType: 'channel',
        tenantId: 'tenant-1',
      },
      channelData: {
        tenant: { id: 'tenant-1' },
        channel: { id: '19:channel-1@thread.tacv2' },
      },
    })
    const timeout = Symbol('timeout')

    const response = await Promise.race([
      postWebhook(
        { ...baseConfig, enabledMedia: new Set(['teams']) },
        'teams',
        body,
        { authorization: 'Bearer teams-token' },
        TEAMS_TARGET_ID
      ),
      new Promise<typeof timeout>(resolve => setTimeout(() => resolve(timeout), 250)),
    ])

    if (response === timeout) {
      resolveDecision?.({ ok: true })
      throw new Error('Teams approval action response waited for mcp-host decision completion')
    }
    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(submitMcpHostDecision).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        medium: 'teams',
        approvalRequestId: APPROVAL_ID,
        mcpHostRef: 'sandbox-recipes/figure-d-recipe',
        providerUserId: 'teams-user-1',
        providerWorkspaceId: 'tenant-1',
        providerChannelId: '19:channel-1@thread.tacv2',
        decision: 'approve',
      })
    )
    resolveDecision?.({ ok: true })
    await waitForMockCall(updateTeamsTargetMessage)
    expect(updateTeamsTargetMessage).toHaveBeenCalledWith(expect.any(Object), {
      targetId: TEAMS_TARGET_ID,
      conversationId: '19:channel-1@thread.tacv2',
      messageId: 'root-post-1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      text: 'Approved. Workflow approval recorded.',
    })
    expect(handoffTeamsMessageToChannelReader).not.toHaveBeenCalled()
  })

  it('marks stale Teams approval messages after a fast acknowledgement', async () => {
    vi.mocked(submitMcpHostDecision).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: 'approval_not_pending',
    })
    const body = JSON.stringify({
      type: 'message',
      id: 'teams-stale-action-1',
      text: 'Deny',
      value: {
        action: `deny:${APPROVAL_ID}`,
      },
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'teams-user-1' },
      conversation: {
        id: '19:channel-1@thread.tacv2',
        conversationType: 'channel',
        tenantId: 'tenant-1',
      },
      replyToId: 'approval-card-1',
      channelData: {
        tenant: { id: 'tenant-1' },
        channel: { id: '19:channel-1@thread.tacv2' },
      },
    })

    const response = await postWebhook(
      { ...baseConfig, enabledMedia: new Set(['teams']) },
      'teams',
      body,
      { authorization: 'Bearer teams-token' },
      TEAMS_TARGET_ID
    )

    expect(response).toEqual({ status: 200, body: { ok: true } })
    await waitForMockCall(updateTeamsTargetMessage)
    expect(updateTeamsTargetMessage).toHaveBeenCalledWith(expect.any(Object), {
      targetId: TEAMS_TARGET_ID,
      conversationId: '19:channel-1@thread.tacv2',
      messageId: 'approval-card-1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      text: 'This workflow approval is no longer pending.',
    })
  })

  it('does not treat malformed Teams approval-like values as mention bypasses', async () => {
    const body = JSON.stringify({
      type: 'message',
      id: 'teams-malformed-action-1',
      text: 'Approve',
      value: {
        action: `approve:${APPROVAL_ID}:unexpected-extra`,
      },
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'teams-user-1' },
      conversation: {
        id: '19:channel-1@thread.tacv2',
        conversationType: 'channel',
        tenantId: 'tenant-1',
      },
      channelData: {
        tenant: { id: 'tenant-1' },
        channel: { id: '19:channel-1@thread.tacv2' },
      },
    })

    const response = await postWebhook(
      { ...baseConfig, enabledMedia: new Set(['teams']) },
      'teams',
      body,
      { authorization: 'Bearer teams-token' },
      TEAMS_TARGET_ID
    )

    expect(response).toEqual({ status: 200, body: { ok: true, ignored: true } })
    expect(submitMcpHostDecision).not.toHaveBeenCalled()
    expect(handoffTeamsMessageToChannelReader).not.toHaveBeenCalled()
  })

  it('marks stale Slack approval messages after a fast acknowledgement', async () => {
    vi.mocked(submitMcpHostDecision).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: 'approval_not_pending',
    })
    const body = JSON.stringify({
      type: 'block_actions',
      actions: [{ value: `deny:${APPROVAL_ID}` }],
      user: { id: 'U123' },
      team: { id: 'T123' },
      channel: { id: 'C123' },
      container: { message_ts: '1710000000.000003' },
      trigger_id: 'slack-stale-event',
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

    expect(response).toEqual({ status: 200, body: { ok: true } })
    await waitForMockCall(updateSlackTargetMessage)
    expect(updateSlackTargetMessage).toHaveBeenCalledWith(expect.any(Object), {
      targetId: SLACK_TARGET_ID,
      channelId: 'C123',
      messageTs: '1710000000.000003',
      text: 'This workflow approval is no longer pending.',
      blocks: [],
    })
    expect(sendSlackTargetMessage).not.toHaveBeenCalled()
  })

  it('routes Slack block action decisions through the verified channel target host', async () => {
    vi.mocked(verifySlackTargetSignature).mockResolvedValueOnce({
      ok: true,
      hostRef: 'llm',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
    const channelAlias = '0123456789abcdef'
    const body = JSON.stringify({
      type: 'block_actions',
      actions: [
        {
          value: `approve:${APPROVAL_ID}:sandbox-recipes/research-summary-workflow:${channelAlias}`,
        },
      ],
      user: { id: 'U123' },
      team: { id: 'T123' },
      channel: { id: 'C123' },
      trigger_id: 'slack-route-event',
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

    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(submitMcpHostDecision).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        medium: 'slack',
        approvalRequestId: APPROVAL_ID,
        mcpHostRef: 'llm',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
        providerEventId: 'slack:T123:C123:slack-route-event',
        decision: 'approve',
        channelAlias,
      })
    )
  })

  it('rate limits repeated provider callbacks before control-api work', async () => {
    const body = JSON.stringify({
      callback_query: {
        id: 'tg-event',
        data: `approve:${APPROVAL_ID}`,
        from: { id: 123 },
        message: { chat: { id: 456 } },
      },
    })
    const cfg = {
      ...baseConfig,
      telegramWebhookSecret: 'telegram-secret',
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 1,
    }

    const first = await postWebhook(cfg, 'telegram', body, {
      'x-telegram-bot-api-secret-token': 'telegram-secret',
      'x-forwarded-for': '203.0.113.44',
    })
    const second = await postWebhook(cfg, 'telegram', body, {
      'x-telegram-bot-api-secret-token': 'telegram-secret',
      'x-forwarded-for': '203.0.113.44',
    })

    expect(first.status).toBe(200)
    expect(second).toEqual({
      status: 429,
      body: { error: 'rate_limited' },
    })
    expect(submitMcpHostDecision).toHaveBeenCalledTimes(1)
  })

  it('rate limits Slack callbacks independently per target id', async () => {
    const slackBody = (triggerId: string) =>
      JSON.stringify({
        actions: [{ value: `approve:${APPROVAL_ID}` }],
        user: { id: 'U123' },
        team: { id: 'T123' },
        channel: { id: 'C123' },
        trigger_id: triggerId,
      })
    const cfg = {
      ...baseConfig,
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 1,
    }
    const headers = {
      'x-slack-request-timestamp': `${Math.floor(Date.now() / 1000)}`,
      'x-slack-signature': 'v0=signature',
      'x-forwarded-for': '203.0.113.55',
    }

    const first = await postWebhook(
      cfg,
      'slack',
      slackBody('slack-rate-event-a-1'),
      headers,
      'slack:rate-target-a'
    )
    const second = await postWebhook(
      cfg,
      'slack',
      slackBody('slack-rate-event-b-1'),
      headers,
      'slack:rate-target-b'
    )
    const third = await postWebhook(
      cfg,
      'slack',
      slackBody('slack-rate-event-a-2'),
      headers,
      'slack:rate-target-a'
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(third).toEqual({
      status: 429,
      body: { error: 'rate_limited' },
    })
    expect(verifySlackTargetSignature).toHaveBeenCalledTimes(2)
  })

  it('hands Slack threaded messages to channel-reader when configured', async () => {
    vi.mocked(verifySlackTargetSignature).mockResolvedValueOnce({
      ok: true,
      hostRef: 'sandbox-recipes/figure-d-recipe',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: true,
      replyOnlyWhenMentioned: true,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev-message-1',
      event: {
        type: 'message',
        user: 'U123',
        channel: 'C123',
        text: '<@UAPP> hello',
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
      expect(handoffSlackMessageToChannelReader).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          hostRef: 'sandbox-recipes/figure-d-recipe',
          communicationChannelRef: 'channels/slack-app',
          providerWorkspaceId: 'T123',
          replyInThreads: true,
          replyOnlyWhenMentioned: true,
        }),
        expect.objectContaining({
          content: 'hello',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
          providerEventId: 'slack:T123:C123:1710000000.000001',
          providerMessageTs: '1710000000.000001',
        })
      )
    })
  })

  it('hands Teams workflow result button actions to channel-reader without a mention', async () => {
    const body = JSON.stringify({
      type: 'message',
      id: 'button-activity-1',
      text: `workflow_result_run:${WORKFLOW_RUN_ID}`,
      value: {
        action: `workflow_result_run:${WORKFLOW_RUN_ID}`,
      },
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'teams-user-1' },
      conversation: {
        id: '19:channel-1@thread.tacv2;messageid=root-post-1',
        conversationType: 'channel',
        tenantId: 'tenant-1',
      },
      channelData: {
        tenant: { id: 'tenant-1' },
        channel: { id: '19:channel-1@thread.tacv2' },
      },
    })

    const response = await postWebhook(
      { ...baseConfig, enabledMedia: new Set(['teams']) },
      'teams',
      body,
      { authorization: 'Bearer teams-token' },
      TEAMS_TARGET_ID
    )

    expect(response.status).toBe(200)
    await vi.waitFor(() => {
      expect(handoffTeamsMessageToChannelReader).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          hostRef: 'sandbox-recipes/figure-d-recipe',
          communicationChannelRef: 'channels/teams-bot',
          providerWorkspaceId: 'tenant-1',
          replyOnlyWhenMentioned: true,
        }),
        expect.objectContaining({
          content: 'Download the completed workflow result',
          workflowRunId: WORKFLOW_RUN_ID,
          providerUserId: 'teams-user-1',
          providerWorkspaceId: 'tenant-1',
          providerChannelId: '19:channel-1@thread.tacv2',
          providerConversationId: '19:channel-1@thread.tacv2;messageid=root-post-1',
          providerReplyToMessageId: 'root-post-1',
          providerMessageTs: 'button-activity-1',
        })
      )
    })
  })

  it('hands accepted Teams file consent invokes to channel-reader', async () => {
    const body = JSON.stringify({
      type: 'invoke',
      name: 'fileConsent/invoke',
      id: 'consent-activity-1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'teams-user-1' },
      conversation: {
        id: 'personal-conversation-1',
        conversationType: 'personal',
        tenantId: 'tenant-1',
      },
      channelData: { tenant: { id: 'tenant-1' } },
      value: {
        action: 'accept',
        context: { workflowRunId: WORKFLOW_RUN_ID, artifactName: 'result.pdf' },
        uploadInfo: {
          contentUrl: 'https://tenant.sharepoint.com/result.pdf',
          uploadUrl: 'https://tenant.sharepoint.com/upload-session',
          uniqueId: 'file-1',
          name: 'result.pdf',
          fileType: 'pdf',
        },
      },
    })

    const response = await postWebhook(
      { ...baseConfig, enabledMedia: new Set(['teams']) },
      'teams',
      body,
      { authorization: 'Bearer teams-token' },
      TEAMS_TARGET_ID
    )

    expect(response.status).toBe(200)
    await vi.waitFor(() => {
      expect(handoffTeamsFileConsentToChannelReader).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ hostRef: 'sandbox-recipes/figure-d-recipe' }),
        expect.objectContaining({
          action: 'accept',
          workflowRunId: WORKFLOW_RUN_ID,
          artifactName: 'result.pdf',
          providerConversationId: 'personal-conversation-1',
        })
      )
    })
  })

  it.each([
    {
      conversationType: 'channel',
      conversationId: '19:channel-1@thread.tacv2',
      providerChannelId: '19:channel-1@thread.tacv2',
      channel: { id: '19:channel-1@thread.tacv2' },
    },
    {
      conversationType: 'groupChat',
      conversationId: '19:group-chat-1@thread.v2',
      providerChannelId: '19:group-chat-1@thread.v2',
      channel: undefined,
    },
    {
      conversationType: 'personal',
      conversationId: 'personal-conversation-1',
      providerChannelId: 'personal-conversation-1',
      channel: undefined,
    },
  ])(
    'hands Teams tool actions from $conversationType chats through without a mention',
    async ({ conversationType, conversationId, providerChannelId, channel }) => {
      const body = JSON.stringify({
        type: 'message',
        id: 'button-activity-tool-1',
        text: 'Approve',
        value: { action: 'tool:a:abcdefghijklmnop' },
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        from: { id: 'teams-user-1' },
        conversation: {
          id: conversationId,
          conversationType,
          tenantId: 'tenant-1',
        },
        replyToId: 'root-post-1',
        channelData: {
          tenant: { id: 'tenant-1' },
          ...(channel ? { channel } : {}),
        },
      })

      const response = await postWebhook(
        { ...baseConfig, enabledMedia: new Set(['teams']) },
        'teams',
        body,
        { authorization: 'Bearer teams-token' },
        TEAMS_TARGET_ID
      )

      expect(response.status).toBe(200)
      await vi.waitFor(() => {
        expect(handoffTeamsMessageToChannelReader).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({ replyOnlyWhenMentioned: true }),
          expect.objectContaining({
            content: 'tool:a:abcdefghijklmnop',
            providerUserId: 'teams-user-1',
            providerChannelId,
            providerConversationId: conversationId,
            providerReplyToMessageId: 'root-post-1',
          })
        )
      })
    }
  )

  it('hands Slack tool approval actions to channel-reader without a required mention', async () => {
    vi.mocked(verifySlackTargetSignature).mockResolvedValueOnce({
      ok: true,
      hostRef: 'sandbox-recipes/figure-d-recipe',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: true,
      replyOnlyWhenMentioned: true,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
    const payload = {
      type: 'block_actions',
      trigger_id: 'trigger-tool-1',
      user: { id: 'U123' },
      team: { id: 'T123' },
      channel: { id: 'C123' },
      message: { ts: '1710000000.000002', thread_ts: '1710000000.000001' },
      actions: [{ value: 'tool:d:abcdefghijklmnop' }],
    }
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
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
    await vi.waitFor(() => {
      expect(handoffSlackMessageToChannelReader).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ replyOnlyWhenMentioned: true }),
        expect.objectContaining({
          content: 'tool:d:abcdefghijklmnop',
          providerUserId: 'U123',
          providerChannelId: 'C123',
          providerMessageTs: '1710000000.000002',
          threadTs: '1710000000.000001',
        })
      )
    })
  })

  it('preserves leading user mentions in Slack message events', async () => {
    vi.mocked(verifySlackTargetSignature).mockResolvedValueOnce({
      ok: true,
      hostRef: 'sandbox-recipes/figure-d-recipe',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: false,
      replyOnlyWhenMentioned: false,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev-message-human-mention',
      event: {
        type: 'message',
        user: 'U123',
        channel: 'C123',
        text: '<@U456> can you check this ticket?',
        ts: '1710000000.000004',
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
      expect(handoffSlackMessageToChannelReader).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          communicationChannelRef: 'channels/slack-app',
          replyOnlyWhenMentioned: false,
        }),
        expect.objectContaining({
          content: '<@U456> can you check this ticket?',
          providerUserId: 'U123',
          providerChannelId: 'C123',
          providerEventId: 'slack:T123:C123:1710000000.000004',
        })
      )
    })
  })

  it('hands Slack inline approval commands to channel-reader without requiring app mentions', async () => {
    vi.mocked(verifySlackTargetSignature).mockResolvedValueOnce({
      ok: true,
      hostRef: 'sandbox-recipes/figure-d-recipe',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: true,
      replyOnlyWhenMentioned: true,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev-message-approval-command',
      event: {
        type: 'message',
        user: 'U123',
        channel: 'C123',
        text: '\\approve research-summary-workflow',
        ts: '1710000000.000003',
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
      expect(handoffSlackMessageToChannelReader).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          communicationChannelRef: 'channels/slack-app',
          replyOnlyWhenMentioned: true,
        }),
        expect.objectContaining({
          content: '\\approve research-summary-workflow',
          providerChannelId: 'C123',
          providerEventId: 'slack:T123:C123:1710000000.000003',
        })
      )
    })
  })

  it('ignores Slack app_mention envelopes when mention is not required', async () => {
    vi.mocked(verifySlackTargetSignature).mockResolvedValueOnce({
      ok: true,
      hostRef: 'sandbox-recipes/figure-d-recipe',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: false,
      replyOnlyWhenMentioned: false,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev-app-mention-no-mention-mode',
      event: {
        type: 'app_mention',
        user: 'U123',
        channel: 'C123',
        text: '<@UAPP> hello',
        ts: '1710000998.000001',
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

    expect(response).toEqual({
      status: 200,
      body: { ok: true, ignored: true },
    })
    expect(handoffSlackMessageToChannelReader).not.toHaveBeenCalled()
  })

  it('dedupes Slack message and app_mention envelopes for the same message', async () => {
    vi.mocked(verifySlackTargetSignature).mockResolvedValue({
      ok: true,
      hostRef: 'sandbox-recipes/figure-d-recipe',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: false,
      replyOnlyWhenMentioned: true,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
    const slackBody = (eventType: 'app_mention' | 'message', eventId: string) =>
      JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event_id: eventId,
        event: {
          type: eventType,
          user: 'U123',
          channel: 'C123',
          text: '<@UAPP> hello',
          ts: '1710000999.000001',
        },
      })
    const headers = {
      'x-slack-request-timestamp': `${Math.floor(Date.now() / 1000)}`,
      'x-slack-signature': 'v0=signature',
    }

    const first = await postWebhook(
      baseConfig,
      'slack',
      slackBody('app_mention', 'Ev-app-mention-dedupe'),
      headers,
      SLACK_TARGET_ID
    )
    await vi.waitFor(() => {
      expect(handoffSlackMessageToChannelReader).toHaveBeenCalledTimes(1)
    })
    const second = await postWebhook(
      baseConfig,
      'slack',
      slackBody('message', 'Ev-message-dedupe'),
      headers,
      SLACK_TARGET_ID
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(handoffSlackMessageToChannelReader).toHaveBeenCalledTimes(1)
  })

  it('strips Slack mentions when a message envelope wins app_mention dedupe', async () => {
    vi.mocked(verifySlackTargetSignature).mockResolvedValue({
      ok: true,
      hostRef: 'sandbox-recipes/figure-d-recipe',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: false,
      replyOnlyWhenMentioned: true,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
    const slackBody = (eventType: 'app_mention' | 'message', eventId: string) =>
      JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event_id: eventId,
        event: {
          type: eventType,
          user: 'U123',
          channel: 'C123',
          text: '<@UAPP> hello',
          ts: '1710000999.000002',
        },
      })
    const headers = {
      'x-slack-request-timestamp': `${Math.floor(Date.now() / 1000)}`,
      'x-slack-signature': 'v0=signature',
    }

    const first = await postWebhook(
      baseConfig,
      'slack',
      slackBody('message', 'Ev-message-dedupe-first'),
      headers,
      SLACK_TARGET_ID
    )
    await vi.waitFor(() => {
      expect(handoffSlackMessageToChannelReader).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({
          content: 'hello',
          providerEventId: 'slack:T123:C123:1710000999.000002',
        })
      )
    })
    const second = await postWebhook(
      baseConfig,
      'slack',
      slackBody('app_mention', 'Ev-app-mention-dedupe-second'),
      headers,
      SLACK_TARGET_ID
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(handoffSlackMessageToChannelReader).toHaveBeenCalledTimes(1)
  })

  it('passes Slack thread context to channel-reader for app mentions', async () => {
    vi.mocked(verifySlackTargetSignature).mockResolvedValueOnce({
      ok: true,
      hostRef: 'sandbox-recipes/figure-d-recipe',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: true,
      replyOnlyWhenMentioned: true,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev-message-2',
      event: {
        type: 'app_mention',
        user: 'U123',
        channel: 'C123',
        text: '<@UAPP> hello again',
        ts: '1710000001.000001',
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
      expect(handoffSlackMessageToChannelReader).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          hostRef: 'sandbox-recipes/figure-d-recipe',
          communicationChannelRef: 'channels/slack-app',
          replyInThreads: true,
          replyOnlyWhenMentioned: true,
        }),
        expect.objectContaining({
          content: 'hello again',
          providerChannelId: 'C123',
          providerEventId: 'slack:T123:C123:1710000001.000001',
          providerMessageTs: '1710000001.000001',
          threadTs: null,
        })
      )
    })
  })

  describe('Slack and Teams decision feedback', () => {
    const SLACK_APPROVAL_TS = '1710000000.000001'

    function slackAction(options: {
      decision?: 'approve' | 'deny'
      user?: string
      eventId: string
      feedback?: boolean
      approvalId?: string
      /** The approval message is itself a reply in this Slack thread. */
      threadTs?: string
    }): string {
      return JSON.stringify({
        type: 'block_actions',
        actions: [
          { value: `${options.decision ?? 'approve'}:${options.approvalId ?? APPROVAL_ID}` },
        ],
        user: { id: options.user ?? 'U123' },
        team: { id: 'T123' },
        channel: { id: 'C123' },
        ...(options.feedback === false ? {} : { container: { message_ts: SLACK_APPROVAL_TS } }),
        ...(options.threadTs
          ? { message: { ts: SLACK_APPROVAL_TS, thread_ts: options.threadTs } }
          : {}),
        trigger_id: options.eventId,
      })
    }

    /** The Slack target verification answer, with or without `replyInThreads`. */
    function slackTargetReplies(replyInThreads: boolean | undefined): void {
      vi.mocked(verifySlackTargetSignature).mockResolvedValue({
        ok: true,
        hostRef: 'sandbox-recipes/figure-d-recipe',
        communicationChannelRef: 'channels/slack-app',
        providerWorkspaceId: 'T123',
        channelName: 'slack-app',
        channelNamespace: 'channels',
        ...(replyInThreads === undefined ? {} : { replyInThreads }),
      })
    }

    function slackSendThreads(): Array<string | null | undefined> {
      return vi
        .mocked(sendSlackTargetMessage)
        .mock.calls.map(call => (call[1] as { threadTs?: string | null }).threadTs)
    }

    async function postSlack(body: string): Promise<{ status: number; body: unknown }> {
      return postWebhook(
        baseConfig,
        'slack',
        body,
        {
          'x-slack-request-timestamp': `${Math.floor(Date.now() / 1000)}`,
          'x-slack-signature': 'v0=signature',
        },
        SLACK_TARGET_ID
      )
    }

    function teamsAction(
      eventId: string,
      options: { decision?: 'approve' | 'deny'; user?: string } = {}
    ): string {
      const decision = options.decision ?? 'approve'
      return JSON.stringify({
        type: 'message',
        id: eventId,
        text: decision === 'deny' ? 'Deny' : 'Approve',
        value: {
          action:
            `${decision}:${APPROVAL_ID}:sandbox-recipes/research-summary-workflow:` +
            '0123456789abcdef',
        },
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        from: { id: options.user ?? 'teams-user-1' },
        conversation: {
          id: '19:channel-1@thread.tacv2;messageid=root-post-1',
          conversationType: 'channel',
          tenantId: 'tenant-1',
        },
        channelData: {
          tenant: { id: 'tenant-1' },
          channel: { id: '19:channel-1@thread.tacv2' },
        },
      })
    }

    /** Lets the background promise chains settle without moving fake time. */
    async function settle(): Promise<void> {
      for (let round = 0; round < 3; round += 1) {
        await new Promise(resolve => setImmediate(resolve))
      }
    }

    function threadTexts(): string[] {
      return vi
        .mocked(sendSlackTargetMessage)
        .mock.calls.map(call => (call[1] as { text: string }).text)
    }

    function slackUpdateTexts(): string[] {
      return vi
        .mocked(updateSlackTargetMessage)
        .mock.calls.map(call => (call[1] as { text: string }).text)
    }

    function teamsUpdateTexts(): string[] {
      return vi
        .mocked(updateTeamsTargetMessage)
        .mock.calls.map(call => (call[1] as { text: string }).text)
    }

    /**
     * The texts of the Teams notices. Every call is checked for its exact
     * arguments: the card's ids from the webhook payload and no threading flag
     * (control-api decides the placement).
     */
    function teamsSendTexts(): string[] {
      return vi.mocked(sendTeamsTargetMessage).mock.calls.map(call => {
        const params = call[1] as { text: string }
        expect(params).toEqual({
          targetId: TEAMS_TARGET_ID,
          conversationId: '19:channel-1@thread.tacv2',
          threadConversationId: '19:channel-1@thread.tacv2;messageid=root-post-1',
          replyToId: 'root-post-1',
          serviceUrl: 'https://smba.trafficmanager.net/amer/',
          text: params.text,
        })
        return params.text
      })
    }

    async function postTeams(body: string): Promise<{ status: number; body: unknown }> {
      return postWebhook(
        { ...baseConfig, enabledMedia: new Set(['teams']) },
        'teams',
        body,
        { authorization: 'Bearer teams-token' },
        TEAMS_TARGET_ID
      )
    }

    const media = [{ medium: 'slack' as const }, { medium: 'teams' as const }]

    beforeEach(() => {
      // Each scenario queues its own Host answers; none leaks into the next.
      // Any submit beyond the queued answers is answered as recorded, so a
      // decision sent again would rewrite the approval message.
      vi.mocked(submitMcpHostDecision).mockReset().mockResolvedValue({ ok: true })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('answers the webhook while fake timers are installed', async () => {
      const response = await postSlack(slackAction({ eventId: 'slack-fake-timer-probe' }))

      expect(response).toEqual({ status: 200, body: { ok: true } })
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledOnce()
    })

    it.each([
      { medium: 'slack' as const, eventId: 'slack-first-403-stale' },
      { medium: 'teams' as const, eventId: 'teams-first-403-stale' },
    ])(
      'marks the approval stale when the consult answers approval_not_pending ($medium)',
      async ({ medium, eventId }) => {
        vi.mocked(submitMcpHostDecision).mockResolvedValueOnce({
          ok: false,
          status: 403,
          error: 'approval_not_pending',
        })

        if (medium === 'slack') await postSlack(slackAction({ eventId }))
        else await postTeams(teamsAction(eventId))
        await settle()

        expect(submitMcpHostDecision).toHaveBeenCalledOnce()
        if (medium === 'slack') {
          expect(slackUpdateTexts()).toEqual(['This workflow approval is no longer pending.'])
          expect(sendSlackTargetMessage).not.toHaveBeenCalled()
        } else {
          expect(teamsUpdateTexts()).toEqual(['This workflow approval is no longer pending.'])
          expect(sendTeamsTargetMessage).not.toHaveBeenCalled()
        }
      }
    )

    it('logs a refused Teams notice and leaves the card alone', async () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      vi.mocked(sendTeamsTargetMessage).mockResolvedValue({
        ok: false,
        status: 404,
        error: 'not_found',
      })
      vi.mocked(submitMcpHostDecision).mockResolvedValueOnce({
        ok: false,
        status: 500,
        error: 'mcp_host_decision_failed_500',
      })

      const response = await postTeams(teamsAction('teams-send-refused'))
      await settle()

      expect(response).toEqual({ status: 200, body: { ok: true } })
      expect(teamsSendTexts()).toEqual([
        'I could not approve this workflow approval. Try again in a moment.',
      ])
      expect(teamsUpdateTexts()).toEqual([])
      const warnings = consoleWarn.mock.calls.map(call => JSON.parse(String(call[0])))
      expect(warnings).toContainEqual(
        expect.objectContaining({
          msg: 'teams decision feedback failed',
          action: 'send_failure',
          status: 404,
          error: 'not_found',
        })
      )
    })

    it.each([
      {
        name: 'a control-api refusal',
        result: { ok: false, status: 409, error: 'approval_requester_mismatch' },
        text: 'I could not approve this workflow approval. Try again in a moment.',
      },
      {
        name: 'a can-approve denial',
        result: { ok: false, status: 403, error: 'cross_bot_mismatch' },
        text: 'You are not allowed to decide this workflow approval from this Teams conversation.',
      },
    ])('keeps the Teams card when the decision gets $name', async ({ result, text }) => {
      vi.mocked(submitMcpHostDecision).mockResolvedValueOnce(result)

      await postTeams(teamsAction(`teams-first-${result.error}`))
      await settle()

      expect(submitMcpHostDecision).toHaveBeenCalledOnce()
      expect(teamsSendTexts()).toEqual([text])
      expect(updateTeamsTargetMessage).not.toHaveBeenCalled()
    })

    const denyClicks = [
      { medium: 'slack' as const, user: 'U123' },
      { medium: 'teams' as const, user: 'teams-user-1' },
    ]

    async function clickDeny(medium: 'slack' | 'teams', eventId: string): Promise<void> {
      if (medium === 'slack') await postSlack(slackAction({ eventId, decision: 'deny' }))
      else await postTeams(teamsAction(eventId, { decision: 'deny' }))
      await settle()
    }

    it.each(denyClicks)(
      'rewrites the approval message as denied when the Host records a Deny ($medium)',
      async ({ medium, user }) => {
        await clickDeny(medium, `${medium}-deny-recorded`)

        expect(submitMcpHostDecision).toHaveBeenCalledOnce()
        expect(vi.mocked(submitMcpHostDecision).mock.calls[0][1]).toMatchObject({
          providerUserId: user,
          decision: 'deny',
        })
        if (medium === 'slack') {
          expect(slackUpdateTexts()).toEqual(['Denied. Workflow approval recorded.'])
          expect(sendSlackTargetMessage).not.toHaveBeenCalled()
        } else {
          expect(teamsUpdateTexts()).toEqual(['Denied. Workflow approval recorded.'])
          expect(sendTeamsTargetMessage).not.toHaveBeenCalled()
        }
      }
    )

    it.each(denyClicks)(
      'reports a refused Deny with the deny wording and keeps the approval message ($medium)',
      async ({ medium, user }) => {
        vi.mocked(submitMcpHostDecision).mockResolvedValueOnce({
          ok: false,
          status: 409,
          error: 'approval_requester_mismatch',
        })

        await clickDeny(medium, `${medium}-deny-refused`)

        expect(submitMcpHostDecision).toHaveBeenCalledOnce()
        expect(vi.mocked(submitMcpHostDecision).mock.calls[0][1]).toMatchObject({
          providerUserId: user,
          decision: 'deny',
        })
        if (medium === 'slack') {
          expect(threadTexts()).toEqual([
            '<@U123> I could not deny this workflow approval. Try again in a moment.',
          ])
          expect(slackUpdateTexts()).toEqual([])
        } else {
          expect(teamsSendTexts()).toEqual([
            'I could not deny this workflow approval. Try again in a moment.',
          ])
          expect(teamsUpdateTexts()).toEqual([])
        }
      }
    )

    describe('Slack notice placement follows the reply-in-threads setting', () => {
      const placements = [
        { name: 'on', replyInThreads: true, threadTs: undefined, expected: SLACK_APPROVAL_TS },
        { name: 'off', replyInThreads: false, threadTs: undefined, expected: undefined },
        { name: 'unset', replyInThreads: undefined, threadTs: undefined, expected: undefined },
        {
          name: 'on, approval message in a thread',
          replyInThreads: true,
          threadTs: '1709999999.000009',
          expected: '1709999999.000009',
        },
        {
          name: 'off, approval message in a thread',
          replyInThreads: false,
          threadTs: '1709999999.000009',
          expected: undefined,
        },
      ]

      it.each(placements)(
        'places the failure notice with the setting $name',
        async ({ name, replyInThreads, threadTs, expected }) => {
          slackTargetReplies(replyInThreads)
          vi.mocked(submitMcpHostDecision).mockResolvedValueOnce({
            ok: false,
            status: 504,
            error: 'mcp_host_unavailable',
          })

          await postSlack(slackAction({ eventId: `slack-placement-failure-${name}`, threadTs }))
          await settle()

          expect(threadTexts()).toEqual([
            '<@U123> I could not approve this workflow approval. Try again in a moment.',
          ])
          expect(slackSendThreads()).toEqual([expected])
        }
      )
    })

    it.each(media)(
      'sends no message for a refused decision without feedback context ($medium)',
      async ({ medium }) => {
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.mocked(submitMcpHostDecision).mockResolvedValueOnce({
          ok: false,
          status: 500,
          error: 'mcp_host_decision_failed_500',
        })

        if (medium === 'slack') {
          await postSlack(slackAction({ eventId: 'slack-no-feedback', feedback: false }))
        } else {
          // A Bot Framework activity without serviceUrl is refused with 400
          // before any submit. The generic decision shape has no serviceUrl and
          // no channel, so it is the one Teams payload that reaches the handler
          // without a feedback context; this pins what the handler does then.
          await postTeams(
            JSON.stringify({
              decision: 'approve',
              approvalRequestId: APPROVAL_ID,
              providerUserId: 'teams-user-1',
              providerEventId: 'teams-no-feedback',
            })
          )
        }
        await settle()
        await vi.advanceTimersByTimeAsync(120_000)
        await settle()

        // Witness: the decision was submitted once and its refusal was logged.
        expect(submitMcpHostDecision).toHaveBeenCalledOnce()
        const warnings = consoleWarn.mock.calls.map(call => JSON.parse(String(call[0])))
        expect(warnings).toContainEqual(
          expect.objectContaining({
            msg: 'provider decision submission failed after acknowledgement',
            medium,
            status: 500,
            error: 'mcp_host_decision_failed_500',
          })
        )
        expect(sendSlackTargetMessage).not.toHaveBeenCalled()
        expect(updateSlackTargetMessage).not.toHaveBeenCalled()
        expect(sendTeamsTargetMessage).not.toHaveBeenCalled()
        expect(updateTeamsTargetMessage).not.toHaveBeenCalled()
      }
    )

    describe('synchronous answers to an older Host admission refusal', () => {
      const HOST_REF = 'sandbox-recipes/figure-d-recipe'

      /**
       * A Host stub that answers every request with the admission refusal an
       * older MCP Host sent: status 429, its error code, and a wait in the body
       * and in Retry-After. The real client reads it; the reader relays it as
       * a generic failure.
       */
      async function startRefusingHost(): Promise<{
        baseUrl: string
        requests: string[]
        close: () => Promise<void>
      }> {
        const requests: string[] = []
        const host = createHttpServer((req, res) => {
          requests.push(`${req.method} ${req.url}`)
          req.resume()
          req.on('end', () => {
            res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
            res.end(
              JSON.stringify({ error: 'runtime_service_admission_limited', retryAfterSeconds: 7 })
            )
          })
        })
        await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve))
        const { port } = host.address() as AddressInfo
        return {
          baseUrl: `http://127.0.0.1:${port}`,
          requests,
          close: () => new Promise<void>(resolve => host.close(() => resolve())),
        }
      }

      async function postTelegram(cfg: ReaderConfig, payload: unknown): Promise<Response> {
        const server = createServer({ ...cfg, telegramWebhookSecret: 'telegram-secret' })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address() as AddressInfo
        try {
          const response = await fetch(`http://127.0.0.1:${port}/webhooks/telegram`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-telegram-bot-api-secret-token': 'telegram-secret',
            },
            body: JSON.stringify(payload),
          })
          await response.clone().arrayBuffer()
          return response
        } finally {
          await new Promise<void>(resolve => server.close(() => resolve()))
        }
      }

      async function actualMcpHostClient() {
        return vi.importActual<typeof import('../src/mcpHostClient.js')>('../src/mcpHostClient.js')
      }

      it('relays a synchronous decision refused with 429 without Retry-After', async () => {
        const host = await startRefusingHost()
        const actual = await actualMcpHostClient()
        vi.mocked(submitMcpHostDecision).mockImplementationOnce(actual.submitMcpHostDecision)
        try {
          const response = await postTelegram(
            { ...baseConfig, mcpHostTargets: [{ hostRef: HOST_REF, baseUrl: host.baseUrl }] },
            {
              callback_query: {
                id: 'tg-host-429',
                data: `approve:${APPROVAL_ID}:${HOST_REF}`,
                from: { id: 123 },
                message: { chat: { id: 456 } },
              },
            }
          )

          expect(response.status).toBe(429)
          expect(response.headers.get('retry-after')).toBeNull()
          expect(await response.json()).toEqual({
            ok: false,
            error: 'runtime_service_admission_limited',
          })
        } finally {
          await host.close()
        }
        // Witness: the reader asked the Host stub exactly once.
        expect(host.requests).toEqual(['POST /v1/runtime/workflow-approvals/decide'])
      })

      it('relays a synchronous enrollment refused with 429 without Retry-After', async () => {
        const host = await startRefusingHost()
        const actual = await actualMcpHostClient()
        vi.mocked(submitMcpHostEnrollment).mockImplementationOnce(actual.submitMcpHostEnrollment)
        // The Telegram enrollment carries no channel ref; the client asks
        // control-api for it before it calls the Host.
        vi.mocked(resolveCommunicationChannelRef).mockResolvedValueOnce({
          ok: true,
          communicationChannelRef: 'channels/telegram-bot',
        })
        try {
          const response = await postTelegram(
            { ...baseConfig, mcpHostRef: HOST_REF, mcpHostBaseUrl: host.baseUrl },
            {
              message: {
                text: '/start nonce_1234567890123456',
                from: { id: 123 },
                chat: { id: 456 },
              },
            }
          )

          expect(response.status).toBe(429)
          expect(response.headers.get('retry-after')).toBeNull()
          expect(await response.json()).toEqual({
            ok: false,
            error: 'runtime_service_admission_limited',
          })
        } finally {
          await host.close()
        }
        // Witness: the reader asked the Host stub exactly once.
        expect(resolveCommunicationChannelRef).toHaveBeenCalledOnce()
        expect(host.requests).toEqual([
          'POST /v1/runtime/workflow-approval-mediums/link-sessions/confirm',
        ])
      })
    })
  })
})
