import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { encodeSlackTargetId } from '../src/utils/slackTargetId.js'
import { encodeTeamsTargetId } from '../src/utils/teamsTargetId.js'
import { MockGateway } from './mockGateway.js'

const READER_TOKEN = 'dev-wa-reader-token'

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

function authedGet(
  app: ReturnType<typeof createApp>,
  path: string,
  token = READER_TOKEN,
  service = 'workflow-approval-reader'
) {
  return request(app)
    .get(path)
    .set('authorization', `Bearer ${token}`)
    .set('x-service-token', service)
}

function authedPost(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  token = READER_TOKEN,
  service = 'workflow-approval-reader'
) {
  return request(app)
    .post(path)
    .set('authorization', `Bearer ${token}`)
    .set('x-service-token', service)
    .send(body)
}

const UUID = '00000000-0000-4000-8000-000000000001'

function canApproveUrl(channelAlias: string) {
  return `/api/v1/internal/workflow-approval-reader/approvals/${UUID}/can-approve?medium=telegram&providerUserId=12345&channelAlias=${channelAlias}`
}

function slackCanApproveUrl(channelAlias: string) {
  return `/api/v1/internal/workflow-approval-reader/approvals/${UUID}/can-approve?medium=slack&providerUserId=U123&providerWorkspaceId=T123&providerChannelId=D123&channelAlias=${channelAlias}`
}

const REF_A = 'channels/cc-a'
// 16 hex / 64-bit channelAlias (matches CHANNEL_ALIAS_LEN).
const ALIAS_A = createHash('sha256').update(REF_A).digest('hex').slice(0, 16)

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function slackSignature(secret: string, timestamp: string, body: Buffer): string {
  return `v0=${createHmac('sha256', secret)
    .update(`v0:${timestamp}:${body.toString('utf8')}`)
    .digest('hex')}`
}

async function seedSlackTarget(
  gateway: MockGateway,
  overrides: { workspaceId?: string | null; name?: string } = {}
): Promise<string> {
  const name = overrides.name ?? 'slack-app'
  const workspaceId = overrides.workspaceId === undefined ? 'T123' : overrides.workspaceId
  await gateway.createResource(
    'communicationchannels',
    {
      metadata: { name },
      spec: {
        credentialsSecretRef: { name: 'slack-app-credentials' },
        hostRef: 'sandbox-recipes/agent-a',
        slackSettings: {
          replyInThreads: true,
          replyOnlyWhenMentioned: true,
          ...(workspaceId ? { workspaceId } : {}),
        },
      },
    },
    'channels'
  )
  gateway.seedSecret('slack-app-credentials', 'channels', {
    data: {
      'slack-bot-token': b64('xoxb-test-token'),
      'slack-signing-secret': b64('signing-secret'),
    },
  })
  return encodeSlackTargetId('channels', name)
}

async function seedTeamsTarget(
  gateway: MockGateway,
  overrides: {
    tenantId?: string | null
    name?: string
    appId?: string | null
    appPassword?: string | null
    teams?: Array<{ channelId?: string; tenantId?: string; replyInThreads?: boolean }>
  } = {}
): Promise<string> {
  const name = overrides.name ?? 'teams-bot'
  const tenantId = overrides.tenantId === undefined ? 'tenant-1' : overrides.tenantId
  const appId = overrides.appId === undefined ? 'teams-app-1' : overrides.appId
  const appPassword =
    overrides.appPassword === undefined ? 'teams-app-secret' : overrides.appPassword
  await gateway.createResource(
    'communicationchannels',
    {
      metadata: { name },
      spec: {
        credentialsSecretRef: { name: 'teams-app-credentials' },
        hostRef: 'sandbox-recipes/agent-a',
        ...(overrides.teams ? { teams: overrides.teams } : {}),
        teamsSettings: {
          ...(appId ? { appId } : {}),
          appName: 'evenfire',
          replyOnlyWhenMentioned: true,
          ...(tenantId ? { tenantId } : {}),
        },
      },
    },
    'channels'
  )
  gateway.seedSecret('teams-app-credentials', 'channels', {
    data: appPassword ? { 'teams-app-password': b64(appPassword) } : {},
  })
  return encodeTeamsTargetId('channels', name)
}

describe('GET /api/v1/internal/workflow-approval-reader/approvals/:id/can-approve', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    mockPoolQuery.mockReset()
    const gateway = new MockGateway('sandbox-recipes')
    app = createApp(gateway as never)
  })

  it('returns 401 without service auth', async () => {
    await request(app).get(canApproveUrl(ALIAS_A)).expect(401)
  })

  it('returns 401 when the service identity is wrong (rpc-proxy token)', async () => {
    await authedGet(app, canApproveUrl(ALIAS_A), 'dev-rpc-proxy-token', 'rpc-proxy').expect(401)
  })

  it('returns 400 for an invalid approval id', async () => {
    const res = await authedGet(
      app,
      `/api/v1/internal/workflow-approval-reader/approvals/not-a-uuid/can-approve?medium=telegram&providerUserId=1&channelAlias=${ALIAS_A}`
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_approval_id')
  })

  it('returns 400 for an invalid channelAlias (wrong length)', async () => {
    const res = await authedGet(
      app,
      `/api/v1/internal/workflow-approval-reader/approvals/${UUID}/can-approve?medium=telegram&providerUserId=1&channelAlias=tooshort`
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_channel_alias')
  })

  it('returns 400 unsupported_medium for an unknown medium', async () => {
    const res = await authedGet(
      app,
      `/api/v1/internal/workflow-approval-reader/approvals/${UUID}/can-approve?medium=discord&providerUserId=12345&channelAlias=${ALIAS_A}`
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unsupported_medium')
  })

  it('returns 400 when Slack workspace or channel is missing', async () => {
    const missingWorkspace = await authedGet(
      app,
      `/api/v1/internal/workflow-approval-reader/approvals/${UUID}/can-approve?medium=slack&providerUserId=U123&providerChannelId=D123&channelAlias=${ALIAS_A}`
    )
    expect(missingWorkspace.status).toBe(400)
    expect(missingWorkspace.body.error).toBe('slack_workspace_id_required')

    const missingChannel = await authedGet(
      app,
      `/api/v1/internal/workflow-approval-reader/approvals/${UUID}/can-approve?medium=slack&providerUserId=U123&providerWorkspaceId=T123&channelAlias=${ALIAS_A}`
    )
    expect(missingChannel.status).toBe(400)
    expect(missingChannel.body.error).toBe('provider_channel_id_required')
  })

  it('returns 400 provider_user_id_required when providerUserId is empty', async () => {
    const res = await authedGet(
      app,
      `/api/v1/internal/workflow-approval-reader/approvals/${UUID}/can-approve?medium=telegram&providerUserId=&channelAlias=${ALIAS_A}`
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('provider_user_id_required')
  })

  it('returns canApprove=false reason=approval_not_found when the request does not exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const res = await authedGet(app, canApproveUrl(ALIAS_A))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ canApprove: false, reason: 'approval_not_found' })
  })

  it('returns canApprove=false reason=approval_not_pending when already decided', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ status: 'approved', isExpired: false }] })
    const res = await authedGet(app, canApproveUrl(ALIAS_A))
    expect(res.body).toEqual({ canApprove: false, reason: 'approval_not_pending' })
  })

  it('returns canApprove=false reason=approval_expired', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ status: 'pending', isExpired: true }] })
    const res = await authedGet(app, canApproveUrl(ALIAS_A))
    expect(res.body).toEqual({ canApprove: false, reason: 'approval_expired' })
  })

  it('returns canApprove=false reason=account_not_verified when no wama row exists', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ status: 'pending', isExpired: false }] })
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const res = await authedGet(app, canApproveUrl(ALIAS_A))
    expect(res.body).toEqual({ canApprove: false, reason: 'account_not_verified' })
  })

  it('returns canApprove=false reason=cross_bot_mismatch when alias does not match the account ref', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ status: 'pending', isExpired: false }] })
    // Account verified on cc-a, but the alias is from cc-b
    const aliasB = createHash('sha256').update('channels/cc-b').digest('hex').slice(0, 16)
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ communicationChannelRef: REF_A }] })
    const res = await authedGet(app, canApproveUrl(aliasB))
    expect(res.body).toEqual({ canApprove: false, reason: 'cross_bot_mismatch' })
  })

  it('returns canApprove=true when the approval is pending, the account is verified, and the alias matches', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ status: 'pending', isExpired: false }] })
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ communicationChannelRef: REF_A }] })
    const res = await authedGet(app, canApproveUrl(ALIAS_A))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ canApprove: true })
  })

  it('returns canApprove=true for Slack only when workspace, channel, and alias match', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ status: 'pending', isExpired: false }] })
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ communicationChannelRef: REF_A }] })
    const res = await authedGet(app, slackCanApproveUrl(ALIAS_A))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ canApprove: true })
    const [, params] = mockPoolQuery.mock.calls[1]!
    expect(params).toEqual(['slack', 'U123', 'T123', 'D123'])
  })
})

describe('GET /api/v1/internal/workflow-approval-reader/channel-ref', () => {
  let app: ReturnType<typeof createApp>
  let gateway: MockGateway

  beforeEach(async () => {
    mockPoolQuery.mockReset()
    gateway = new MockGateway('channels')
    await gateway.createResource(
      'communicationchannels',
      {
        metadata: { name: 'slack-a' },
        spec: {
          slack: [{ workspaceId: 'T123', channelId: 'D123', userIds: ['U123'] }],
          telegram: [{ channelId: '456', chatType: 'private', userIds: ['123'] }],
        },
      },
      'channels'
    )
    app = createApp(gateway as never)
  })

  it('resolves Slack provider workspace/channel to the CommunicationChannel ref', async () => {
    const res = await authedGet(
      app,
      '/api/v1/internal/workflow-approval-reader/channel-ref?medium=slack&providerWorkspaceId=T123&providerChannelId=D123'
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ communicationChannelRef: 'channels/slack-a' })
  })

  it('resolves Telegram provider channel to the CommunicationChannel ref', async () => {
    const res = await authedGet(
      app,
      '/api/v1/internal/workflow-approval-reader/channel-ref?medium=telegram&providerChannelId=456'
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ communicationChannelRef: 'channels/slack-a' })
  })

  it('fails closed when Slack channel resolution is ambiguous', async () => {
    await gateway.createResource(
      'communicationchannels',
      {
        metadata: { name: 'slack-b' },
        spec: {
          slack: [{ workspaceId: 'T123', channelId: 'D123', userIds: ['U456'] }],
        },
      },
      'channels'
    )

    const res = await authedGet(
      app,
      '/api/v1/internal/workflow-approval-reader/channel-ref?medium=slack&providerWorkspaceId=T123&providerChannelId=D123'
    )
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'communication_channel_ambiguous' })
  })
})

describe('Slack target proxy routes', () => {
  let app: ReturnType<typeof createApp>
  let gateway: MockGateway
  let targetId: string

  beforeEach(async () => {
    mockPoolQuery.mockReset()
    gateway = new MockGateway('channels')
    targetId = await seedSlackTarget(gateway)
    app = createApp(gateway as never)
  })

  it('returns Slack response settings after verifying the target signature', async () => {
    const rawBody = Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T123' }))
    const timestamp = `${Math.floor(Date.now() / 1000)}`
    const res = await authedPost(
      app,
      `/api/v1/internal/workflow-approval-reader/slack-targets/${encodeURIComponent(
        targetId
      )}/verify-signature`,
      {
        rawBodyBase64: rawBody.toString('base64'),
        signature: slackSignature('signing-secret', timestamp, rawBody),
        timestamp,
      }
    )

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      communicationChannelRef: 'channels/slack-app',
      hostRef: 'sandbox-recipes/agent-a',
      providerWorkspaceId: 'T123',
      replyInThreads: true,
      replyOnlyWhenMentioned: true,
    })
  })

  it('infers the Slack workspace from a signed event when the target has none configured', async () => {
    const inferredTargetId = await seedSlackTarget(gateway, {
      name: 'slack-app-unbound',
      workspaceId: null,
    })
    const rawBody = Buffer.from(
      JSON.stringify({ type: 'event_callback', event: { team: 'T-INFERRED' } })
    )
    const timestamp = `${Math.floor(Date.now() / 1000)}`
    const res = await authedPost(
      app,
      `/api/v1/internal/workflow-approval-reader/slack-targets/${encodeURIComponent(
        inferredTargetId
      )}/verify-signature`,
      {
        rawBodyBase64: rawBody.toString('base64'),
        signature: slackSignature('signing-secret', timestamp, rawBody),
        timestamp,
      }
    )

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      communicationChannelRef: 'channels/slack-app-unbound',
      providerWorkspaceId: 'T-INFERRED',
    })
  })

  it('updates Slack messages through the stored bot token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, ts: '1710000000.000002' }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const res = await authedPost(
      app,
      `/api/v1/internal/workflow-approval-reader/slack-targets/${encodeURIComponent(
        targetId
      )}/update-message`,
      {
        channelId: 'C123',
        messageTs: '1710000000.000002',
        text: 'agent reply',
        blocks: [],
      }
    )

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, ts: '1710000000.000002' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/chat.update'),
      expect.objectContaining({ method: 'POST' })
    )
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer xoxb-test-token')
    expect(JSON.parse(String(init.body))).toEqual({
      blocks: [],
      channel: 'C123',
      text: 'agent reply',
      ts: '1710000000.000002',
    })
  })
})

describe('Teams target proxy routes', () => {
  let app: ReturnType<typeof createApp>
  let gateway: MockGateway
  let targetId: string

  beforeEach(async () => {
    mockPoolQuery.mockReset()
    gateway = new MockGateway('channels')
    targetId = await seedTeamsTarget(gateway)
    app = createApp(gateway as never)
  })

  it('updates Teams messages through the stored app credentials', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'teams-access-token' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'activity-1' }),
      } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const res = await authedPost(
      app,
      `/api/v1/internal/workflow-approval-reader/teams-targets/${encodeURIComponent(
        targetId
      )}/update-message`,
      {
        conversationId: '19:channel-1@thread.tacv2',
        messageId: 'activity-1',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        text: 'Approved. Workflow approval recorded.',
      }
    )

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: 'activity-1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token'
    )
    const tokenInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(String(tokenInit.body)).toContain('client_id=teams-app-1')
    expect(String(tokenInit.body)).toContain('client_secret=teams-app-secret')

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://smba.trafficmanager.net/amer/v3/conversations/19%3Achannel-1%40thread.tacv2/activities/activity-1'
    )
    const updateInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    const headers = updateInit.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer teams-access-token')
    expect(JSON.parse(String(updateInit.body))).toEqual({
      type: 'message',
      text: 'Approved. Workflow approval recorded.',
      attachments: [],
    })
  })

  it('rejects Teams message updates with unsupported service URLs', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await authedPost(
      app,
      `/api/v1/internal/workflow-approval-reader/teams-targets/${encodeURIComponent(
        targetId
      )}/update-message`,
      {
        conversationId: '19:channel-1@thread.tacv2',
        messageId: 'activity-1',
        serviceUrl: 'http://attacker.example.com',
        text: 'Approved. Workflow approval recorded.',
      }
    )

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_teams_service_url' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

function teamsTokenAnswer(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'teams-access-token' }),
  } as Response
}

function teamsProviderAnswer(status: number, body: Record<string, unknown>): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

async function teamsTargetApp(
  overrides: Parameters<typeof seedTeamsTarget>[1] = {}
): Promise<{ app: ReturnType<typeof createApp>; targetId: string }> {
  mockPoolQuery.mockReset()
  const gateway = new MockGateway('channels')
  const targetId = await seedTeamsTarget(gateway, overrides)
  return { app: createApp(gateway as never), targetId }
}

describe('Teams update-message route refusals', () => {
  const updateBody = {
    conversationId: '19:channel-1@thread.tacv2',
    messageId: 'activity-1',
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    text: 'Approved. Workflow approval recorded.',
  }

  function updatePath(targetId: string): string {
    return `/api/v1/internal/workflow-approval-reader/teams-targets/${encodeURIComponent(
      targetId
    )}/update-message`
  }

  it('answers 401 without service auth and with another service token', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { app, targetId } = await teamsTargetApp()

    const anonymous = await request(app).post(updatePath(targetId)).send(updateBody)
    const otherService = await authedPost(
      app,
      updatePath(targetId),
      updateBody,
      'dev-rpc-proxy-token',
      'rpc-proxy'
    )

    expect(anonymous.status).toBe(401)
    expect(otherService.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a target id that does not decode and 409 for a target without an app id', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { app } = await teamsTargetApp({ appId: null })

    const badTarget = await authedPost(app, updatePath('teams:not-base64-json'), updateBody)
    const notReady = await authedPost(
      app,
      updatePath(encodeTeamsTargetId('channels', 'teams-bot')),
      updateBody
    )

    expect(badTarget.status).toBe(400)
    expect(badTarget.body).toEqual({ error: 'invalid_target_id' })
    expect(notReady.status).toBe(409)
    expect(notReady.body).toEqual({ error: 'teams_target_not_ready' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 400 when a required field is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { app, targetId } = await teamsTargetApp()

    for (const field of ['conversationId', 'messageId', 'serviceUrl', 'text'] as const) {
      const body: Record<string, string> = { ...updateBody }
      delete body[field]
      const res = await authedPost(app, updatePath(targetId), body)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_teams_message_update' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 409 when the app password is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { app, targetId } = await teamsTargetApp({ appPassword: null })

    const res = await authedPost(app, updatePath(targetId), updateBody)

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'teams_app_password_missing' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 502 when the token exchange is refused', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(teamsProviderAnswer(400, { error: 'invalid_client' }))
    vi.stubGlobal('fetch', fetchMock)
    const { app, targetId } = await teamsTargetApp()

    const res = await authedPost(app, updatePath(targetId), updateBody)

    expect(res.status).toBe(502)
    expect(res.body).toEqual({
      error: 'teams_token_exchange_failed',
      providerError: 'invalid_client',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('answers 502 when Bot Framework refuses the update', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(teamsTokenAnswer())
      .mockResolvedValueOnce(teamsProviderAnswer(403, {}))
    vi.stubGlobal('fetch', fetchMock)
    const { app, targetId } = await teamsTargetApp()

    const res = await authedPost(app, updatePath(targetId), updateBody)

    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'teams_update_failed', providerError: 'http_403' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('Teams send-message route', () => {
  const CONVERSATION_ID = '19:channel-1@thread.tacv2'
  const THREAD_CONVERSATION_ID = '19:channel-1@thread.tacv2;messageid=1700000000000'
  const ENCODED_CONVERSATION_ID = '19%3Achannel-1%40thread.tacv2'
  const ENCODED_THREAD_CONVERSATION_ID = '19%3Achannel-1%40thread.tacv2%3Bmessageid%3D1700000000000'
  const REPLY_TO_ID = '1700000000000'
  const TEXT = 'The assistant is busy. Try again in 9 seconds.'
  const sendBody = {
    conversationId: CONVERSATION_ID,
    threadConversationId: THREAD_CONVERSATION_ID,
    replyToId: REPLY_TO_ID,
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    text: TEXT,
  }
  const threadedUrl = `https://smba.trafficmanager.net/amer/v3/conversations/${ENCODED_THREAD_CONVERSATION_ID}/activities/${REPLY_TO_ID}`
  const topLevelUrl = `https://smba.trafficmanager.net/amer/v3/conversations/${ENCODED_CONVERSATION_ID}/activities`

  function sendPath(targetId: string): string {
    return `/api/v1/internal/workflow-approval-reader/teams-targets/${encodeURIComponent(
      targetId
    )}/send-message`
  }

  function stubSuccessfulSend(): ReturnType<typeof vi.fn> {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(teamsTokenAnswer())
      .mockResolvedValueOnce(teamsProviderAnswer(201, { id: 'activity-2' }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function sentActivity(fetchMock: ReturnType<typeof vi.fn>): {
    url: string
    method: string
    authorization: string | null
    body: unknown
  } {
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit
    return {
      url: String(fetchMock.mock.calls[1]?.[0]),
      method: String(init.method),
      authorization: (init.headers as Headers).get('Authorization'),
      body: JSON.parse(String(init.body)),
    }
  }

  it('replies in the card thread when the group does not set reply-in-threads', async () => {
    const fetchMock = stubSuccessfulSend()
    const { app, targetId } = await teamsTargetApp()

    const res = await authedPost(app, sendPath(targetId), sendBody)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: 'activity-2' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token'
    )
    expect(sentActivity(fetchMock)).toEqual({
      url: threadedUrl,
      method: 'POST',
      authorization: 'Bearer teams-access-token',
      body: { type: 'message', text: TEXT, replyToId: REPLY_TO_ID },
    })
  })

  it.each([
    {
      name: 'the group sets reply-in-threads',
      teams: [{ channelId: CONVERSATION_ID, tenantId: 'tenant-1', replyInThreads: true }],
    },
    {
      name: 'no group matches the conversation',
      teams: [{ channelId: '19:other@thread.tacv2', tenantId: 'tenant-1', replyInThreads: false }],
    },
    {
      name: 'the only matching channel belongs to another tenant',
      teams: [{ channelId: CONVERSATION_ID, tenantId: 'tenant-2', replyInThreads: false }],
    },
  ])('replies in the card thread when $name', async ({ teams }) => {
    const fetchMock = stubSuccessfulSend()
    const { app, targetId } = await teamsTargetApp({ teams })

    const res = await authedPost(app, sendPath(targetId), sendBody)

    expect(res.status).toBe(200)
    expect(sentActivity(fetchMock)).toMatchObject({
      url: threadedUrl,
      body: { type: 'message', text: TEXT, replyToId: REPLY_TO_ID },
    })
  })

  it('posts at the top level of the conversation when the group turns reply-in-threads off', async () => {
    const fetchMock = stubSuccessfulSend()
    const { app, targetId } = await teamsTargetApp({
      teams: [{ channelId: CONVERSATION_ID, tenantId: 'tenant-1', replyInThreads: false }],
    })

    const res = await authedPost(app, sendPath(targetId), sendBody)

    expect(res.status).toBe(200)
    expect(sentActivity(fetchMock)).toEqual({
      url: topLevelUrl,
      method: 'POST',
      authorization: 'Bearer teams-access-token',
      body: { type: 'message', text: TEXT },
    })
  })

  it('posts at the top level when no card id is given', async () => {
    const fetchMock = stubSuccessfulSend()
    const { app, targetId } = await teamsTargetApp()
    const { replyToId: _replyToId, ...withoutReplyTo } = sendBody

    const res = await authedPost(app, sendPath(targetId), withoutReplyTo)

    expect(res.status).toBe(200)
    expect(sentActivity(fetchMock)).toMatchObject({
      url: topLevelUrl,
      body: { type: 'message', text: TEXT },
    })
  })

  it('builds the activity from the text and card id only', async () => {
    const fetchMock = stubSuccessfulSend()
    const { app, targetId } = await teamsTargetApp({
      teams: [{ channelId: CONVERSATION_ID, tenantId: 'tenant-1', replyInThreads: true }],
    })

    const res = await authedPost(app, sendPath(targetId), {
      ...sendBody,
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {} }],
      entities: [{ type: 'mention', text: '<at>Someone</at>' }],
      summary: 'injected',
      threaded: false,
    })

    expect(res.status).toBe(200)
    expect(sentActivity(fetchMock)).toEqual({
      url: threadedUrl,
      method: 'POST',
      authorization: 'Bearer teams-access-token',
      body: { type: 'message', text: TEXT, replyToId: REPLY_TO_ID },
    })
  })

  it('answers 401 without service auth and with another service token', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { app, targetId } = await teamsTargetApp()

    const anonymous = await request(app).post(sendPath(targetId)).send(sendBody)
    const otherService = await authedPost(
      app,
      sendPath(targetId),
      sendBody,
      'dev-rpc-proxy-token',
      'rpc-proxy'
    )

    expect(anonymous.status).toBe(401)
    expect(otherService.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a target id that does not decode and 409 for a target without an app id', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { app } = await teamsTargetApp({ appId: null })

    const badTarget = await authedPost(app, sendPath('teams:not-base64-json'), sendBody)
    const notReady = await authedPost(
      app,
      sendPath(encodeTeamsTargetId('channels', 'teams-bot')),
      sendBody
    )

    expect(badTarget.status).toBe(400)
    expect(badTarget.body).toEqual({ error: 'invalid_target_id' })
    expect(notReady.status).toBe(409)
    expect(notReady.body).toEqual({ error: 'teams_target_not_ready' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['http://attacker.example.com', 'https://smba.trafficmanager.net.evil.example'])(
    'answers 400 for the service URL %s before reading the credentials',
    async serviceUrl => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const { app, targetId } = await teamsTargetApp()

      const res = await authedPost(app, sendPath(targetId), { ...sendBody, serviceUrl })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_teams_service_url' })
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it('answers 400 when a required field is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { app, targetId } = await teamsTargetApp()

    for (const field of ['conversationId', 'serviceUrl', 'text'] as const) {
      const body: Record<string, string> = { ...sendBody }
      delete body[field]
      const res = await authedPost(app, sendPath(targetId), body)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_teams_message' })
    }
    const blank = await authedPost(app, sendPath(targetId), { ...sendBody, text: '   ' })
    expect(blank.status).toBe(400)
    expect(blank.body).toEqual({ error: 'invalid_teams_message' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 409 when the app password is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { app, targetId } = await teamsTargetApp({ appPassword: null })

    const res = await authedPost(app, sendPath(targetId), sendBody)

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'teams_app_password_missing' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 502 when the token exchange is refused', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(teamsProviderAnswer(400, { error: 'invalid_client' }))
    vi.stubGlobal('fetch', fetchMock)
    const { app, targetId } = await teamsTargetApp()

    const res = await authedPost(app, sendPath(targetId), sendBody)

    expect(res.status).toBe(502)
    expect(res.body).toEqual({
      error: 'teams_token_exchange_failed',
      providerError: 'invalid_client',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('answers 502 when Bot Framework refuses the message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(teamsTokenAnswer())
      .mockResolvedValueOnce(teamsProviderAnswer(403, { error: 'BotNotInConversationRoster' }))
    vi.stubGlobal('fetch', fetchMock)
    const { app, targetId } = await teamsTargetApp()

    const res = await authedPost(app, sendPath(targetId), sendBody)

    expect(res.status).toBe(502)
    expect(res.body).toEqual({
      error: 'teams_send_failed',
      providerError: 'BotNotInConversationRoster',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
