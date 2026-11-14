import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  sendSlackTargetMessage: vi.fn().mockResolvedValue({ ok: true }),
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
let resolveTeamsTarget: ReturnType<typeof vi.fn>
let sendSlackTargetMessage: ReturnType<typeof vi.fn>
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
      resolveTeamsTarget,
      sendSlackTargetMessage,
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
      text: 'This workflow approval is no longer pending. Trigger the workflow again to request approval.',
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
      text: 'This workflow approval is no longer pending. Trigger the workflow again to request approval.',
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

  describe('background decision retry after a Host admission limit', () => {
    const admissionLimited = (retryAfterSeconds: number) => ({
      ok: false,
      status: 429,
      error: 'runtime_service_admission_limited',
      retryAfterSeconds,
    })

    function slackAction(options: {
      decision?: 'approve' | 'deny'
      user?: string
      eventId: string
      feedback?: boolean
      approvalId?: string
    }): string {
      return JSON.stringify({
        type: 'block_actions',
        actions: [
          { value: `${options.decision ?? 'approve'}:${options.approvalId ?? APPROVAL_ID}` },
        ],
        user: { id: options.user ?? 'U123' },
        team: { id: 'T123' },
        channel: { id: 'C123' },
        ...(options.feedback === false ? {} : { container: { message_ts: '1710000000.000001' } }),
        trigger_id: options.eventId,
      })
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

    function teamsAction(eventId: string): string {
      return JSON.stringify({
        type: 'message',
        id: eventId,
        text: 'Approve',
        value: {
          action:
            `approve:${APPROVAL_ID}:sandbox-recipes/research-summary-workflow:` +
            '0123456789abcdef',
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

    let decisionAdmissionRetries: typeof import('../src/decisionAdmissionRetry.js').decisionAdmissionRetries

    beforeAll(async () => {
      ;({ decisionAdmissionRetries } = await import('../src/decisionAdmissionRetry.js'))
    })

    beforeEach(() => {
      // Each scenario queues its own Host answers; none leaks into the next.
      vi.mocked(submitMcpHostDecision).mockReset().mockResolvedValue({ ok: true })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })

    afterEach(() => {
      decisionAdmissionRetries.cancelAll()
      vi.useRealTimers()
    })

    it('answers the webhook while fake timers are installed', async () => {
      const response = await postSlack(slackAction({ eventId: 'slack-fake-timer-probe' }))

      expect(response).toEqual({ status: 200, body: { ok: true } })
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledOnce()
    })

    it('sends a Slack decision again once after the wait and records it', async () => {
      vi.mocked(submitMcpHostDecision)
        .mockResolvedValueOnce(admissionLimited(7))
        .mockResolvedValueOnce({ ok: true })

      const response = await postSlack(slackAction({ eventId: 'slack-retry-ok' }))
      await settle()

      expect(response).toEqual({ status: 200, body: { ok: true } })
      expect(threadTexts()).toEqual([
        '<@U123> The assistant is busy. Your decision will be sent again in 7 seconds. If the approval message has not changed a minute from now, choose again.',
      ])
      expect(updateSlackTargetMessage).not.toHaveBeenCalled()
      expect(decisionAdmissionRetries.size).toBe(1)

      await vi.advanceTimersByTimeAsync(6_999)
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(2)
      const [first, retry] = vi.mocked(submitMcpHostDecision).mock.calls
      expect(retry?.[1]).toEqual(first?.[1])
      expect((retry?.[1] as { providerEventId: string }).providerEventId).toBe(
        'slack:T123:C123:slack-retry-ok'
      )
      expect(slackUpdateTexts()).toEqual(['Approved. Workflow approval recorded.'])
      expect(decisionAdmissionRetries.size).toBe(0)

      await vi.advanceTimersByTimeAsync(120_000)
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(2)
    })

    it('reports the second wait when the retry is refused again and arms nothing more', async () => {
      vi.mocked(submitMcpHostDecision)
        .mockResolvedValueOnce(admissionLimited(7))
        .mockResolvedValueOnce(admissionLimited(9))

      await postSlack(slackAction({ eventId: 'slack-retry-refused' }))
      await settle()
      await vi.advanceTimersByTimeAsync(7_000)
      await settle()

      expect(submitMcpHostDecision).toHaveBeenCalledTimes(2)
      expect(threadTexts()).toEqual([
        '<@U123> The assistant is busy. Your decision will be sent again in 7 seconds. If the approval message has not changed a minute from now, choose again.',
        '<@U123> The assistant is busy. Try again in 9 seconds.',
      ])
      expect(decisionAdmissionRetries.size).toBe(0)

      await vi.advanceTimersByTimeAsync(60_000)
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(2)
    })

    it('marks the approval stale when the retry finds it no longer pending', async () => {
      vi.mocked(submitMcpHostDecision)
        .mockResolvedValueOnce(admissionLimited(7))
        .mockResolvedValueOnce({ ok: false, status: 409, error: 'approval_not_pending' })

      await postSlack(slackAction({ eventId: 'slack-retry-stale' }))
      await settle()
      await vi.advanceTimersByTimeAsync(7_000)
      await settle()

      expect(submitMcpHostDecision).toHaveBeenCalledTimes(2)
      expect(slackUpdateTexts()).toEqual([
        'This workflow approval is no longer pending. Trigger the workflow again to request approval.',
      ])
    })

    it('does not submit the same click again while its retry is armed', async () => {
      vi.mocked(submitMcpHostDecision)
        .mockResolvedValueOnce(admissionLimited(7))
        .mockResolvedValueOnce({ ok: true })

      await postSlack(slackAction({ eventId: 'slack-held-same' }))
      await settle()
      const response = await postSlack(slackAction({ eventId: 'slack-held-same' }))
      await settle()

      expect(response).toEqual({ status: 200, body: { ok: true } })
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(1)
      expect(threadTexts()).toHaveLength(1)
      expect(decisionAdmissionRetries.size).toBe(1)

      await vi.advanceTimersByTimeAsync(7_000)
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(2)
    })

    it('submits another user decision at once while a retry is armed; the retry still runs once', async () => {
      vi.mocked(submitMcpHostDecision)
        .mockResolvedValueOnce(admissionLimited(7))
        .mockResolvedValueOnce({ ok: false, status: 403, error: 'approval_requester_mismatch' })
        .mockResolvedValueOnce({ ok: true })

      await postSlack(slackAction({ eventId: 'slack-armed-first' }))
      await settle()
      await postSlack(slackAction({ eventId: 'slack-other-user', user: 'U999', decision: 'deny' }))
      await settle()

      // Another user's click is not held: it is submitted and control-api,
      // which accepts only the requester, refuses it. The armed retry stays.
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(2)
      expect(vi.mocked(submitMcpHostDecision).mock.calls[1]?.[1]).toMatchObject({
        providerUserId: 'U999',
        decision: 'deny',
      })
      expect(slackUpdateTexts()).toEqual([])
      expect(threadTexts()).toHaveLength(2)
      expect(threadTexts()[1]).toContain('<@U999>')
      expect(decisionAdmissionRetries.size).toBe(1)

      await vi.advanceTimersByTimeAsync(7_000)
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(3)
      expect(vi.mocked(submitMcpHostDecision).mock.calls[2]?.[1]).toMatchObject({
        providerUserId: 'U123',
        decision: 'approve',
      })
      expect(slackUpdateTexts()).toEqual(['Approved. Workflow approval recorded.'])
      await vi.advanceTimersByTimeAsync(60_000)
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(3)
    })

    it('holds the same user other decision while that user retry is armed; the first decision is sent', async () => {
      vi.mocked(submitMcpHostDecision)
        .mockResolvedValueOnce(admissionLimited(7))
        .mockResolvedValueOnce({ ok: true })

      await postSlack(slackAction({ eventId: 'slack-armed-approve' }))
      await settle()
      const response = await postSlack(
        slackAction({ eventId: 'slack-same-user-deny', decision: 'deny' })
      )
      await settle()

      expect(response).toEqual({ status: 200, body: { ok: true } })
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(1)
      expect(threadTexts()).toHaveLength(2)
      expect(threadTexts()[1]).toContain(
        'Your earlier decision for this workflow approval is still being sent.'
      )
      expect(decisionAdmissionRetries.size).toBe(1)

      await vi.advanceTimersByTimeAsync(7_000)
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(2)
      expect(vi.mocked(submitMcpHostDecision).mock.calls[1]?.[1]).toMatchObject({
        providerUserId: 'U123',
        decision: 'approve',
      })
      expect(slackUpdateTexts()).toEqual(['Approved. Workflow approval recorded.'])
    })

    it('arms one retry when two first attempts are refused', async () => {
      const pending: Array<(value: unknown) => void> = []
      vi.mocked(submitMcpHostDecision)
        .mockImplementationOnce(() => new Promise(resolve => pending.push(resolve)) as never)
        .mockImplementationOnce(() => new Promise(resolve => pending.push(resolve)) as never)
        .mockResolvedValueOnce({ ok: true })

      await postSlack(slackAction({ eventId: 'slack-race-1' }))
      await postSlack(slackAction({ eventId: 'slack-race-2' }))
      await settle()
      expect(pending).toHaveLength(2)
      pending[0]?.(admissionLimited(7))
      pending[1]?.(admissionLimited(7))
      await settle()

      expect(decisionAdmissionRetries.size).toBe(1)
      await vi.advanceTimersByTimeAsync(7_000)
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(3)
    })

    it('reports the wait without arming when 64 retries are already pending', async () => {
      const runners = Array.from({ length: 64 }, () => vi.fn())
      runners.forEach((run, index) => {
        const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
        expect(
          decisionAdmissionRetries.schedule(
            id,
            { providerUserId: 'U000', decision: 'approve' },
            30,
            run
          )
        ).toBe('scheduled')
      })
      vi.mocked(submitMcpHostDecision).mockResolvedValueOnce(admissionLimited(7))

      await postSlack(slackAction({ eventId: 'slack-full' }))
      await settle()

      expect(threadTexts()).toEqual(['<@U123> The assistant is busy. Try again in 7 seconds.'])
      expect(decisionAdmissionRetries.size).toBe(64)
      expect(submitMcpHostDecision).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(60_000)
      await settle()
      for (const run of runners) expect(run).toHaveBeenCalledOnce()
      expect(submitMcpHostDecision).toHaveBeenCalledOnce()
    })

    it('sends a Teams decision again once after the wait and records it', async () => {
      vi.mocked(submitMcpHostDecision)
        .mockResolvedValueOnce(admissionLimited(7))
        .mockResolvedValueOnce({ ok: true })

      const response = await postWebhook(
        { ...baseConfig, enabledMedia: new Set(['teams']) },
        'teams',
        teamsAction('teams-retry-ok'),
        { authorization: 'Bearer teams-token' },
        TEAMS_TARGET_ID
      )
      await settle()

      expect(response).toEqual({ status: 200, body: { ok: true } })
      expect(teamsUpdateTexts()).toEqual([
        'The assistant is busy. Your decision will be sent again in 7 seconds. If the approval message has not changed a minute from now, choose again.',
      ])

      await vi.advanceTimersByTimeAsync(7_000)
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(2)
      expect(teamsUpdateTexts()).toEqual([
        'The assistant is busy. Your decision will be sent again in 7 seconds. If the approval message has not changed a minute from now, choose again.',
        'Approved. Workflow approval recorded.',
      ])
    })

    it('retries a Slack decision without feedback context and sends no message', async () => {
      vi.mocked(submitMcpHostDecision)
        .mockResolvedValueOnce(admissionLimited(7))
        .mockResolvedValueOnce({ ok: true })

      await postSlack(slackAction({ eventId: 'slack-no-feedback', feedback: false }))
      await settle()
      await vi.advanceTimersByTimeAsync(7_000)
      await settle()

      // Witness: the retry ran.
      expect(submitMcpHostDecision).toHaveBeenCalledTimes(2)
      expect(sendSlackTargetMessage).not.toHaveBeenCalled()
      expect(updateSlackTargetMessage).not.toHaveBeenCalled()
    })

    it('answers a synchronous decision with 429 and Retry-After and does not retry it', async () => {
      vi.mocked(submitMcpHostDecision).mockResolvedValueOnce(admissionLimited(7))
      const server = createServer({ ...baseConfig, telegramWebhookSecret: 'telegram-secret' })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      try {
        const response = await fetch(`http://127.0.0.1:${port}/webhooks/telegram`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-telegram-bot-api-secret-token': 'telegram-secret',
          },
          body: JSON.stringify({
            callback_query: {
              id: 'tg-limited',
              data: `approve:${APPROVAL_ID}`,
              from: { id: 123 },
              message: { chat: { id: 456 } },
            },
          }),
        })

        expect(response.status).toBe(429)
        expect(response.headers.get('retry-after')).toBe('7')
        expect(await response.json()).toEqual({
          ok: false,
          error: 'runtime_service_admission_limited',
        })
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
      expect(decisionAdmissionRetries.size).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledOnce()
    })

    it('answers a synchronous enrollment with 429 and Retry-After and does not retry it', async () => {
      vi.mocked(submitMcpHostEnrollment).mockResolvedValueOnce(admissionLimited(9))
      const server = createServer({ ...baseConfig, telegramWebhookSecret: 'telegram-secret' })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      try {
        const response = await fetch(`http://127.0.0.1:${port}/webhooks/telegram`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-telegram-bot-api-secret-token': 'telegram-secret',
          },
          body: JSON.stringify({
            message: {
              text: '/start nonce_1234567890123456',
              from: { id: 123 },
              chat: { id: 456 },
            },
          }),
        })

        expect(response.status).toBe(429)
        expect(response.headers.get('retry-after')).toBe('9')
        expect(await response.json()).toEqual({
          ok: false,
          error: 'runtime_service_admission_limited',
        })
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
      expect(submitMcpHostEnrollment).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(60_000)
      await settle()
      expect(submitMcpHostEnrollment).toHaveBeenCalledOnce()
      expect(decisionAdmissionRetries.size).toBe(0)
    })

    it('reports a 429 without a usable wait with the generic text and no retry', async () => {
      vi.mocked(submitMcpHostDecision).mockResolvedValueOnce({
        ok: false,
        status: 429,
        error: 'runtime_service_admission_limited',
      })

      await postSlack(slackAction({ eventId: 'slack-malformed' }))
      await settle()

      expect(threadTexts()).toEqual([
        '<@U123> I could not approve this workflow approval. Try again in a moment.',
      ])
      expect(decisionAdmissionRetries.size).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      await settle()
      expect(submitMcpHostDecision).toHaveBeenCalledOnce()
    })
  })
})
