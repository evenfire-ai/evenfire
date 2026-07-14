import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TelegramAdapter } from '../../src/channels/telegram.js'

const grammy = vi.hoisted(() => ({
  instances: [] as Array<{
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    catch: ReturnType<typeof vi.fn>
    api: { sendMessage: ReturnType<typeof vi.fn> }
  }>,
}))

const mockCfg = vi.hoisted(() => ({
  telegramApiRoot: undefined as string | undefined,
  telegramStartupStabilityMs: 1,
  telegramShutdownGraceMs: 0,
  enableResponseAttachments: false,
  attachmentMaxCount: 3,
  attachmentMaxBytes: 52_428_800,
}))

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(function () {
    const instance = {
      on: vi.fn(),
      catch: vi.fn(),
      start: vi.fn((opts?: { onStart?: (info: { username: string; id: number }) => void }) => {
        opts?.onStart?.({ username: 'test_bot', id: 888001 })
        return Promise.reject(new Error("Call to 'getUpdates' failed! (409: Conflict)"))
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      },
    }
    grammy.instances.push(instance)
    return instance
  }),
  InputFile: vi.fn(function (data: unknown, filename?: string) {
    return { _data: data, filename }
  }),
}))

vi.mock('../../src/config', () => ({
  get config() {
    return mockCfg
  },
}))

beforeEach(() => {
  grammy.instances.length = 0
  mockCfg.telegramStartupStabilityMs = 1
  mockCfg.telegramShutdownGraceMs = 0
})

describe('TelegramAdapter startup stability', () => {
  it('rejects connect when polling fails immediately after onStart', async () => {
    const adapter = new TelegramAdapter()

    await expect(adapter.connect({ telegramBotToken: '123456:AAFtest' })).rejects.toThrow(
      '409: Conflict'
    )

    await adapter.sendMessage('111222', 'should not send')
    expect(grammy.instances[0]!.api.sendMessage).not.toHaveBeenCalled()
  })
})
