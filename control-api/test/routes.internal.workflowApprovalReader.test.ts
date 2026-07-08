import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { encodeSlackTargetId } from '../src/utils/slackTargetId.js'
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
