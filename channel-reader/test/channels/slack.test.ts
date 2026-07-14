import { beforeEach, describe, expect, it, vi } from 'vitest'
// ── Import under test ─────────────────────────────────────────────────────────

import { SlackAdapter } from '../../src/channels/slack.js'
import {
  isSlackVerifyCommand,
  parseSlackVerifyCommand,
  redactSlackVerificationText,
} from '../../src/channels/slackVerification.js'

// ── Hoisted shared state ──────────────────────────────────────────────────────

const slackState = vi.hoisted(() => ({
  instances: [] as Array<{
    auth: { test: ReturnType<typeof vi.fn> }
    conversations: {
      history: ReturnType<typeof vi.fn>
      list: ReturnType<typeof vi.fn>
    }
    users: { info: ReturnType<typeof vi.fn> }
    chat: { postMessage: ReturnType<typeof vi.fn> }
    files: { uploadV2: ReturnType<typeof vi.fn> }
  }>,
}))

const TEST_TOKEN = 'xoxb-test-000000'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/config.js', () => ({
  config: {
    mcpHostUrl: 'http://mcp-host.test',
    enableResponseAttachments: true,
    attachmentMaxBytes: 1024 * 1024,
    attachmentMaxCount: 4,
  },
}))

vi.mock('@slack/web-api', () => ({
  // Must use `function` for constructor mocking with `new`
  WebClient: vi.fn().mockImplementation(function () {
    const instance = {
      auth: {
        test: vi.fn().mockResolvedValue({
          user: 'clerum_bot',
          user_id: 'U_BOT888',
          team_id: 'T123',
          ok: true,
        }),
      },
      conversations: {
        history: vi.fn().mockResolvedValue({ messages: [], ok: true }),
        list: vi.fn().mockResolvedValue({ channels: [], ok: true }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: { name: 'testuser', ok: true },
          ok: true,
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.000001', ok: true }),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue({ ok: true }),
      },
    }
    slackState.instances.push(instance)
    return instance
  }),
}))

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  slackState.instances.length = 0
})

// ── connect() ─────────────────────────────────────────────────────────────────

describe('SlackAdapter — connect()', () => {
  it('creates a WebClient with the configured token', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    expect(slackState.instances).toHaveLength(1)
  })

  it('calls auth.test() to verify connection', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    expect(slackState.instances[0]!.auth.test).toHaveBeenCalledOnce()
  })

  it('skips connection when slackBotToken is not configured', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: undefined })

    expect(slackState.instances).toHaveLength(0)
  })

  it('handles auth.test() failure gracefully (nullifies client)', async () => {
    const { WebClient } = await import('@slack/web-api')
    vi.mocked(WebClient).mockImplementationOnce(function () {
      const instance = {
        auth: {
          test: vi.fn().mockRejectedValue(new Error('invalid_auth')),
        },
        conversations: { history: vi.fn(), list: vi.fn() },
        users: { info: vi.fn() },
        chat: { postMessage: vi.fn() },
      }
      slackState.instances.push(instance as never)
      return instance as never
    })

    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    // connect() should not throw
    // After a failed auth.test(), client is nullified → fetchMessages returns []
    const messages = await adapter.fetchMessages('general', new Set(['user1']))
    expect(messages).toEqual([])
  })
})

describe('Slack verification command parsing', () => {
  it('accepts plain Slack verify messages without slash-command interception', () => {
    expect(isSlackVerifyCommand('verify 123456')).toBe(true)
    expect(parseSlackVerifyCommand('verify 123456')).toBe('123456')
  })

  it('accepts Slack app mentions before the verify command', () => {
    expect(isSlackVerifyCommand('<@UBOT888> verify 123456')).toBe(true)
    expect(parseSlackVerifyCommand('<@UBOT888> verify 123456')).toBe('123456')
  })

  it('redacts Slack verification messages that mention the app', () => {
    expect(redactSlackVerificationText('<@UBOT888> verify 123456')).toBe('verify [redacted]')
  })
})

// ── disconnect() ──────────────────────────────────────────────────────────────

describe('SlackAdapter — disconnect()', () => {
  it('is safe to call disconnect() before connect()', async () => {
    const adapter = new SlackAdapter()
    await expect(adapter.disconnect()).resolves.toBeUndefined()
  })

  it('nullifies client on disconnect', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    await adapter.disconnect()

    // After disconnect, fetchMessages returns [] (no client)
    const messages = await adapter.fetchMessages('general', new Set(['anyone']))
    expect(messages).toEqual([])
  })
})

// ── fetchMessages() ───────────────────────────────────────────────────────────

describe('SlackAdapter — fetchMessages()', () => {
  it('returns empty array when not connected', async () => {
    const adapter = new SlackAdapter()
    // No connect()

    const messages = await adapter.fetchMessages('C12345', new Set(['user1']))
    expect(messages).toEqual([])
  })

  it('returns empty array when no messages in history', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const client = slackState.instances[0]!
    client.conversations.history.mockResolvedValueOnce({ messages: [], ok: true })

    const messages = await adapter.fetchMessages('C12345', new Set(['user1']))
    expect(messages).toEqual([])
  })

  it('filters messages from allowed users by stable user ID and records workspace identity', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const client = slackState.instances[0]!
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ user: 'U123', text: 'Hello', ts: '1700000001.000001' }],
      ok: true,
    })
    // User lookup returns username "alice"
    client.users.info.mockResolvedValueOnce({
      user: { name: 'alice' },
      ok: true,
    })

    const messages = await adapter.fetchMessages('C12345', new Set(['U123']))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.sender).toBe('U123')
    expect(messages[0]!.content).toBe('Hello')
    expect(messages[0]!.channelType).toBe('slack')
    expect(messages[0]!.providerIdentity).toEqual({
      medium: 'slack',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C12345',
      providerEventId: 'slack:T123:C12345:1700000001.000001',
    })
  })

  it('rejects messages when configured workspace does not match the verified Slack workspace', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const client = slackState.instances[0]!
    client.conversations.history.mockResolvedValueOnce({
      messages: [
        {
          user: 'U123',
          text: '/approve due-diligence-review',
          ts: '1700000001.000005',
        },
      ],
      ok: true,
    })

    const messages = await adapter.fetchMessages('C12345', new Set(['U123']), {
      providerWorkspaceId: 'T999',
    })
    expect(messages).toHaveLength(0)
  })

  it('uses Slack event workspace identity when auth.test does not expose team_id', async () => {
    const { WebClient } = await import('@slack/web-api')
    vi.mocked(WebClient).mockImplementationOnce(function () {
      const instance = {
        auth: {
          test: vi.fn().mockResolvedValue({ user: 'clerum_bot', user_id: 'U_BOT888', ok: true }),
        },
        conversations: {
          history: vi.fn().mockResolvedValue({
            messages: [
              {
                user: 'U123',
                team: 'T123',
                text: '/approve due-diligence-review',
                ts: '1700000001.000006',
              },
            ],
            ok: true,
          }),
          list: vi.fn().mockResolvedValue({ channels: [], ok: true }),
        },
        users: {
          info: vi.fn().mockResolvedValue({
            user: { name: 'alice' },
            ok: true,
          }),
        },
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.000001', ok: true }),
        },
        files: {
          uploadV2: vi.fn().mockResolvedValue({ ok: true }),
        },
      }
      slackState.instances.push(instance)
      return instance
    })

    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const messages = await adapter.fetchMessages('C12345', new Set(['U123']), {
      providerWorkspaceId: 'T123',
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.providerIdentity).toEqual({
      medium: 'slack',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C12345',
      providerEventId: 'slack:T123:C12345:1700000001.000006',
    })
  })

  it('does not emit slack:unknown provider identities when workspace identity is unavailable', async () => {
    const { WebClient } = await import('@slack/web-api')
    vi.mocked(WebClient).mockImplementationOnce(function () {
      const instance = {
        auth: {
          test: vi.fn().mockResolvedValue({ user: 'clerum_bot', user_id: 'U_BOT888', ok: true }),
        },
        conversations: {
          history: vi.fn().mockResolvedValue({
            messages: [
              {
                user: 'U123',
                text: 'legacy hello',
                ts: '1700000001.000007',
              },
            ],
            ok: true,
          }),
          list: vi.fn().mockResolvedValue({ channels: [], ok: true }),
        },
        users: {
          info: vi.fn().mockResolvedValue({
            user: { name: 'alice' },
            ok: true,
          }),
        },
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.000001', ok: true }),
        },
        files: {
          uploadV2: vi.fn().mockResolvedValue({ ok: true }),
        },
      }
      slackState.instances.push(instance)
      return instance
    })

    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const messages = await adapter.fetchMessages('C12345', new Set(['alice']))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.providerIdentity).toBeUndefined()
  })

  it('keeps username allowlists only as legacy chat compatibility', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const client = slackState.instances[0]!
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ user: 'U123', text: 'legacy hello', ts: '1700000001.000002' }],
      ok: true,
    })
    client.users.info.mockResolvedValueOnce({
      user: { name: 'alice' },
      ok: true,
    })

    const messages = await adapter.fetchMessages('C12345', new Set(['alice']))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.sender).toBe('U123')
    expect(messages[0]!.providerIdentity?.providerUserId).toBe('U123')
  })

  it('does not allow workflow approval decisions through legacy username allowlists', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const client = slackState.instances[0]!
    client.conversations.history.mockResolvedValueOnce({
      messages: [
        {
          user: 'U123',
          text: '/approve due-diligence-review',
          ts: '1700000001.000003',
        },
      ],
      ok: true,
    })
    client.users.info.mockResolvedValueOnce({
      user: { name: 'alice' },
      ok: true,
    })

    const messages = await adapter.fetchMessages('C12345', new Set(['alice']))
    expect(messages).toHaveLength(0)
  })

  it('allows workflow approval decisions only when the stable Slack user ID is allowlisted', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const client = slackState.instances[0]!
    client.conversations.history.mockResolvedValueOnce({
      messages: [
        {
          user: 'U123',
          text: '/approve due-diligence-review',
          ts: '1700000001.000004',
        },
      ],
      ok: true,
    })
    client.users.info.mockResolvedValueOnce({
      user: { name: 'alice' },
      ok: true,
    })

    const messages = await adapter.fetchMessages('C12345', new Set(['U123']))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.providerIdentity).toEqual({
      medium: 'slack',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C12345',
      providerEventId: 'slack:T123:C12345:1700000001.000004',
    })
  })

  it('ignores messages from unauthorized users', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const client = slackState.instances[0]!
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ user: 'U999', text: 'Spam', ts: '1700000002.000001' }],
      ok: true,
    })
    client.users.info.mockResolvedValueOnce({
      user: { name: 'spammer' },
      ok: true,
    })

    const messages = await adapter.fetchMessages('C12345', new Set(['alice']))
    expect(messages).toHaveLength(0)
  })

  it('skips bot messages (messages with subtype)', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const client = slackState.instances[0]!
    client.conversations.history.mockResolvedValueOnce({
      messages: [
        { user: 'U123', text: 'Bot notification', ts: '1700000003.000001', subtype: 'bot_message' },
      ],
      ok: true,
    })

    const messages = await adapter.fetchMessages('C12345', new Set(['alice']))
    expect(messages).toHaveLength(0)
  })

  it('skips messages without a user field', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const client = slackState.instances[0]!
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ text: 'System message', ts: '1700000004.000001' }],
      ok: true,
    })

    const messages = await adapter.fetchMessages('C12345', new Set(['alice']))
    expect(messages).toHaveLength(0)
  })

  it('with replyOnlyWhenMentioned, drops messages without app mention', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const client = slackState.instances[0]!
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ user: 'U123', text: 'Hello without mention', ts: '1700000005.000001' }],
      ok: true,
    })
    client.users.info.mockResolvedValueOnce({
      user: { name: 'alice' },
      ok: true,
    })

    const messages = await adapter.fetchMessages('C12345', new Set(['alice']), {
      replyOnlyWhenMentioned: true,
    })
    expect(messages).toHaveLength(0)
  })

  it('with replyOnlyWhenMentioned, keeps messages that mention the bot', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const client = slackState.instances[0]!
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ user: 'U123', text: '<@U_BOT888> please help', ts: '1700000006.000001' }],
      ok: true,
    })
    client.users.info.mockResolvedValueOnce({
      user: { name: 'alice' },
      ok: true,
    })

    const messages = await adapter.fetchMessages('C12345', new Set(['alice']), {
      replyOnlyWhenMentioned: true,
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('<@U_BOT888> please help')
  })

  it('with replyOnlyWhenMentioned, /approve bypasses mention requirement', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })

    const client = slackState.instances[0]!
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ user: 'U123', text: '/approve', ts: '1700000007.000001' }],
      ok: true,
    })
    client.users.info.mockResolvedValueOnce({
      user: { name: 'alice' },
      ok: true,
    })

    const messages = await adapter.fetchMessages('C12345', new Set(['alice']), {
      replyOnlyWhenMentioned: true,
    })
    expect(messages).toHaveLength(1)
  })

  it('with replyOnlyWhenMentioned, drops messages when bot user_id is missing from auth', async () => {
    const { WebClient } = await import('@slack/web-api')
    vi.mocked(WebClient).mockImplementationOnce(function () {
      const instance = {
        auth: {
          test: vi.fn().mockResolvedValue({ user: 'clerum_bot', ok: true }),
        },
        conversations: {
          history: vi.fn().mockResolvedValue({
            messages: [{ user: 'U123', text: '<@U_BOT888> fake', ts: '1700000008.000001' }],
            ok: true,
          }),
          list: vi.fn().mockResolvedValue({ channels: [], ok: true }),
        },
        users: {
          info: vi.fn().mockResolvedValue({
            user: { name: 'alice' },
            ok: true,
          }),
        },
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.000001', ok: true }),
        },
        files: {
          uploadV2: vi.fn().mockResolvedValue({ ok: true }),
        },
      }
      slackState.instances.push(instance)
      return instance
    })

    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const messages = await adapter.fetchMessages('C12345', new Set(['alice']), {
      replyOnlyWhenMentioned: true,
    })
    expect(messages).toHaveLength(0)
  })

  it('with replyOnlyWhenMentioned and missing bot user_id, /approve still passes', async () => {
    const { WebClient } = await import('@slack/web-api')
    vi.mocked(WebClient).mockImplementationOnce(function () {
      const instance = {
        auth: {
          test: vi.fn().mockResolvedValue({ user: 'clerum_bot', ok: true }),
        },
        conversations: {
          history: vi.fn().mockResolvedValue({
            messages: [{ user: 'U123', text: '/approve', ts: '1700000009.000001' }],
            ok: true,
          }),
          list: vi.fn().mockResolvedValue({ channels: [], ok: true }),
        },
        users: {
          info: vi.fn().mockResolvedValue({
            user: { name: 'alice' },
            ok: true,
          }),
        },
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.000001', ok: true }),
        },
        files: {
          uploadV2: vi.fn().mockResolvedValue({ ok: true }),
        },
      }
      slackState.instances.push(instance)
      return instance
    })

    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const messages = await adapter.fetchMessages('C12345', new Set(['alice']), {
      replyOnlyWhenMentioned: true,
    })
    expect(messages).toHaveLength(1)
  })

  it('with replyOnlyWhenMentioned, warns once when bot user_id is missing from auth.test', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { WebClient } = await import('@slack/web-api')
    vi.mocked(WebClient).mockImplementationOnce(function () {
      const instance = {
        auth: {
          test: vi.fn().mockResolvedValue({ user: 'clerum_bot', ok: true }),
        },
        conversations: {
          history: vi.fn().mockResolvedValue({ messages: [], ok: true }),
          list: vi.fn().mockResolvedValue({ channels: [], ok: true }),
        },
        users: {
          info: vi.fn().mockResolvedValue({
            user: { name: 'alice' },
            ok: true,
          }),
        },
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.000001', ok: true }),
        },
        files: {
          uploadV2: vi.fn().mockResolvedValue({ ok: true }),
        },
      }
      slackState.instances.push(instance)
      return instance
    })

    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    await adapter.fetchMessages('C12345', new Set(['alice']), { replyOnlyWhenMentioned: true })
    await adapter.fetchMessages('C12345', new Set(['alice']), { replyOnlyWhenMentioned: true })

    const missingIdWarns = warnSpy.mock.calls.filter(c =>
      String(c[0]).includes('bot user_id is missing from auth.test')
    )
    expect(missingIdWarns.length).toBe(1)
    warnSpy.mockRestore()
  })

  it('with replyOnlyWhenMentioned and missing bot user_id, /deny still passes', async () => {
    const { WebClient } = await import('@slack/web-api')
    vi.mocked(WebClient).mockImplementationOnce(function () {
      const instance = {
        auth: {
          test: vi.fn().mockResolvedValue({ user: 'clerum_bot', ok: true }),
        },
        conversations: {
          history: vi.fn().mockResolvedValue({
            messages: [{ user: 'U123', text: '/deny', ts: '1700000010.000001' }],
            ok: true,
          }),
          list: vi.fn().mockResolvedValue({ channels: [], ok: true }),
        },
        users: {
          info: vi.fn().mockResolvedValue({
            user: { name: 'alice' },
            ok: true,
          }),
        },
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.000001', ok: true }),
        },
        files: {
          uploadV2: vi.fn().mockResolvedValue({ ok: true }),
        },
      }
      slackState.instances.push(instance)
      return instance
    })

    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const messages = await adapter.fetchMessages('C12345', new Set(['alice']), {
      replyOnlyWhenMentioned: true,
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('/deny')
  })

  it('with replyOnlyWhenMentioned and missing bot user_id, /approve always still passes', async () => {
    const { WebClient } = await import('@slack/web-api')
    vi.mocked(WebClient).mockImplementationOnce(function () {
      const instance = {
        auth: {
          test: vi.fn().mockResolvedValue({ user: 'clerum_bot', ok: true }),
        },
        conversations: {
          history: vi.fn().mockResolvedValue({
            messages: [{ user: 'U123', text: '/approve always', ts: '1700000011.000001' }],
            ok: true,
          }),
          list: vi.fn().mockResolvedValue({ channels: [], ok: true }),
        },
        users: {
          info: vi.fn().mockResolvedValue({
            user: { name: 'alice' },
            ok: true,
          }),
        },
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.000001', ok: true }),
        },
        files: {
          uploadV2: vi.fn().mockResolvedValue({ ok: true }),
        },
      }
      slackState.instances.push(instance)
      return instance
    })

    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const messages = await adapter.fetchMessages('C12345', new Set(['alice']), {
      replyOnlyWhenMentioned: true,
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('/approve always')
  })
})

describe('SlackAdapter — sendMessage()', () => {
  it('passes Slack Block Kit options to chat.postMessage', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const client = slackState.instances[0]!
    const slackBlocks = [
      { type: 'section' as const, text: { type: 'mrkdwn' as const, text: 'Approval needed' } },
      {
        type: 'actions' as const,
        elements: [
          {
            type: 'button' as const,
            action_id: 'workflow_approval_approve',
            text: { type: 'plain_text' as const, text: 'Approve' },
            value: 'approve:99999999-8888-7777-6666-555555555555:sandbox-recipes/research',
            style: 'primary' as const,
          },
        ],
      },
    ]

    await adapter.sendMessage('C12345', 'Approval needed', undefined, undefined, { slackBlocks })

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C12345',
        text: 'Approval needed',
        blocks: slackBlocks,
      })
    )
  })

  it('uploads workflow result documents to Slack files', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const client = slackState.instances[0]!
    const dataBase64 = Buffer.from('{"ok":true}', 'utf8').toString('base64')

    const messageId = await adapter.sendMessage('C12345', 'Workflow result is ready', '170.0001', [
      {
        id: 'artifact-1',
        kind: 'file',
        mimeType: 'application/json',
        encoding: 'base64',
        dataBase64,
        filename: 'result.json',
        sourceTool: 'workflow_result',
      },
    ])

    expect(messageId).toBe('1234567890.000001')
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C12345',
        text: 'Workflow result is ready',
        thread_ts: '170.0001',
      })
    )
    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'C12345',
        thread_ts: '170.0001',
        file_uploads: [
          expect.objectContaining({
            filename: 'result.json',
            title: 'result.json',
            file: Buffer.from('{"ok":true}', 'utf8'),
          }),
        ],
      })
    )
  })

  it('reports unsupported attachments while still uploading trusted documents', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const client = slackState.instances[0]!

    await adapter.sendMessage('C12345', '', '170.0001', [
      {
        id: 'result-1',
        kind: 'file',
        mimeType: 'application/json',
        encoding: 'base64',
        dataBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64'),
        filename: 'result.json',
        sourceTool: 'workflow_result',
      },
      {
        id: 'generic-1',
        kind: 'file',
        mimeType: 'text/plain',
        encoding: 'base64',
        dataBase64: Buffer.from('hello', 'utf8').toString('base64'),
        filename: 'generic.txt',
      },
    ])

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C12345',
        text: '1 attachment was generated but could not be delivered to Slack.',
        thread_ts: '170.0001',
      })
    )
    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'C12345',
        thread_ts: '170.0001',
        file_uploads: [
          expect.objectContaining({
            filename: 'result.json',
            title: 'result.json',
            file: Buffer.from('{"ok":true}', 'utf8'),
          }),
        ],
      })
    )
  })

  it('does not upload untrusted generic file attachments', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const client = slackState.instances[0]!

    await adapter.sendMessage('C12345', 'Plain reply', undefined, [
      {
        id: 'generic-1',
        kind: 'file',
        mimeType: 'text/plain',
        encoding: 'base64',
        dataBase64: Buffer.from('hello', 'utf8').toString('base64'),
        filename: 'generic.txt',
      },
    ])

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C12345',
        text: 'Plain reply\n\n[Note: 1 attachment was generated but could not be delivered to Slack.]',
      })
    )
    expect(client.files.uploadV2).not.toHaveBeenCalled()
  })
})

// ── channelType ───────────────────────────────────────────────────────────────

describe('SlackAdapter — channelType', () => {
  it('reports channelType as slack', () => {
    const adapter = new SlackAdapter()
    expect(adapter.channelType).toBe('slack')
  })
})
