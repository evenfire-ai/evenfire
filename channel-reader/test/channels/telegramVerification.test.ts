import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TelegramAdapter } from '../../src/channels/telegram.js'

const grammy = vi.hoisted(() => ({
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

const mockCfg = vi.hoisted(() => ({
  mcpHostUrl: 'http://mcp-host.test',
  hostRef: 'agent-a',
  enableResponseAttachments: false,
  attachmentMaxCount: 3,
  attachmentMaxBytes: 52_428_800,
  telegramApiRoot: undefined as string | undefined,
  telegramStartupStabilityMs: 0,
  telegramShutdownGraceMs: 0,
}))

const PROVIDER_TARGET = {
  hostRef: 'agent-a',
  communicationChannelNamespace: 'channels',
  communicationChannelName: 'agent-a-telegram',
}

const PROVIDER_TARGET_WITH_BOT = {
  ...PROVIDER_TARGET,
  providerBotId: '888001',
  providerBotUsername: 'test_bot',
}

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(function () {
    const instance = {
      on: vi.fn(),
      catch: vi.fn(),
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
  InputFile: vi.fn(),
}))

vi.mock('../../src/config', () => ({
  get config() {
    return mockCfg
  },
}))

beforeEach(() => {
  grammy.instances.length = 0
  vi.clearAllMocks()
})

function getHandler() {
  const bot = grammy.instances[0]
  if (!bot) throw new Error('bot was not started')
  const call = bot.on.mock.calls.find((entry: unknown[]) => entry[0] === 'message:text')
  if (!call) throw new Error('message:text handler not registered')
  return call[1] as (ctx: unknown) => void
}

function makeCtx(text: string, chatType = 'private') {
  return {
    from: { id: 777, username: 'approver' },
    message: { text, message_id: 42, date: 1_700_000_000 },
    chat: { id: 777, type: chatType },
  }
}

function makeMismatchedPrivateCtx(text: string) {
  return {
    from: { id: 777, username: 'approver' },
    message: { text, message_id: 42, date: 1_700_000_000 },
    chat: { id: 778, type: 'private' },
  }
}

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('TelegramAdapter verification command', () => {
  it('confirms private /verify commands through provider identity before allowlist checks', async () => {
    const verificationClient = {
      confirmTelegramChallenge: vi.fn(async () => ({
        ok: true as const,
        accountId: 'account-1',
        userEmail: 'user@example.com',
      })),
    }
    const adapter = new TelegramAdapter(verificationClient)
    await adapter.connect({ telegramBotToken: '123456:test', providerTarget: PROVIDER_TARGET })

    getHandler()(makeCtx('/verify 123456'))
    await tick()

    expect(verificationClient.confirmTelegramChallenge).toHaveBeenCalledWith({
      code: '123456',
      providerUserId: '777',
      providerChannelId: '777',
      providerChannelType: 'private',
      providerChannelTitle: null,
      providerChannelHandle: null,
      providerTarget: PROVIDER_TARGET_WITH_BOT,
      providerTargets: [PROVIDER_TARGET_WITH_BOT],
    })
    expect(grammy.instances[0]!.api.sendMessage).toHaveBeenCalledWith(
      '777',
      'Telegram identity confirmed.'
    )
    await expect(adapter.fetchMessages('777', new Set(['777']))).resolves.toEqual([])
  })

  it('accepts the first message after confirmation before the next channel refresh', async () => {
    const verificationClient = {
      confirmTelegramChallenge: vi.fn(async () => ({
        ok: true as const,
        accountId: 'account-1',
        userEmail: 'user@example.com',
      })),
    }
    const adapter = new TelegramAdapter(verificationClient)
    await adapter.connect({ telegramBotToken: '123456:test', providerTarget: PROVIDER_TARGET })

    getHandler()(makeCtx('/verify 123456'))
    await tick()
    getHandler()(makeCtx('hello after verify'))

    const messages = await adapter.fetchMessages('777', new Set(['777']))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('hello after verify')
    expect(messages[0]!.providerIdentity?.providerTarget).toEqual(PROVIDER_TARGET_WITH_BOT)
  })

  it('confirms group /verify commands for the member who submitted the code', async () => {
    const verificationClient = {
      confirmTelegramChallenge: vi.fn(async () => ({
        ok: true as const,
        accountId: 'account-1',
        userEmail: 'user@example.com',
      })),
    }
    const adapter = new TelegramAdapter(verificationClient)
    await adapter.connect({ telegramBotToken: '123456:test', providerTarget: PROVIDER_TARGET })

    getHandler()(makeCtx('/verify 123456', 'supergroup'))
    await tick()

    expect(verificationClient.confirmTelegramChallenge).toHaveBeenCalledWith({
      code: '123456',
      providerUserId: '777',
      providerChannelId: '777',
      providerChannelType: 'supergroup',
      providerChannelTitle: null,
      providerChannelHandle: null,
      providerTarget: PROVIDER_TARGET_WITH_BOT,
      providerTargets: [PROVIDER_TARGET_WITH_BOT],
    })
    expect(grammy.instances[0]!.api.sendMessage).toHaveBeenCalledWith(
      '777',
      'Telegram identity confirmed.'
    )
  })

  it('rejects private /verify when Telegram chat id and sender id do not match', async () => {
    const verificationClient = {
      confirmTelegramChallenge: vi.fn(async () => ({
        ok: true as const,
        accountId: 'account-1',
        userEmail: 'user@example.com',
      })),
    }
    const adapter = new TelegramAdapter(verificationClient)
    await adapter.connect({ telegramBotToken: '123456:test', providerTarget: PROVIDER_TARGET })

    getHandler()(makeMismatchedPrivateCtx('/verify 123456'))
    await tick()

    expect(verificationClient.confirmTelegramChallenge).not.toHaveBeenCalled()
    expect(grammy.instances[0]!.api.sendMessage).toHaveBeenCalledWith(
      '778',
      'Verification failed. Check that the code is active and try again.'
    )
  })

  it('replies with a verification failure when the confirmation client rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const verificationClient = {
      confirmTelegramChallenge: vi.fn(async () => {
        throw new Error('control-api unavailable')
      }),
    }
    const adapter = new TelegramAdapter(verificationClient)
    await adapter.connect({ telegramBotToken: '123456:test', providerTarget: PROVIDER_TARGET })

    getHandler()(makeCtx('/verify 123456'))
    await tick()

    expect(verificationClient.confirmTelegramChallenge).toHaveBeenCalledWith({
      code: '123456',
      providerUserId: '777',
      providerChannelId: '777',
      providerChannelType: 'private',
      providerChannelTitle: null,
      providerChannelHandle: null,
      providerTarget: PROVIDER_TARGET_WITH_BOT,
      providerTargets: [PROVIDER_TARGET_WITH_BOT],
    })
    expect(grammy.instances[0]!.api.sendMessage).toHaveBeenCalledWith(
      '777',
      'Verification failed. Check that the code is active and try again.'
    )
    expect(warnSpy).toHaveBeenCalledWith(
      '[Telegram] Verification challenge confirmation failed:',
      'control-api unavailable'
    )
    warnSpy.mockRestore()
  })

  it('redacts verification codes from Telegram receive logs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const adapter = new TelegramAdapter({
      confirmTelegramChallenge: vi.fn(async () => ({ ok: false as const, error: 'invalid_code' })),
    })
    await adapter.connect({ telegramBotToken: '123456:test', providerTarget: PROVIDER_TARGET })

    getHandler()(makeCtx('/verify 654321'))
    await tick()

    expect(logSpy.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('654321')
    expect(logSpy.mock.calls.map(call => String(call[0])).join('\n')).toContain(
      '/verify [redacted]'
    )
    logSpy.mockRestore()
  })
})
