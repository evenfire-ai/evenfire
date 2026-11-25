import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
      info: ReturnType<typeof vi.fn>
      list: ReturnType<typeof vi.fn>
    }
    users: { info: ReturnType<typeof vi.fn> }
    chat: { postMessage: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
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
        info: vi.fn().mockResolvedValue({
          channel: { id: 'C12345', name: 'general', is_channel: true },
          ok: true,
        }),
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
        update: vi.fn().mockResolvedValue({ ok: true }),
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

  it('logs a connect failure without the request headers', async () => {
    const marker = 'xoxb-probe-marker-not-a-secret'
    const transportError = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'slack_webapi_request_error',
      original: { request: { _header: `Authorization: Bearer ${marker}\r\n` } },
    })
    const { WebClient } = await import('@slack/web-api')
    vi.mocked(WebClient).mockImplementationOnce(function () {
      const instance = {
        auth: { test: vi.fn().mockRejectedValue(transportError) },
        conversations: { history: vi.fn(), list: vi.fn() },
        users: { info: vi.fn() },
        chat: { postMessage: vi.fn() },
      }
      slackState.instances.push(instance as never)
      return instance as never
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: marker })
    const printed = errorSpy.mock.calls.map(call => call.map(String).join(' ')).join('\n')
    expect(printed).toContain('slack_webapi_request_error')
    expect(printed).not.toContain(marker)
    expect(printed).not.toMatch(/authorization:\s*bearer/i)
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

describe('SlackAdapter — conversation metadata', () => {
  it('reads the Slack conversation title and type for confirmed conversations', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const client = slackState.instances[0]!

    client.conversations.info.mockResolvedValueOnce({
      channel: { id: 'G12345', name: 'leadership', is_private: true },
      ok: true,
    })

    await expect(adapter.getConversationMetadata('G12345', 'U123')).resolves.toEqual({
      providerChannelType: 'private_channel',
      providerChannelTitle: '#leadership',
    })
    expect(client.conversations.info).toHaveBeenCalledWith({ channel: 'G12345' })
  })

  it('uses the Slack user display name for direct-message metadata', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const client = slackState.instances[0]!

    client.conversations.info.mockResolvedValueOnce({
      channel: { id: 'D12345', is_im: true, user: 'U123' },
      ok: true,
    })
    client.users.info.mockResolvedValueOnce({
      user: { name: 'josue' },
      ok: true,
    })

    await expect(adapter.getConversationMetadata('D12345', null)).resolves.toEqual({
      providerChannelType: 'im',
      providerChannelTitle: '@josue',
    })
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
          info: vi.fn().mockResolvedValue({
            channel: { id: 'C12345', name: 'general', is_channel: true },
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
          info: vi.fn().mockResolvedValue({
            channel: { id: 'C12345', name: 'general', is_channel: true },
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
          info: vi.fn().mockResolvedValue({
            channel: { id: 'C12345', name: 'general', is_channel: true },
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
          info: vi.fn().mockResolvedValue({
            channel: { id: 'C12345', name: 'general', is_channel: true },
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
          info: vi.fn().mockResolvedValue({
            channel: { id: 'C12345', name: 'general', is_channel: true },
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
          info: vi.fn().mockResolvedValue({
            channel: { id: 'C12345', name: 'general', is_channel: true },
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
          info: vi.fn().mockResolvedValue({
            channel: { id: 'C12345', name: 'general', is_channel: true },
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

  it('updates tool approval blocks and clears them from progress messages', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const client = slackState.instances[0]!
    const blocks = [
      { type: 'section' as const, text: { type: 'mrkdwn' as const, text: 'Approval needed' } },
      {
        type: 'actions' as const,
        elements: [
          {
            type: 'button' as const,
            action_id: 'tool_approval_approve',
            text: { type: 'plain_text' as const, text: 'Approve' },
            value: 'tool:a:abcdefghijklmnop',
          },
        ],
      },
    ]

    await adapter.editMessage('C12345', '1234567890.000001', 'Approval needed', {
      slackBlocks: blocks,
    })
    await adapter.editMessage('C12345', '1234567890.000001', 'Approved. Processing...')

    expect(client.chat.update).toHaveBeenNthCalledWith(1, {
      channel: 'C12345',
      ts: '1234567890.000001',
      text: 'Approval needed',
      blocks,
    })
    expect(client.chat.update).toHaveBeenNthCalledWith(2, {
      channel: 'C12345',
      ts: '1234567890.000001',
      text: 'Approved. Processing...',
      blocks: [],
    })
  })

  it('logs a Slack API error with the run id and rejects the edit', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const client = slackState.instances[0]!
    client.chat.update.mockRejectedValueOnce(
      Object.assign(new Error('msg_too_long'), { data: { error: 'msg_too_long' } })
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await expect(
        adapter.editMessage('C12345', '1234567890.000001', 'x'.repeat(5000), { runId: 'task-long' })
      ).rejects.toThrow('msg_too_long')
      const logged = consoleError.mock.calls.map(call => String(call[0])).join('\n')
      expect(logged).toContain('task-long')
      expect(logged).toContain('msg_too_long')
      expect(logged).toContain('chat.update')
    } finally {
      consoleError.mockRestore()
    }
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

  it('throws when a run reply cannot be posted and stays soft without a run id', async () => {
    const disconnected = new SlackAdapter()
    await expect(
      disconnected.sendMessage('C12345', 'hello', undefined, undefined, { runId: 'task-1' })
    ).rejects.toThrow('slack_not_connected')
    await expect(disconnected.sendMessage('C12345', 'hello')).resolves.toBeUndefined()

    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const client = slackState.instances[0]!
    client.chat.postMessage.mockResolvedValueOnce({ ok: true })
    await expect(
      adapter.sendMessage('C12345', 'hello', undefined, undefined, { runId: 'task-1' })
    ).rejects.toThrow('slack_post_failed')
    client.chat.postMessage.mockResolvedValueOnce({ ok: true })
    await expect(adapter.sendMessage('C12345', 'hello')).resolves.toBeUndefined()

    await expect(
      adapter.sendMessage('C12345', '   ', undefined, undefined, { runId: 'task-1' })
    ).resolves.toBeUndefined()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(
        adapter.sendMessage('general', 'hello', undefined, undefined, { runId: 'task-1' })
      ).rejects.toThrow('slack_channel_unresolved')
      await expect(adapter.sendMessage('general', 'hello')).resolves.toBeUndefined()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('retries a ratelimited Slack call and returns when the next attempt succeeds', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const client = slackState.instances[0]!
    client.chat.update
      .mockRejectedValueOnce(
        Object.assign(new Error('ratelimited'), {
          data: { error: 'ratelimited' },
          retryAfter: 0,
        })
      )
      .mockResolvedValueOnce({ ok: true, ts: '1234567890.000001' })

    await expect(
      adapter.editMessage('C12345', '1234567890.000001', 'hello', { runId: 'task-1' })
    ).resolves.toBeUndefined()
    expect(client.chat.update).toHaveBeenCalledTimes(2)
  })

  it('uploads a text snippet through files.uploadV2 and does not post it', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const client = slackState.instances[0]!
    const fence = '```\n' + 'x'.repeat(5_000) + '\n```'

    await adapter.uploadTextSnippet('C12345', fence, 'reply-part-1.txt', '170.0001', 'task-long')

    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'C12345',
        thread_ts: '170.0001',
        file_uploads: [
          expect.objectContaining({
            filename: 'reply-part-1.txt',
            title: 'reply-part-1.txt',
            file: Buffer.from(fence, 'utf8'),
          }),
        ],
      })
    )
    expect(client.chat.postMessage).not.toHaveBeenCalled()
  })
})

describe('SlackAdapter — inlineSharedFiles()', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('inlines three Slack files, skips the fourth, and notes the count', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const fetched: string[] = []
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal)
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      fetched.push(String(input))
      const index = fetched.length
      return new Response(`body-${index}`, { status: 200 })
    }) as typeof fetch

    const files = [1, 2, 3, 4].map(index => ({
      id: `F${index}`,
      name: `note-${index}.txt`,
      mimetype: 'text/plain',
      size: 20,
      urlPrivateDownload: `https://files.slack.com/files-pri/T/note-${index}.txt`,
    }))
    try {
      const appendix = await adapter.inlineSharedFiles(files)

      expect(fetched).toEqual([
        'https://files.slack.com/files-pri/T/note-1.txt',
        'https://files.slack.com/files-pri/T/note-2.txt',
        'https://files.slack.com/files-pri/T/note-3.txt',
      ])
      expect(appendix).toContain('body-1')
      expect(appendix).toContain('body-2')
      expect(appendix).toContain('body-3')
      expect(appendix).not.toContain('body-4')
      expect(appendix).not.toContain('note-4.txt')
      expect(appendix).toContain('[1 more attached file was not inlined.]')
    } finally {
      timeout.mockRestore()
    }
  })

  it('does not follow a redirect or inline an HTML body', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = String(input)
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TEST_TOKEN}`)
      if (href.endsWith('/note.txt')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://files.slack.com/files-pri/T/note-2.txt' },
        })
      }
      if (href.endsWith('/offsite.txt')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/secret.txt' },
        })
      }
      return new Response('patch body', { status: 200, headers: { 'content-type': 'text/plain' } })
    })
    globalThis.fetch = fetchMock as typeof fetch
    try {
      const followed = await adapter.inlineSharedFiles([
        {
          id: 'Fredirect',
          name: 'note.txt',
          mimetype: 'text/plain',
          size: 20,
          urlPrivateDownload: 'https://files.slack.com/files-pri/T/note.txt',
        },
      ])
      expect(followed).toContain('patch body')
      expect(fetchMock).toHaveBeenCalledTimes(2)

      const redirected = await adapter.inlineSharedFiles([
        {
          id: 'Foffsite',
          name: 'offsite.txt',
          mimetype: 'text/plain',
          size: 20,
          urlPrivateDownload: 'https://files.slack.com/files-pri/T/offsite.txt',
        },
      ])
      expect(redirected).toContain('could not be read')
      expect(fetchMock.mock.calls.some(call => String(call[0]).includes('evil.example'))).toBe(
        false
      )

      fetchMock.mockResolvedValue(
        new Response('<html>sign in</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      )
      const html = await adapter.inlineSharedFiles([
        {
          id: 'Fhtml',
          name: 'note.txt',
          mimetype: 'text/plain',
          size: 20,
          urlPrivateDownload: 'https://files.slack.com/files-pri/T/page.txt',
        },
      ])
      expect(html).toContain('could not be read')
      expect(html).not.toContain('sign in')
    } finally {
      timeout.mockRestore()
    }
  })

  it('wraps a file body in a fence longer than its backtick run', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal)
    globalThis.fetch = vi.fn(
      async () => new Response('keep\n```\nsecret', { status: 200 })
    ) as typeof fetch
    try {
      const appendix = await adapter.inlineSharedFiles([
        {
          id: 'Ffence',
          name: 'note.txt',
          mimetype: 'text/plain',
          size: 20,
          urlPrivateDownload: 'https://files.slack.com/files-pri/T/note.txt',
        },
      ])
      expect(appendix).toContain('````')
      expect(appendix).toContain('secret')
    } finally {
      timeout.mockRestore()
    }
  })

  it('does not download a URL that is not https://files.slack.com', async () => {
    const adapter = new SlackAdapter()
    await adapter.connect({ slackBotToken: TEST_TOKEN })
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as typeof fetch
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const appendix = await adapter.inlineSharedFiles([
        {
          id: 'Fevil',
          name: 'secret.txt',
          mimetype: 'text/plain',
          size: 20,
          urlPrivateDownload: 'https://evil.example/secret.txt',
        },
        {
          id: 'Flookalike',
          name: 'lookalike.txt',
          mimetype: 'text/plain',
          size: 20,
          urlPrivateDownload: 'https://files.slack.com.evil.example/secret.txt',
        },
      ])

      expect(fetchMock).not.toHaveBeenCalled()
      expect(appendix).toContain('[Attached secret.txt, but the file could not be read.]')
      expect(appendix).toContain('[Attached lookalike.txt, but the file could not be read.]')
      const logged = consoleError.mock.calls.map(call => String(call[0])).join('\n')
      expect(logged).not.toContain('evil.example')
      expect(logged).not.toContain('secret')
      expect(logged).toContain('slack_file_url_rejected')
    } finally {
      consoleError.mockRestore()
    }
  })
})

// ── channelType ───────────────────────────────────────────────────────────────

describe('SlackAdapter — channelType', () => {
  it('reports channelType as slack', () => {
    const adapter = new SlackAdapter()
    expect(adapter.channelType).toBe('slack')
  })
})
