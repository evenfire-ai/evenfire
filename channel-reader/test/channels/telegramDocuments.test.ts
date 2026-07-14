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
  enableResponseAttachments: false,
  attachmentMaxCount: 3,
  attachmentMaxBytes: 52_428_800,
  telegramApiRoot: undefined as string | undefined,
  telegramStartupStabilityMs: 0,
  telegramShutdownGraceMs: 0,
}))

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(function () {
    const instance = {
      on: vi.fn(),
      catch: vi.fn(),
      start: vi.fn((opts?: { onStart?: (info: { username: string; id: number }) => void }) => {
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

vi.mock('../../src/config', () => ({
  get config() {
    return mockCfg
  },
}))

beforeEach(() => {
  grammy.instances.length = 0
  mockCfg.enableResponseAttachments = false
  mockCfg.attachmentMaxCount = 3
  mockCfg.attachmentMaxBytes = 52_428_800
  mockCfg.telegramApiRoot = undefined
  mockCfg.telegramStartupStabilityMs = 0
  mockCfg.telegramShutdownGraceMs = 0
})

describe('TelegramAdapter workflow documents', () => {
  it('sends workflow_result files as Telegram documents by default', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: '123456:AAFtest' })

    await adapter.sendMessage('111222', 'Workflow result is ready', '42', [
      {
        id: 'artifact-1',
        kind: 'file',
        mimeType: 'application/pdf',
        encoding: ['base', '64'].join('') as 'base64',
        dataBase64: Buffer.from('%PDF artifact bytes').toString('base' + '64'),
        filename: 'due-diligence.pdf',
        caption: 'due-diligence.pdf (19 bytes)',
        sourceTool: 'workflow_result',
      },
    ])

    const bot = grammy.instances[0]!
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '111222',
      'Workflow result is ready',
      expect.objectContaining({ reply_to_message_id: 42 })
    )
    expect(bot.api.sendDocument).toHaveBeenCalledTimes(1)
    const [, inputFile, options] = bot.api.sendDocument.mock.calls[0]
    expect(inputFile).toMatchObject({ filename: 'due-diligence.pdf' })
    expect(options).toMatchObject({
      caption: 'due-diligence.pdf (19 bytes)',
      reply_to_message_id: 42,
    })
  })

  it.each([
    ['clerum__generate_markdown', 'summary.md', 'text/markdown', 'md', Buffer.from('# Summary\n')],
    ['clerum__generate_pdf', 'summary.pdf', 'application/pdf', 'pdf', Buffer.from('%PDF bytes')],
    [
      'clerum__generate_docx',
      'summary.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'docx',
      Buffer.from('PK docx bytes'),
    ],
    [
      'clerum__generate_xlsx',
      'summary.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xlsx',
      Buffer.from('PK xlsx bytes'),
    ],
    [
      'clerum__generate_pptx',
      'summary.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'pptx',
      Buffer.from('PK pptx bytes'),
    ],
    ['clerum__generate_chart', 'summary.png', 'image/png', 'png', Buffer.from([0x89, 0x50])],
  ] as const)(
    'sends internal generated %s files as Telegram documents',
    async (sourceTool, filename, mimeType, artifactFormat, body) => {
      mockCfg.enableResponseAttachments = true
      const adapter = new TelegramAdapter()
      await adapter.connect({ telegramBotToken: '123456:AAFtest' })

      await adapter.sendMessage('111222', 'Generated file is ready', undefined, [
        {
          id: `internal-${artifactFormat}`,
          kind: 'file',
          mimeType,
          encoding: ['base', '64'].join('') as 'base64',
          dataBase64: body.toString('base' + '64'),
          filename,
          caption: `Generated artifact: ${filename}`,
          sourceTool,
          lane: 'internal_generated_artifact',
          artifactFormat,
          producer: 'mcp-host-internal-tool',
        },
      ])

      const bot = grammy.instances[0]!
      expect(bot.api.sendDocument).toHaveBeenCalledTimes(1)
      const [, inputFile, options] = bot.api.sendDocument.mock.calls[0]
      expect(inputFile).toMatchObject({ filename })
      expect(options).toMatchObject({ caption: `Generated artifact: ${filename}` })
    }
  )

  it('does not send generic file attachments from non-workflow and non-internal tools', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: '123456:AAFtest' })

    await adapter.sendMessage('111222', 'Tool response is ready', undefined, [
      {
        id: 'non-workflow-file',
        kind: 'file',
        mimeType: 'application/pdf',
        encoding: ['base', '64'].join('') as 'base64',
        dataBase64: Buffer.from('%PDF non-workflow bytes').toString('base' + '64'),
        filename: 'not-a-workflow-artifact.pdf',
        sourceTool: 'memory_search',
      },
    ])

    const bot = grammy.instances[0]!
    expect(bot.api.sendDocument).not.toHaveBeenCalled()
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '111222',
      'Tool response is ready',
      expect.objectContaining({})
    )
  })

  it('does not send internal generated documents when the lane or MIME does not match', async () => {
    mockCfg.enableResponseAttachments = true
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: '123456:AAFtest' })

    await adapter.sendMessage('111222', 'Generated file is ready', undefined, [
      {
        id: 'internal-html',
        kind: 'file',
        mimeType: 'text/html',
        encoding: ['base', '64'].join('') as 'base64',
        dataBase64: Buffer.from('<html></html>').toString('base' + '64'),
        filename: 'dashboard.html',
        sourceTool: 'clerum__generate_dashboard',
        lane: 'internal_generated_artifact',
        artifactFormat: 'html',
        producer: 'mcp-host-internal-tool',
      },
      {
        id: 'internal-mismatch',
        kind: 'file',
        mimeType: 'text/html',
        encoding: ['base', '64'].join('') as 'base64',
        dataBase64: Buffer.from('%PDF bytes').toString('base' + '64'),
        filename: 'summary.pdf',
        sourceTool: 'clerum__generate_pdf',
        lane: 'internal_generated_artifact',
        artifactFormat: 'pdf',
        producer: 'mcp-host-internal-tool',
      },
    ])

    const bot = grammy.instances[0]!
    expect(bot.api.sendDocument).not.toHaveBeenCalled()
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '111222',
      'Generated file is ready',
      expect.objectContaining({})
    )
  })

  it('falls back to safe text when Telegram document upload fails', async () => {
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: '123456:AAFtest' })
    const bot = grammy.instances[0]!
    bot.api.sendDocument.mockRejectedValueOnce(new Error('rate limited'))

    const messageId = await adapter.sendMessage('111222', 'Workflow result is ready', undefined, [
      {
        id: 'artifact-1',
        kind: 'file',
        mimeType: 'application/pdf',
        encoding: ['base', '64'].join('') as 'base64',
        dataBase64: Buffer.from('%PDF artifact bytes').toString('base' + '64'),
        filename: 'due-diligence.pdf',
        caption: 'due-diligence.pdf (19 bytes)',
        sourceTool: 'workflow_result',
      },
    ])

    expect(messageId).toBe('1')
    expect(bot.api.sendDocument).toHaveBeenCalledTimes(1)
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(
      1,
      '111222',
      'Workflow result is ready',
      expect.objectContaining({})
    )
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(
      2,
      '111222',
      'Generated document attachments could not be delivered.'
    )
  })

  it('does not upload oversized workflow_result documents', async () => {
    mockCfg.attachmentMaxBytes = 4
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: '123456:AAFtest' })

    await adapter.sendMessage('111222', 'Workflow result is ready', undefined, [
      {
        id: 'artifact-oversized',
        kind: 'file',
        mimeType: 'application/pdf',
        encoding: ['base', '64'].join('') as 'base64',
        dataBase64: Buffer.from('%PDF artifact bytes').toString('base' + '64'),
        filename: 'due-diligence.pdf',
        sourceTool: 'workflow_result',
      },
    ])

    const bot = grammy.instances[0]!
    expect(bot.api.sendDocument).not.toHaveBeenCalled()
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '111222',
      'Generated document attachments could not be delivered.'
    )
  })
})
