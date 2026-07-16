import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TelegramAdapter } from '../../src/channels/telegram.js'
import {
  TELEGRAM_WORKFLOW_RESULT_CALLBACK_DATA,
  telegramWorkflowApprovalCallbackData,
  telegramWorkflowResultCallbackData,
} from '../../src/telegramCallbackData.js'

// vi.hoisted() runs before vi.mock() factories and before imports —
// variables declared here are safely accessible inside vi.mock() closures.

const grammy = vi.hoisted(() => ({
  constructorCalls: [] as Array<{ token: string; config?: unknown }>,
  instances: [] as Array<{
    on: ReturnType<typeof vi.fn>
    catch: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    api: {
      sendMessage: ReturnType<typeof vi.fn>
      sendDocument: ReturnType<typeof vi.fn>
    }
  }>,
}))

// Mutable config object — tests can modify properties to simulate different config states.
// Using vi.hoisted so it's accessible inside the vi.mock() factory below.
const mockCfg = vi.hoisted(
  () =>
    ({
      enableResponseAttachments: false,
      attachmentMaxCount: 3,
      attachmentMaxBytes: 52_428_800,
      telegramApiRoot: undefined as string | undefined,
      telegramStartupStabilityMs: 0,
      telegramShutdownGraceMs: 0,
    }) as {
      enableResponseAttachments: boolean
      attachmentMaxCount: number
      attachmentMaxBytes: number
      telegramApiRoot?: string
      telegramStartupStabilityMs: number
      telegramShutdownGraceMs: number
    }
)

const TEST_TOKEN = '123456:AAFtest'
const PROVIDER_TARGET = {
  hostRef: 'agent-a',
  communicationChannelNamespace: 'channels',
  communicationChannelName: 'agent-a-telegram',
}

function telegramOptions(
  telegramChatType: 'private' | 'group' | 'supergroup' = 'private',
  overrides: Record<string, unknown> = {}
) {
  return { telegramChatType, providerTarget: PROVIDER_TARGET, ...overrides }
}

vi.mock('grammy', () => ({
  // Must use `function` (not arrow) so `new Bot()` works as a constructor call.
  Bot: vi.fn().mockImplementation(function (token: string, botConfig?: unknown) {
    grammy.constructorCalls.push({ token, config: botConfig })
    const instance = {
      on: vi.fn(),
      catch: vi.fn(),
      // Simulate bot.start() calling onStart synchronously so connected = true
      start: vi.fn(function (opts?: {
        onStart?: (info: { username: string; id: number }) => void
      }) {
        opts?.onStart?.({ username: 'test_bot', id: 888001 })
        return Promise.resolve()
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
        sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
      },
    }
    grammy.instances.push(instance)
    return instance
  }),
  InputFile: vi.fn(function (data: unknown, filename?: string) {
    return { _data: data, filename }
  }),
}))

// Use a getter so telegram.ts always reads the current mockCfg values
vi.mock('../../src/config', () => ({
  get config() {
    return mockCfg
  },
}))

beforeEach(() => {
  grammy.constructorCalls.length = 0
  grammy.instances.length = 0
  mockCfg.enableResponseAttachments = false
  mockCfg.telegramApiRoot = undefined
  mockCfg.telegramStartupStabilityMs = 0
  mockCfg.telegramShutdownGraceMs = 0
})

// ── Helpers ──

function getMessageHandler(bot: { on: ReturnType<typeof vi.fn> }) {
  const call = bot.on.mock.calls.find((c: unknown[]) => c[0] === 'message:text')
  if (!call) throw new Error('message:text handler not registered on bot')
  return call[1] as (ctx: unknown) => void
}

function getCallbackHandler(bot: { on: ReturnType<typeof vi.fn> }) {
  const call = bot.on.mock.calls.find((c: unknown[]) => c[0] === 'callback_query:data')
  if (!call) throw new Error('callback_query:data handler not registered on bot')
  return call[1] as (ctx: unknown) => Promise<void>
}

function makeCallbackCtx(opts: {
  senderId: string
  data: string
  chatId?: string
  callbackId?: string
  messageId?: number
  epochSeconds?: number
  chatType?: string
}) {
  return {
    from: { id: parseInt(opts.senderId, 10), username: 'testuser' },
    callbackQuery: {
      id: opts.callbackId ?? 'callback-1',
      data: opts.data,
      message: {
        message_id: opts.messageId ?? 77,
        date: opts.epochSeconds ?? Math.floor(Date.now() / 1000),
        chat: { id: parseInt(opts.chatId ?? '111222', 10), type: opts.chatType ?? 'private' },
      },
    },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  }
}

function makeCtx(opts: {
  senderId: string
  text?: string
  chatId?: string
  messageId?: number
  epochSeconds?: number
  chatType?: string
  entities?: Array<{ type: string; offset: number; length: number; user?: { id: number } }>
  replyToFromId?: number
}) {
  const message: Record<string, unknown> = {
    text: opts.text ?? 'hello world',
    message_id: opts.messageId ?? 42,
    date: opts.epochSeconds ?? Math.floor(Date.now() / 1000),
  }
  if (opts.entities) {
    message.entities = opts.entities
  }
  if (opts.replyToFromId != null) {
    message.reply_to_message = { from: { id: opts.replyToFromId } }
  }
  return {
    from: { id: parseInt(opts.senderId, 10), username: 'testuser' },
    message,
    chat: { id: parseInt(opts.chatId ?? '111222', 10), type: opts.chatType ?? 'private' },
  }
}

// ── connect() ──

describe('TelegramAdapter — connect()', () => {
  it('creates a Bot with the configured token', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    expect(grammy.instances).toHaveLength(1)
    expect(grammy.constructorCalls[0]).toEqual({ token: TEST_TOKEN, config: undefined })
    // Bot constructor was called, so instances array has one entry
    const bot = grammy.instances[0]!
    expect(bot.start).toHaveBeenCalledOnce()
  })

  it('uses the configured Telegram API root when provided', async () => {
    mockCfg.telegramApiRoot = 'http://telegram-api.channels.svc.cluster.local:443'

    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    expect(grammy.constructorCalls[0]).toEqual({
      token: TEST_TOKEN,
      config: {
        client: { apiRoot: 'http://telegram-api.channels.svc.cluster.local:443' },
      },
    })
  })

  it('registers a message:text handler on the bot', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    expect(bot.on).toHaveBeenCalledWith('message:text', expect.any(Function))
  })

  it('registers a callback_query:data handler on the bot', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    expect(bot.on).toHaveBeenCalledWith('callback_query:data', expect.any(Function))
  })

  it('calls bot.start() to begin polling', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    expect(bot.start).toHaveBeenCalledOnce()
  })

  it('does nothing when telegramBotToken is not configured', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: undefined })

    // No Bot instance should be created
    expect(grammy.instances).toHaveLength(0)
  })
})

// ── disconnect() ──

describe('TelegramAdapter — disconnect()', () => {
  it('calls bot.stop() and nullifies internal bot reference', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    await adapter.disconnect()

    expect(bot.stop).toHaveBeenCalledOnce()
  })

  it('is safe to call disconnect() without connect()', async () => {
    const adapter = new TelegramAdapter()
    await expect(adapter.disconnect()).resolves.toBeUndefined()
  })

  it('is safe to call disconnect() twice', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    await adapter.disconnect()
    await expect(adapter.disconnect()).resolves.toBeUndefined()
  })
})

// ── fetchMessages() ──

describe('TelegramAdapter — fetchMessages()', () => {
  it('returns empty array when no messages have arrived', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const messages = await adapter.fetchMessages('111222', new Set(['123456']), telegramOptions())
    expect(messages).toEqual([])
  })

  it('returns and clears pending messages from the buffer', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)

    // Set allowed senders first via a fetchMessages call
    await adapter.fetchMessages('111222', new Set(['123456']), telegramOptions())
    // Then simulate an incoming message
    handler(makeCtx({ senderId: '123456', text: 'Hi there', chatId: '111222' }))

    const messages = await adapter.fetchMessages('111222', new Set(['123456']), telegramOptions())
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('Hi there')
    expect(messages[0]!.channelType).toBe('telegram')
    expect(messages[0]!.sender).toBe('123456')

    // Second call should drain to empty — buffer was cleared
    const messages2 = await adapter.fetchMessages('111222', new Set(['123456']), telegramOptions())
    expect(messages2).toHaveLength(0)
  })

  it('ignores messages from unauthorized senders', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)

    // Set allowed senders to only "999999"
    await adapter.fetchMessages('111222', new Set(['999999']), telegramOptions())

    // Simulate a message from unauthorized sender "123456"
    handler(makeCtx({ senderId: '123456', text: 'I am not allowed' }))

    // The message should be dropped
    const messages = await adapter.fetchMessages('111222', new Set(['999999']), telegramOptions())
    expect(messages).toHaveLength(0)
  })

  it('updates allowed senders on each fetchMessages call', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)

    // First poll sets senders to only "999999"
    await adapter.fetchMessages('111222', new Set(['999999']), telegramOptions())

    // Message from allowed sender "999999" arrives
    handler(makeCtx({ senderId: '999999', text: 'Allowed' }))

    const messages = await adapter.fetchMessages('111222', new Set(['999999']), telegramOptions())
    expect(messages).toHaveLength(1)
    expect(messages[0]!.sender).toBe('999999')
  })

  it('accumulates multiple messages before draining', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)
    await adapter.fetchMessages('111222', new Set(['111', '222']), telegramOptions())

    handler(makeCtx({ senderId: '111', text: 'msg 1', messageId: 1 }))
    handler(makeCtx({ senderId: '222', text: 'msg 2', messageId: 2 }))
    handler(makeCtx({ senderId: '111', text: 'msg 3', messageId: 3 }))

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['111', '222']),
      telegramOptions()
    )
    expect(messages).toHaveLength(3)
    expect(messages.map(m => m.content)).toEqual(['msg 1', 'msg 2', 'msg 3'])
  })

  it('maps message fields correctly (channelId, messageId, timestamp)', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)
    const epochSeconds = 1_700_000_000

    await adapter.fetchMessages('111222', new Set(['123456']), telegramOptions())
    handler({
      from: { id: 123456, username: 'alice' },
      message: { text: 'timestamp test', message_id: 99, date: epochSeconds },
      chat: { id: 111222, type: 'private' },
    })

    const [msg] = await adapter.fetchMessages('111222', new Set(['123456']), telegramOptions())
    expect(msg!.channelId).toBe('111222')
    expect(msg!.messageId).toBe('99')
    expect(msg!.timestamp).toEqual(new Date(epochSeconds * 1000))
    expect(msg!.providerIdentity).toEqual({
      medium: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: '111222',
      providerChannelType: 'private',
      providerEventId: 'telegram:111222:99',
      providerTarget: {
        ...PROVIDER_TARGET,
        providerBotId: '888001',
        providerBotUsername: 'test_bot',
      },
    })
  })

  it('with replyOnlyWhenMentioned, drops group messages without mention or reply', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)

    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    handler(
      makeCtx({
        senderId: '123456',
        text: 'no mention',
        chatId: '111222',
        chatType: 'group',
      })
    )

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(0)
  })

  it('with replyOnlyWhenMentioned, accepts @mention of bot in groups', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)
    const text = '@test_bot hello'
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    handler(
      makeCtx({
        senderId: '123456',
        text,
        chatId: '111222',
        chatType: 'group',
        entities: [{ type: 'mention', offset: 0, length: 9 }],
      })
    )

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe(text)
  })

  it('with replyOnlyWhenMentioned, accepts reply to bot in groups', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    handler(
      makeCtx({
        senderId: '123456',
        text: 'thread reply',
        chatId: '111222',
        chatType: 'group',
        replyToFromId: 888001,
      })
    )

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(1)
  })

  it('with replyOnlyWhenMentioned, private chats still accept messages without mention', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('private', { replyOnlyWhenMentioned: true })
    )
    handler(makeCtx({ senderId: '123456', text: 'dm', chatId: '111222', chatType: 'private' }))

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('private', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(1)
  })

  it('with replyOnlyWhenMentioned, /approve bypasses mention requirement', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    handler(
      makeCtx({
        senderId: '123456',
        text: '/approve',
        chatId: '111222',
        chatType: 'group',
      })
    )

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(1)
  })

  it('with replyOnlyWhenMentioned, drops group messages when bot id is not available', async () => {
    const { Bot } = await import('grammy')
    vi.mocked(Bot).mockImplementationOnce(function () {
      const instance = {
        on: vi.fn(),
        catch: vi.fn(),
        start: vi.fn(function (opts?: { onStart?: (info: { username: string }) => void }) {
          opts?.onStart?.({ username: 'test_bot' })
          return Promise.resolve()
        }),
        stop: vi.fn().mockResolvedValue(undefined),
        api: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
          sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
        },
      }
      grammy.instances.push(instance)
      return instance
    })

    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[grammy.instances.length - 1]!
    const handler = getMessageHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    handler(
      makeCtx({
        senderId: '123456',
        text: '@test_bot hi',
        chatId: '111222',
        chatType: 'group',
        entities: [{ type: 'mention', offset: 0, length: 9 }],
      })
    )
    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(0)
  })

  it('with replyOnlyWhenMentioned, logs warn when dropping group message before bot id is ready', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { Bot } = await import('grammy')
    vi.mocked(Bot).mockImplementationOnce(function () {
      const instance = {
        on: vi.fn(),
        catch: vi.fn(),
        start: vi.fn(function (opts?: { onStart?: (info: { username: string }) => void }) {
          opts?.onStart?.({ username: 'test_bot' })
          return Promise.resolve()
        }),
        stop: vi.fn().mockResolvedValue(undefined),
        api: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
          sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
        },
      }
      grammy.instances.push(instance)
      return instance
    })

    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[grammy.instances.length - 1]!
    const handler = getMessageHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    handler(makeCtx({ senderId: '123456', text: 'early', chatId: '111222', chatType: 'group' }))

    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('bot id not available yet'))).toBe(
      true
    )
    warnSpy.mockRestore()
  })

  it('warns once when replyOnlyWhenMentioned is set but the bot has no @username', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { Bot } = await import('grammy')
    vi.mocked(Bot).mockImplementationOnce(function () {
      const instance = {
        on: vi.fn(),
        catch: vi.fn(),
        start: vi.fn(function (opts?: {
          onStart?: (info: { username: string; id: number }) => void
        }) {
          opts?.onStart?.({ username: '', id: 888001 })
          return Promise.resolve()
        }),
        stop: vi.fn().mockResolvedValue(undefined),
        api: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
          sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
        },
      }
      grammy.instances.push(instance)
      return instance
    })

    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )

    const noUsernameWarns = warnSpy.mock.calls.filter(c =>
      String(c[0]).includes('replyOnlyWhenMentioned is enabled but this bot has no @username')
    )
    expect(noUsernameWarns.length).toBe(1)
    warnSpy.mockRestore()
  })

  it('with replyOnlyWhenMentioned and no @username, accepts text_mention of bot id in groups', async () => {
    const { Bot } = await import('grammy')
    vi.mocked(Bot).mockImplementationOnce(function () {
      const instance = {
        on: vi.fn(),
        catch: vi.fn(),
        start: vi.fn(function (opts?: {
          onStart?: (info: { username: string; id: number }) => void
        }) {
          opts?.onStart?.({ username: '', id: 888001 })
          return Promise.resolve()
        }),
        stop: vi.fn().mockResolvedValue(undefined),
        api: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
          sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
        },
      }
      grammy.instances.push(instance)
      return instance
    })

    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[grammy.instances.length - 1]!
    const handler = getMessageHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    handler(
      makeCtx({
        senderId: '123456',
        text: 'hey',
        chatId: '111222',
        chatType: 'group',
        entities: [{ type: 'text_mention', offset: 0, length: 3, user: { id: 888001 } }],
      })
    )
    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(1)
  })

  it('with replyOnlyWhenMentioned, /approve always and /deny bypass in group', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )

    handler(
      makeCtx({
        senderId: '123456',
        text: '/approve always',
        chatId: '111222',
        chatType: 'group',
      })
    )
    let messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('/approve always')

    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    handler(
      makeCtx({
        senderId: '123456',
        text: '/deny',
        messageId: 2,
        chatId: '111222',
        chatType: 'group',
      })
    )
    messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('/deny')
  })

  it('handles Telegram supergroups like configured groups for operational commands', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('supergroup', { replyOnlyWhenMentioned: true })
    )

    handler(
      makeCtx({
        senderId: '123456',
        text: '@test_bot in supergroup',
        chatId: '111222',
        chatType: 'supergroup',
        entities: [{ type: 'mention', offset: 0, length: 9 }],
      })
    )

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('supergroup', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]!.providerIdentity?.providerChannelType).toBe('supergroup')
  })

  it('with replyOnlyWhenMentioned, channel chat type is ignored even when mentioned', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    handler(
      makeCtx({
        senderId: '123456',
        text: 'broadcast without mention',
        chatId: '111222',
        chatType: 'channel',
      })
    )
    let messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(0)

    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    handler(
      makeCtx({
        senderId: '123456',
        text: '@test_bot in channel',
        chatId: '111222',
        chatType: 'channel',
        messageId: 3,
        entities: [{ type: 'mention', offset: 0, length: 9 }],
      })
    )
    messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(0)
  })

  it('with replyOnlyWhenMentioned and no @username, @mention entity alone does not qualify in groups', async () => {
    const { Bot } = await import('grammy')
    vi.mocked(Bot).mockImplementationOnce(function () {
      const instance = {
        on: vi.fn(),
        catch: vi.fn(),
        start: vi.fn(function (opts?: {
          onStart?: (info: { username: string; id: number }) => void
        }) {
          opts?.onStart?.({ username: '', id: 888001 })
          return Promise.resolve()
        }),
        stop: vi.fn().mockResolvedValue(undefined),
        api: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
          sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
        },
      }
      grammy.instances.push(instance)
      return instance
    })

    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[grammy.instances.length - 1]!
    const handler = getMessageHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    const text = '@other hi'
    handler(
      makeCtx({
        senderId: '123456',
        text,
        chatId: '111222',
        chatType: 'group',
        entities: [{ type: 'mention', offset: 0, length: 6 }],
      })
    )
    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(0)
  })

  it('accepts workflow approval button callbacks even when mentions are required', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getCallbackHandler(bot)
    const approvalRequestId = '00000000-0000-0000-0000-000000000222'
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )

    const ctx = makeCallbackCtx({
      senderId: '123456',
      data: telegramWorkflowApprovalCallbackData('approve', approvalRequestId),
      chatId: '111222',
      chatType: 'group',
      callbackId: 'callback-approve-1',
      messageId: 77,
    })
    await handler(ctx)

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('/approve ' + approvalRequestId)
    expect(messages[0]!.messageId).toBe('77')
    expect(messages[0]!.rawData).toMatchObject({
      telegramCallbackApprovalRequestId: approvalRequestId,
      telegramCallbackDecision: 'approve',
    })
    expect(messages[0]!.providerIdentity).toMatchObject({
      providerUserId: '123456',
      providerChannelId: '111222',
      providerEventId: 'telegram:111222:callback:callback-approve-1',
    })
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Recording decision...',
      show_alert: false,
    })
  })

  it('accepts tool approval button callbacks even when mentions are required', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getCallbackHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('supergroup', { replyOnlyWhenMentioned: true })
    )

    const ctx = makeCallbackCtx({
      senderId: '123456',
      data: 'tool:a:abcdefghijklmnop',
      chatId: '111222',
      chatType: 'supergroup',
      callbackId: 'callback-tool-approve-1',
      messageId: 77,
    })
    await handler(ctx)

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('supergroup', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      content: 'tool:a:abcdefghijklmnop',
      messageId: '77',
      rawData: {
        telegramToolApprovalActionToken: 'abcdefghijklmnop',
        telegramToolApprovalDecision: 'approve',
      },
    })
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Recording decision...',
      show_alert: false,
    })
  })

  it('ignores repeated approval button callbacks from the same user for two seconds', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getCallbackHandler(bot)
    const approvalRequestId = '00000000-0000-0000-0000-000000000222'
    await adapter.fetchMessages('111222', new Set(['123456']), telegramOptions('group'))

    const approveCtx = makeCallbackCtx({
      senderId: '123456',
      data: telegramWorkflowApprovalCallbackData('approve', approvalRequestId),
      chatId: '111222',
      chatType: 'group',
      callbackId: 'callback-approve-1',
      messageId: 77,
    })
    await handler(approveCtx)

    const denyCtx = makeCallbackCtx({
      senderId: '123456',
      data: telegramWorkflowApprovalCallbackData('deny', approvalRequestId),
      chatId: '111222',
      chatType: 'group',
      callbackId: 'callback-deny-1',
      messageId: 77,
    })
    await handler(denyCtx)

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group')
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('/approve ' + approvalRequestId)
    expect(approveCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Recording decision...',
      show_alert: false,
    })
    expect(denyCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Already recording decision.',
      show_alert: false,
    })
  })

  it('allows the same approval button after the debounce window so stale clicks are checked', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getCallbackHandler(bot)
    const approvalRequestId = '00000000-0000-0000-0000-000000000222'
    await adapter.fetchMessages('111222', new Set(['123456']), telegramOptions('group'))

    const dateNow = vi.spyOn(Date, 'now')
    try {
      dateNow.mockReturnValueOnce(1_000)
      await handler(
        makeCallbackCtx({
          senderId: '123456',
          data: telegramWorkflowApprovalCallbackData('approve', approvalRequestId),
          chatId: '111222',
          chatType: 'group',
          callbackId: 'callback-approve-1',
          messageId: 77,
          epochSeconds: 1,
        })
      )

      dateNow.mockReturnValueOnce(3_001)
      await handler(
        makeCallbackCtx({
          senderId: '123456',
          data: telegramWorkflowApprovalCallbackData('deny', approvalRequestId),
          chatId: '111222',
          chatType: 'group',
          callbackId: 'callback-deny-1',
          messageId: 77,
          epochSeconds: 3,
        })
      )
    } finally {
      dateNow.mockRestore()
    }

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group')
    )
    expect(messages.map(message => message.content)).toEqual([
      '/approve ' + approvalRequestId,
      '/deny ' + approvalRequestId,
    ])
  })

  it('ignores repeated workflow result button callbacks from the same user for two seconds', async () => {
    const workflowRunId = '11111111-2222-3333-4444-555555555555'
    const downloadWorkflowResultByRun = vi.fn(async () => ({
      success: true,
      status: 'completed' as const,
      response: 'Workflow result is ready.',
    }))
    const adapter = new TelegramAdapter({
      confirmTelegramChallenge: vi.fn(),
      downloadWorkflowResultByRun,
    })
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getCallbackHandler(bot)
    await adapter.fetchMessages('111222', new Set(['123456']), telegramOptions('group'))

    const firstCtx = makeCallbackCtx({
      senderId: '123456',
      data: telegramWorkflowResultCallbackData(workflowRunId)!,
      chatId: '111222',
      chatType: 'group',
      callbackId: 'callback-result-1',
      messageId: 78,
    })
    await handler(firstCtx)

    const secondCtx = makeCallbackCtx({
      senderId: '123456',
      data: telegramWorkflowResultCallbackData(workflowRunId)!,
      chatId: '111222',
      chatType: 'group',
      callbackId: 'callback-result-2',
      messageId: 78,
    })
    await handler(secondCtx)
    await Promise.resolve()

    expect(downloadWorkflowResultByRun).toHaveBeenCalledTimes(1)
    expect(firstCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Fetching result...',
      show_alert: false,
    })
    expect(secondCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Already fetching result.',
      show_alert: false,
    })
  })

  it('downloads workflow result button callbacks directly without enqueuing chat prompts', async () => {
    const workflowRunId = '11111111-2222-3333-4444-555555555555'
    const downloadWorkflowResultByRun = vi.fn(async () => ({
      success: true,
      status: 'completed' as const,
      response: 'Workflow result is ready.',
      attachments: [
        {
          id: 'artifact-1',
          kind: 'file' as const,
          mimeType: 'application/pdf',
          encoding: 'base64' as const,
          dataBase64: Buffer.from('%PDF artifact bytes').toString('base' + '64'),
          filename: 'due-diligence.pdf',
          caption: 'due-diligence.pdf (19 bytes)',
          sourceTool: 'workflow_result',
        },
      ],
    }))
    const adapter = new TelegramAdapter({
      confirmTelegramChallenge: vi.fn(),
      downloadWorkflowResultByRun,
    })
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getCallbackHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )

    const ctx = makeCallbackCtx({
      senderId: '123456',
      data: telegramWorkflowResultCallbackData(workflowRunId)!,
      chatId: '111222',
      chatType: 'group',
      callbackId: 'callback-result-1',
      messageId: 78,
    })
    await handler(ctx)

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(0)
    expect(downloadWorkflowResultByRun).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: 'telegram',
        channelId: '111222',
        sender: '123456',
        content: 'Download the completed workflow result',
        messageId: '78',
        providerIdentity: expect.objectContaining({
          providerUserId: '123456',
          providerChannelId: '111222',
          providerEventId: 'telegram:111222:callback:callback-result-1',
        }),
      }),
      workflowRunId
    )
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Fetching result...',
      show_alert: false,
    })
  })

  it('does not enqueue legacy workflow result callbacks without a workflow run', async () => {
    const downloadWorkflowResultByRun = vi.fn()
    const adapter = new TelegramAdapter({
      confirmTelegramChallenge: vi.fn(),
      downloadWorkflowResultByRun,
    })
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getCallbackHandler(bot)
    await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )

    const ctx = makeCallbackCtx({
      senderId: '123456',
      data: TELEGRAM_WORKFLOW_RESULT_CALLBACK_DATA,
      chatId: '111222',
      chatType: 'group',
      callbackId: 'callback-result-legacy',
      messageId: 79,
    })
    await handler(ctx)

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['123456']),
      telegramOptions('group', { replyOnlyWhenMentioned: true })
    )
    expect(messages).toHaveLength(0)
    expect(downloadWorkflowResultByRun).not.toHaveBeenCalled()
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '111222',
      'This result button is missing its workflow run. Trigger the workflow again.',
      expect.objectContaining({ reply_to_message_id: 79 })
    )
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Fetching result...',
      show_alert: false,
    })
  })

  it('rejects button callbacks from unauthorized Telegram senders', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const bot = grammy.instances[0]!
    const handler = getCallbackHandler(bot)
    await adapter.fetchMessages('111222', new Set(['999999']), telegramOptions('group'))

    const ctx = makeCallbackCtx({
      senderId: '123456',
      data: TELEGRAM_WORKFLOW_RESULT_CALLBACK_DATA,
      chatId: '111222',
      chatType: 'group',
      callbackId: 'callback-denied-1',
    })
    await handler(ctx)

    const messages = await adapter.fetchMessages(
      '111222',
      new Set(['999999']),
      telegramOptions('group')
    )
    expect(messages).toHaveLength(0)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'You are not authorized to use this button.',
      show_alert: true,
    })
  })
})

// ── sendMessage() ──

describe('TelegramAdapter — sendMessage()', () => {
  it('sends a text message via bot.api.sendMessage', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    await adapter.sendMessage('111222', 'Hello from Clerum')

    const bot = grammy.instances[0]!
    // channelId is passed as-is (string), 3rd arg is the options object
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '111222',
      'Hello from Clerum',
      expect.objectContaining({})
    )
  })

  it('sends inline keyboard buttons as Telegram reply markup', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    await adapter.sendMessage('111222', 'Approval needed', undefined, undefined, {
      telegramInlineKeyboard: [
        [
          {
            text: 'Approve',
            callbackData: telegramWorkflowApprovalCallbackData(
              'approve',
              '00000000-0000-0000-0000-000000000222'
            ),
          },
        ],
      ],
    })

    const bot = grammy.instances[0]!
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '111222',
      'Approval needed',
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Approve',
                callback_data: 'wf:a:00000000-0000-0000-0000-000000000222',
              },
            ],
          ],
        },
      })
    )
  })

  it('updates tool approval keyboards and clears them from progress messages', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[0]!
    const editMessageText = vi.fn().mockResolvedValue({ message_id: 1 })
    ;(bot.api as typeof bot.api & { editMessageText: typeof editMessageText }).editMessageText =
      editMessageText

    await adapter.editMessage('111222', '77', 'Approval needed', {
      telegramInlineKeyboard: [
        [
          { text: 'Approve', callbackData: 'tool:a:abcdefghijklmnop' },
          { text: 'Deny', callbackData: 'tool:d:abcdefghijklmnop' },
        ],
      ],
    })
    await adapter.editMessage('111222', '77', 'Approved. Processing...')

    expect(editMessageText).toHaveBeenNthCalledWith(1, '111222', 77, 'Approval needed', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: 'tool:a:abcdefghijklmnop' },
            { text: 'Deny', callback_data: 'tool:d:abcdefghijklmnop' },
          ],
        ],
      },
    })
    expect(editMessageText).toHaveBeenNthCalledWith(2, '111222', 77, 'Approved. Processing...', {
      reply_markup: { inline_keyboard: [] },
    })
  })

  it('does nothing when bot is not connected (no prior connect())', async () => {
    const adapter = new TelegramAdapter()

    await expect(adapter.sendMessage('111222', 'Should not send')).resolves.toBeUndefined()
    expect(grammy.instances).toHaveLength(0)
  })

  it('splits long messages (>4096 chars) into multiple api calls', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    const longText = 'A'.repeat(8200)
    await adapter.sendMessage('111222', longText)

    const bot = grammy.instances[0]!
    expect(bot.api.sendMessage.mock.calls.length).toBeGreaterThan(1)
  })

  it('passes replyToMessageId as reply_to_message_id', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    await adapter.sendMessage('111222', 'Reply!', '42')

    const bot = grammy.instances[0]!
    const callArgs = bot.api.sendMessage.mock.calls[0]
    // telegram.ts uses the legacy reply_to_message_id field (not reply_parameters)
    expect(callArgs[2]).toMatchObject({ reply_to_message_id: 42 })
  })

  it('sends workflow artifact documents without a separate text message when content is empty', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    await adapter.sendMessage('111222', '', '42', [
      {
        id: 'artifact-1',
        kind: 'file',
        mimeType: 'application/pdf',
        encoding: 'base64',
        dataBase64: Buffer.from('%PDF artifact bytes').toString('base' + '64'),
        filename: 'due-diligence.pdf',
        caption: 'due-diligence.pdf (19 bytes)',
        sourceTool: 'workflow_result',
      },
    ])

    const bot = grammy.instances[0]!
    expect(bot.api.sendMessage).not.toHaveBeenCalled()
    expect(bot.api.sendDocument).toHaveBeenCalledTimes(1)
    const [, inputFile, options] = bot.api.sendDocument.mock.calls[0]
    expect(inputFile).toMatchObject({ filename: 'due-diligence.pdf' })
    expect(options).toMatchObject({
      caption: 'due-diligence.pdf (19 bytes)',
      reply_to_message_id: 42,
    })
  })

  it('does not send unsupported workflow artifact document types', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: TEST_TOKEN })

    await adapter.sendMessage('111222', 'Workflow result is ready', undefined, [
      {
        id: 'artifact-zip',
        kind: 'file',
        mimeType: 'application/zip',
        encoding: 'base64',
        dataBase64: Buffer.from('zip bytes').toString('base' + '64'),
        filename: 'archive.zip',
        sourceTool: 'workflow_result',
      },
    ])

    const bot = grammy.instances[0]!
    expect(bot.api.sendDocument).not.toHaveBeenCalled()
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '111222',
      'Workflow result is ready',
      expect.objectContaining({})
    )
  })
})

// ── channelType ──

describe('TelegramAdapter — channelType', () => {
  it('reports channelType as telegram', () => {
    const adapter = new TelegramAdapter()
    expect(adapter.channelType).toBe('telegram')
  })
})
