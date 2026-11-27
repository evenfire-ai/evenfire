import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  TELEGRAM_DOWNLOAD_TIMEOUT_MS,
  TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS,
  TelegramAdapter,
} from '../channels/telegram'
import { ChannelReader } from '../main'
import { RPCClient } from '../rpcClient'
import type { ChannelAttachmentIngestMetadataV1, ProviderAttachmentDescriptorV1 } from '../types'

const grammy = vi.hoisted(() => ({
  instances: [] as Array<{
    on: ReturnType<typeof vi.fn>
    catch: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    api: {
      sendMessage: ReturnType<typeof vi.fn>
      sendDocument: ReturnType<typeof vi.fn>
      getFile: ReturnType<typeof vi.fn>
    }
  }>,
}))

const mockCfg = vi.hoisted(() => ({
  devMode: true,
  hostRef: 'agent-a',
  mcpHostUrl: 'http://mcp-host.test',
  namespace: 'channels',
  pollIntervalSeconds: 2,
  enableResponseAttachments: false,
  attachmentMaxCount: 3,
  attachmentMaxBytes: 52_428_800,
  channelAttachmentMaxBytes: 20_971_520,
  channelAttachmentMaxCount: 10,
  perConversationQueueMaxDepth: 64,
  telegramApiRoot: 'https://api.telegram.org' as string | undefined,
  telegramStartupStabilityMs: 0,
  telegramShutdownGraceMs: 0,
  channelReaderHandoffPort: 8099,
  channelReaderHandoffToken: '',
  notificationDeliveryPollLimit: 10,
  emailImapPort: 993,
  emailSmtpPort: 587,
}))

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
        getFile: vi.fn(),
      },
    }
    grammy.instances.push(instance)
    return instance
  }),
  InputFile: vi.fn(),
}))

vi.mock('../config', () => ({
  get config() {
    return mockCfg
  },
}))

const TEST_TOKEN = '123456:AAFtelegram-test-token'
const PROVIDER_TARGET = {
  hostRef: 'agent-a',
  communicationChannelNamespace: 'channels',
  communicationChannelName: 'agent-a-telegram',
}

function getMessageHandler(bot: { on: ReturnType<typeof vi.fn> }) {
  const call = bot.on.mock.calls.find((entry: unknown[]) => entry[0] === 'message')
  if (!call) throw new Error('message handler not registered on Telegram bot')
  return call[1] as (ctx: unknown) => void
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

beforeEach(() => {
  grammy.instances.length = 0
  mockCfg.telegramApiRoot = 'https://api.telegram.org'
  mockCfg.channelAttachmentMaxBytes = 20_971_520
  mockCfg.channelAttachmentMaxCount = 10
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Telegram inbound attachments (X6)', () => {
  it('S1 · extracts_all_media_kinds_with_caption', async () => {
    const adapter = new TelegramAdapter(null)
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)

    await adapter.fetchMessages('111222', new Set(['123456']), {
      telegramChatType: 'private',
      providerTarget: PROVIDER_TARGET,
    })

    const payloads: Array<{
      kind: string
      msg: Record<string, unknown>
      expectedFileId: string
      expectedFilename: string | null
      expectedBytes: Buffer
    }> = [
      {
        kind: 'photo',
        msg: {
          message_id: 101,
          date: 1700000101,
          caption: 'photo caption',
          photo: [
            {
              file_id: 'photo-small',
              file_unique_id: 'u-photo-small',
              width: 90,
              height: 90,
              file_size: 200,
            },
            {
              file_id: 'photo-large',
              file_unique_id: 'u-photo-large',
              width: 1280,
              height: 960,
              file_size: 4096,
            },
          ],
        },
        expectedFileId: 'photo-large',
        expectedFilename: null,
        expectedBytes: Buffer.from('jpeg-largest-bytes'),
      },
      {
        kind: 'document',
        msg: {
          message_id: 102,
          date: 1700000102,
          caption: 'doc caption',
          document: {
            file_id: 'doc-1',
            file_unique_id: 'u-doc-1',
            file_name: 'report.pdf',
            mime_type: 'application/pdf',
            file_size: 1024,
          },
        },
        expectedFileId: 'doc-1',
        expectedFilename: 'report.pdf',
        expectedBytes: Buffer.from('%PDF-1.7 report'),
      },
      {
        kind: 'audio',
        msg: {
          message_id: 103,
          date: 1700000103,
          caption: 'audio caption',
          audio: {
            file_id: 'audio-1',
            file_unique_id: 'u-audio-1',
            file_name: 'clip.mp3',
            mime_type: 'audio/mpeg',
            file_size: 512,
          },
        },
        expectedFileId: 'audio-1',
        expectedFilename: 'clip.mp3',
        expectedBytes: Buffer.from('ID3-audio'),
      },
      {
        kind: 'video',
        msg: {
          message_id: 104,
          date: 1700000104,
          caption: 'video caption',
          video: {
            file_id: 'video-1',
            file_unique_id: 'u-video-1',
            file_name: 'demo.mp4',
            mime_type: 'video/mp4',
            file_size: 2048,
          },
        },
        expectedFileId: 'video-1',
        expectedFilename: 'demo.mp4',
        expectedBytes: Buffer.from('mp4-video-bytes'),
      },
      {
        kind: 'voice',
        msg: {
          message_id: 105,
          date: 1700000105,
          caption: 'voice caption',
          voice: {
            file_id: 'voice-1',
            file_unique_id: 'u-voice-1',
            mime_type: 'audio/ogg',
            file_size: 300,
          },
        },
        expectedFileId: 'voice-1',
        expectedFilename: null,
        expectedBytes: Buffer.from('OggS-voice'),
      },
      {
        kind: 'animation',
        msg: {
          message_id: 106,
          date: 1700000106,
          caption: 'anim caption',
          animation: {
            file_id: 'anim-1',
            file_unique_id: 'u-anim-1',
            file_name: 'spin.mp4',
            mime_type: 'video/mp4',
            file_size: 600,
          },
          // Telegram often echoes animation in document with the same file_id; must dedupe
          document: {
            file_id: 'anim-1',
            file_unique_id: 'u-anim-1',
            file_name: 'spin.mp4',
            mime_type: 'video/mp4',
            file_size: 600,
          },
        },
        expectedFileId: 'anim-1',
        expectedFilename: 'spin.mp4',
        expectedBytes: Buffer.from('anim-bytes'),
      },
      {
        kind: 'video_note',
        msg: {
          message_id: 107,
          date: 1700000107,
          video_note: {
            file_id: 'vnote-1',
            file_unique_id: 'u-vnote-1',
            file_size: 400,
          },
        },
        expectedFileId: 'vnote-1',
        expectedFilename: null,
        expectedBytes: Buffer.from('vnote-bytes'),
      },
      {
        kind: 'sticker',
        msg: {
          message_id: 108,
          date: 1700000108,
          sticker: {
            file_id: 'sticker-1',
            file_unique_id: 'u-sticker-1',
            file_size: 250,
          },
        },
        expectedFileId: 'sticker-1',
        expectedFilename: null,
        expectedBytes: Buffer.from('RIFF-webp'),
      },
    ]

    for (const item of payloads) {
      handler({
        from: { id: 123456, username: 'alice' },
        chat: { id: 111222, type: 'private' },
        message: item.msg,
      })
    }

    const fetched = await adapter.fetchMessages('111222', new Set(['123456']), {
      telegramChatType: 'private',
      providerTarget: PROVIDER_TARGET,
    })
    expect(fetched).toHaveLength(payloads.length)

    const bytesByFileId = new Map(payloads.map(p => [p.expectedFileId, p.expectedBytes]))
    bot.api.getFile.mockImplementation(async (fileId: string) => ({
      file_id: fileId,
      file_path: `files/${fileId}.bin`,
      file_size: bytesByFileId.get(fileId)!.byteLength,
    }))

    const ingested: Array<{ meta: ChannelAttachmentIngestMetadataV1; sha256: string }> = []
    const dispatchedMessages: Array<{ content: string; channelAttachmentIds?: string[] }> = []

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(`https://api.telegram.org/file/bot${TEST_TOKEN}/files/`)) {
        const fileId = url
          .split('/')
          .pop()!
          .replace(/\.bin$/, '')
        return new Response(new Uint8Array(bytesByFileId.get(fileId)!), { status: 200 })
      }
      if (url === 'http://mcp-host.test/v1/runtime/provider-messages/authorize') {
        return new Response(JSON.stringify({ authorized: true }), { status: 200 })
      }
      if (url === 'http://mcp-host.test/v1/runtime/channel-attachments/ingest') {
        const headers = init?.headers as Record<string, string>
        const meta = JSON.parse(
          Buffer.from(headers['x-clerum-attachment-meta']!, 'base64url').toString('utf8')
        ) as ChannelAttachmentIngestMetadataV1
        const bodyBuf = Buffer.from(init?.body as Uint8Array)
        const id = `att-${ingested.length + 1}`
        ingested.push({ meta, sha256: sha256Hex(bodyBuf) })
        return new Response(
          JSON.stringify({
            ok: true,
            attachmentId: id,
            fileReference: { name: meta.filename ?? `${id}.bin` },
            expiresAt: '2026-12-01T00:00:00.000Z',
          }),
          { status: 200 }
        )
      }
      if (url.startsWith('http://mcp-host.test/v1/runtime/messages')) {
        const body = JSON.parse(String(init?.body)) as {
          content: string
          channelAttachmentIds?: string[]
        }
        dispatchedMessages.push(body)
        return new Response(
          JSON.stringify({ success: true, status: 'completed', response: 'Confirmed.' }),
          { status: 200 }
        )
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const rpc = new RPCClient('http://mcp-host.test', { sleep: async () => undefined })
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['telegram', adapter]]),
    })

    await reader.handleMessages(fetched)

    expect(ingested).toHaveLength(payloads.length)
    expect(dispatchedMessages).toHaveLength(payloads.length)

    for (let i = 0; i < payloads.length; i += 1) {
      const p = payloads[i]!
      const msg = fetched[i]!
      expect(msg.attachments).toHaveLength(1)
      expect(msg.attachments![0]!.filename).toBe(p.expectedFilename)
      expect(msg.attachments![0]!.downloadRef).toEqual({
        provider: 'telegram',
        fileId: p.expectedFileId,
        kindHint: p.kind,
      })
      expect(ingested[i]!.sha256).toBe(sha256Hex(p.expectedBytes))
      expect(dispatchedMessages[i]!.channelAttachmentIds).toEqual([`att-${i + 1}`])
      expect(dispatchedMessages[i]!.content).toBe((p.msg.caption as string | undefined) ?? '')
    }
  })

  it('S3 · accepts_group_media_with_caption_entity_mention', async () => {
    const adapter = new TelegramAdapter(null)
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)
    const logSpy = vi.spyOn(console, 'log')

    await adapter.fetchMessages('-100999', new Set(['123456']), {
      telegramChatType: 'group',
      replyOnlyWhenMentioned: true,
      providerTarget: PROVIDER_TARGET,
    })

    // Message WITH @test_bot in caption_entities -> accepted
    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: -100999, type: 'group' },
      message: {
        message_id: 201,
        date: 1700000201,
        caption: '@test_bot summarize this',
        caption_entities: [{ type: 'mention', offset: 0, length: 9 }],
        document: {
          file_id: 'doc-mentioned',
          file_unique_id: 'u-doc-mentioned',
          file_name: 'notes.pdf',
          mime_type: 'application/pdf',
        },
      },
    })

    // Message WITHOUT mention -> ignored (liveness witness: drop reason logged)
    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: -100999, type: 'group' },
      message: {
        message_id: 202,
        date: 1700000202,
        caption: 'unmentioned photo',
        photo: [{ file_id: 'photo-ignored', file_unique_id: 'u-ignored', width: 200, height: 200 }],
      },
    })

    const fetched = await adapter.fetchMessages('-100999', new Set(['123456']), {
      telegramChatType: 'group',
      replyOnlyWhenMentioned: true,
      providerTarget: PROVIDER_TARGET,
    })

    expect(fetched).toHaveLength(1)
    expect(fetched[0]!.messageId).toBe('201')
    expect(fetched[0]!.attachments).toHaveLength(1)
    expect(fetched[0]!.providerIdentity?.providerTarget?.providerBotUsername).toBe('test_bot')
    expect(logSpy.mock.calls.some(args => String(args[0]).includes('replyOnlyWhenMentioned'))).toBe(
      true
    )

    // Verify ChannelReader strips leading @test_bot mention cleanly when forwarding
    const sentMessages: Array<{ content: string; channelAttachmentIds?: string[] }> = []
    const reader = new ChannelReader({
      rpcClient: {
        healthCheck: vi.fn(async () => true),
        getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
        authorizeProviderMessage: vi.fn(async () => ({ authorized: true })),
        ingestChannelAttachment: vi.fn(async () => ({
          ok: true as const,
          attachmentId: 'att-mentioned',
          fileReference: { name: 'notes.pdf' },
          expiresAt: '2026-12-01T00:00:00.000Z',
        })),
        sendMessage: vi.fn(async m => {
          sentMessages.push({ content: m.content, channelAttachmentIds: m.channelAttachmentIds })
          return { success: true, status: 'completed' as const, response: 'ok' }
        }),
        getTaskResult: vi.fn(async () => ({ success: true, status: 'completed' as const })),
        sendApproval: vi.fn(async () => ({ success: true })),
        sendDenial: vi.fn(async () => ({ success: true })),
        sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
        resolveWorkflowApproval: vi.fn(async () => null),
        fetchDeliveries: vi.fn(async () => []),
        acknowledge: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
        confirmTelegramChallenge: vi.fn(async () => ({ ok: true as const, accountId: 'a1' })),
        getCronResults: vi.fn(async () => []),
        acknowledgeCronResult: vi.fn(async () => undefined),
      },
      notificationDeliveryClient: null,
      adapters: new Map([['telegram', adapter]]),
    })
    vi.spyOn(adapter, 'downloadAttachment').mockResolvedValue({
      ok: true,
      bytes: Buffer.from('%PDF-1.4'),
      filename: 'notes.pdf',
      declaredMediaType: 'application/pdf',
    })

    await reader.handleMessages(fetched)
    expect(sentMessages).toEqual([
      { content: 'summarize this', channelAttachmentIds: ['att-mentioned'] },
    ])
  })

  it('S4 · coalesces_media_group_album_across_poll_ticks', async () => {
    vi.useFakeTimers()
    const adapter = new TelegramAdapter(null)
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)

    await adapter.fetchMessages('-100888', new Set(['123456']), {
      telegramChatType: 'group',
      replyOnlyWhenMentioned: true,
      providerTarget: PROVIDER_TARGET,
    })

    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: -100888, type: 'group' },
      message: {
        message_id: 301,
        date: 1700000301,
        media_group_id: 'mg-42',
        caption: '@test_bot analyze',
        caption_entities: [{ type: 'mention', offset: 0, length: 9 }],
        photo: [{ file_id: 'p1', file_unique_id: 'up1', width: 800, height: 600 }],
      },
    })
    vi.advanceTimersByTime(200)
    // Poll tick mid-album must NOT slice the album prematurely
    expect(
      await adapter.fetchMessages('-100888', new Set(['123456']), {
        telegramChatType: 'group',
        replyOnlyWhenMentioned: true,
        providerTarget: PROVIDER_TARGET,
      })
    ).toHaveLength(0)

    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: -100888, type: 'group' },
      message: {
        message_id: 302,
        date: 1700000301,
        media_group_id: 'mg-42',
        photo: [{ file_id: 'p2', file_unique_id: 'up2', width: 800, height: 600 }],
      },
    })
    vi.advanceTimersByTime(200)
    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: -100888, type: 'group' },
      message: {
        message_id: 303,
        date: 1700000301,
        media_group_id: 'mg-42',
        photo: [{ file_id: 'p3', file_unique_id: 'up3', width: 800, height: 600 }],
      },
    })

    vi.advanceTimersByTime(TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS)

    const fetched = await adapter.fetchMessages('-100888', new Set(['123456']), {
      telegramChatType: 'group',
      replyOnlyWhenMentioned: true,
      providerTarget: PROVIDER_TARGET,
    })

    expect(fetched).toHaveLength(1)
    expect(fetched[0]!.attachments?.map(a => a.providerAttachmentId)).toEqual(['up1', 'up2', 'up3'])

    const dispatched: Array<{ content: string; ids?: string[] }> = []
    let counter = 0
    vi.spyOn(adapter, 'downloadAttachment').mockImplementation(async d => ({
      ok: true,
      bytes: Buffer.from(`bytes-${d.providerAttachmentId}`),
      filename: d.filename,
      declaredMediaType: d.declaredMediaType,
    }))
    const reader = new ChannelReader({
      rpcClient: {
        healthCheck: vi.fn(async () => true),
        getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
        authorizeProviderMessage: vi.fn(async () => ({ authorized: true })),
        ingestChannelAttachment: vi.fn(async () => ({
          ok: true as const,
          attachmentId: `att-mg-${++counter}`,
          fileReference: { name: `photo-${counter}.jpg` },
          expiresAt: '2026-12-01T00:00:00.000Z',
        })),
        sendMessage: vi.fn(async m => {
          dispatched.push({ content: m.content, ids: m.channelAttachmentIds })
          return { success: true, status: 'completed' as const, response: 'analyzed' }
        }),
        getTaskResult: vi.fn(async () => ({ success: true, status: 'completed' as const })),
        sendApproval: vi.fn(async () => ({ success: true })),
        sendDenial: vi.fn(async () => ({ success: true })),
        sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
        resolveWorkflowApproval: vi.fn(async () => null),
        fetchDeliveries: vi.fn(async () => []),
        acknowledge: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
        confirmTelegramChallenge: vi.fn(async () => ({ ok: true as const, accountId: 'a1' })),
        getCronResults: vi.fn(async () => []),
        acknowledgeCronResult: vi.fn(async () => undefined),
      },
      notificationDeliveryClient: null,
      adapters: new Map([['telegram', adapter]]),
    })

    await reader.handleMessages(fetched)
    expect(dispatched).toEqual([{ content: 'analyze', ids: ['att-mg-1', 'att-mg-2', 'att-mg-3'] }])
  })

  it('S5 · handles_late_media_group_member_independently', async () => {
    vi.useFakeTimers()
    const adapter = new TelegramAdapter(null)
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)

    await adapter.fetchMessages('111222', new Set(['123456']), {
      telegramChatType: 'private',
      providerTarget: PROVIDER_TARGET,
    })

    for (const [idx, msgId] of [401, 402, 403].entries()) {
      handler({
        from: { id: 123456, username: 'alice' },
        chat: { id: 111222, type: 'private' },
        message: {
          message_id: msgId,
          date: 1700000400 + idx,
          media_group_id: 'mg-late',
          photo: [
            { file_id: `p${idx + 1}`, file_unique_id: `u${idx + 1}`, width: 640, height: 480 },
          ],
        },
      })
    }
    vi.advanceTimersByTime(TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS)

    const turn1 = await adapter.fetchMessages('111222', new Set(['123456']), {
      telegramChatType: 'private',
      providerTarget: PROVIDER_TARGET,
    })
    expect(turn1).toHaveLength(1)
    expect(turn1[0]!.attachments).toHaveLength(3)
    expect(turn1[0]!.providerIdentity?.providerEventId).toBe('telegram:111222:401')

    // 4th member arrives after 800 ms flush -> forms its own independent delivery
    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: 111222, type: 'private' },
      message: {
        message_id: 404,
        date: 1700000410,
        media_group_id: 'mg-late',
        photo: [{ file_id: 'p4', file_unique_id: 'u4', width: 640, height: 480 }],
      },
    })
    vi.advanceTimersByTime(TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS)

    const turn2 = await adapter.fetchMessages('111222', new Set(['123456']), {
      telegramChatType: 'private',
      providerTarget: PROVIDER_TARGET,
    })
    expect(turn2).toHaveLength(1)
    expect(turn2[0]!.attachments).toHaveLength(1)
    expect(turn2[0]!.providerIdentity?.providerEventId).toBe('telegram:111222:404')
    // Turn 1 retained its original 3 descriptors unmodified
    expect(turn1[0]!.attachments).toHaveLength(3)
  })

  it('S6 · rejects_oversized_traversal_and_off_origin_getFile', async () => {
    mockCfg.channelAttachmentMaxBytes = 1024
    const adapter = new TelegramAdapter(null)
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[0]!

    const descriptors: ProviderAttachmentDescriptorV1[] = [
      {
        providerAttachmentId: 'u-big',
        filename: 'huge.bin',
        declaredMediaType: 'application/octet-stream',
        reportedSizeBytes: 5000,
        downloadRef: { provider: 'telegram', fileId: 'f-big', kindHint: 'document' },
      },
      {
        providerAttachmentId: 'u-trav',
        filename: 'evil.txt',
        declaredMediaType: 'text/plain',
        reportedSizeBytes: 100,
        downloadRef: { provider: 'telegram', fileId: 'f-trav', kindHint: 'document' },
      },
      {
        providerAttachmentId: 'u-redir',
        filename: 'redir.txt',
        declaredMediaType: 'text/plain',
        reportedSizeBytes: 100,
        downloadRef: { provider: 'telegram', fileId: 'f-redir', kindHint: 'document' },
      },
      {
        providerAttachmentId: 'u-valid',
        filename: 'good.txt',
        declaredMediaType: 'text/plain',
        reportedSizeBytes: 12,
        downloadRef: { provider: 'telegram', fileId: 'f-valid', kindHint: 'document' },
      },
    ]

    bot.api.getFile.mockImplementation(async (fileId: string) => {
      if (fileId === 'f-trav')
        return { file_id: fileId, file_path: '../../etc/passwd', file_size: 100 }
      if (fileId === 'f-redir')
        return { file_id: fileId, file_path: 'docs/redir.txt', file_size: 100 }
      if (fileId === 'f-valid')
        return { file_id: fileId, file_path: 'docs/good.txt', file_size: 12 }
      throw new Error(`Unexpected getFile for ${fileId}`)
    })

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/docs/redir.txt')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/steal-token' },
        })
      }
      if (url.endsWith('/docs/good.txt')) {
        return new Response('hello valid!', { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const ingestMock = vi.fn(async () => ({
      ok: true as const,
      attachmentId: 'att-good',
      fileReference: { name: 'good.txt' },
      expiresAt: '2026-12-01T00:00:00.000Z',
    }))
    const sentMessages: Array<{
      channelAttachmentIds?: string[]
      attachmentIngestErrors?: Array<{ filename: string | null; code: string; message: string }>
    }> = []

    const reader = new ChannelReader({
      rpcClient: {
        healthCheck: vi.fn(async () => true),
        getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
        authorizeProviderMessage: vi.fn(async () => ({ authorized: true })),
        ingestChannelAttachment: ingestMock,
        sendMessage: vi.fn(async m => {
          sentMessages.push({
            channelAttachmentIds: m.channelAttachmentIds,
            attachmentIngestErrors: m.attachmentIngestErrors,
          })
          return { success: true, status: 'completed' as const, response: 'ok' }
        }),
        getTaskResult: vi.fn(async () => ({ success: true, status: 'completed' as const })),
        sendApproval: vi.fn(async () => ({ success: true })),
        sendDenial: vi.fn(async () => ({ success: true })),
        sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
        resolveWorkflowApproval: vi.fn(async () => null),
        fetchDeliveries: vi.fn(async () => []),
        acknowledge: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
        confirmTelegramChallenge: vi.fn(async () => ({ ok: true as const, accountId: 'a1' })),
        getCronResults: vi.fn(async () => []),
        acknowledgeCronResult: vi.fn(async () => undefined),
      },
      notificationDeliveryClient: null,
      adapters: new Map([['telegram', adapter]]),
    })

    await reader.handleMessages([
      {
        channelType: 'telegram',
        channelId: '111222',
        sender: '123456',
        content: 'check these',
        timestamp: new Date('2026-11-26T00:00:00.000Z'),
        messageId: '601',
        attachments: descriptors,
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: '111222',
          providerChannelType: 'private',
          providerEventId: 'telegram:111222:601',
        },
      },
    ])

    // Only the 1 valid sibling descriptor reached /ingest (3 rejected -> 0 ingest calls for them)
    expect(ingestMock).toHaveBeenCalledTimes(1)
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]!.channelAttachmentIds).toEqual(['att-good'])
    expect(sentMessages[0]!.attachmentIngestErrors?.map(e => e.code)).toEqual([
      'file_too_large',
      'provider_download_rejected',
      'provider_download_rejected',
    ])
  })

  it('S66 · flushes_open_media_group_before_rapid_followup_text', async () => {
    vi.useFakeTimers()
    const adapter = new TelegramAdapter(null)
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)

    await adapter.fetchMessages('111222', new Set(['123456']), {
      telegramChatType: 'private',
      providerTarget: PROVIDER_TARGET,
    })

    // 3 photos arrive at t = 0..100ms
    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: 111222, type: 'private' },
      message: {
        message_id: 701,
        date: 1700000701,
        media_group_id: 'mg1',
        photo: [{ file_id: 'photo1', file_unique_id: 'up1', width: 800, height: 600 }],
      },
    })
    vi.advanceTimersByTime(50)
    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: 111222, type: 'private' },
      message: {
        message_id: 702,
        date: 1700000701,
        media_group_id: 'mg1',
        photo: [{ file_id: 'photo2', file_unique_id: 'up2', width: 800, height: 600 }],
      },
    })
    vi.advanceTimersByTime(50)
    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: 111222, type: 'private' },
      message: {
        message_id: 703,
        date: 1700000701,
        media_group_id: 'mg1',
        photo: [{ file_id: 'photo3', file_unique_id: 'up3', width: 800, height: 600 }],
      },
    })

    // Non-album text arrives at t = 300ms (BEFORE 800ms debounce timer!)
    vi.advanceTimersByTime(200)
    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: 111222, type: 'private' },
      message: {
        message_id: 704,
        date: 1700000702,
        text: 'Compare those 3 charts',
      },
    })

    const fetched = await adapter.fetchMessages('111222', new Set(['123456']), {
      telegramChatType: 'private',
      providerTarget: PROVIDER_TARGET,
    })

    expect(fetched).toHaveLength(2)
    expect(fetched[0]!.attachments).toHaveLength(3)
    expect(fetched[1]!.content).toBe('Compare those 3 charts')

    const callOrder: string[] = []
    vi.spyOn(adapter, 'downloadAttachment').mockImplementation(async d => ({
      ok: true,
      bytes: Buffer.from(
        `bytes-${d.downloadRef.provider === 'telegram' ? d.downloadRef.fileId : ''}`
      ),
      filename: d.filename,
      declaredMediaType: d.declaredMediaType,
    }))
    const reader = new ChannelReader({
      rpcClient: {
        healthCheck: vi.fn(async () => true),
        getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
        authorizeProviderMessage: vi.fn(async () => ({ authorized: true })),
        ingestChannelAttachment: vi.fn(async meta => {
          const idx = meta.providerAttachmentId.replace(/^up/, '')
          callOrder.push(`ingest:photo${idx}`)
          return {
            ok: true as const,
            attachmentId: `att-${idx}`,
            fileReference: { name: `photo${idx}.jpg` },
            expiresAt: '2026-12-01T00:00:00.000Z',
          }
        }),
        sendMessage: vi.fn(async m => {
          callOrder.push(m.attachments?.length ? 'message:album' : 'message:text')
          return { success: true, status: 'completed' as const, response: 'ok' }
        }),
        getTaskResult: vi.fn(async () => ({ success: true, status: 'completed' as const })),
        sendApproval: vi.fn(async () => ({ success: true })),
        sendDenial: vi.fn(async () => ({ success: true })),
        sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
        resolveWorkflowApproval: vi.fn(async () => null),
        fetchDeliveries: vi.fn(async () => []),
        acknowledge: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
        confirmTelegramChallenge: vi.fn(async () => ({ ok: true as const, accountId: 'a1' })),
        getCronResults: vi.fn(async () => []),
        acknowledgeCronResult: vi.fn(async () => undefined),
      },
      notificationDeliveryClient: null,
      adapters: new Map([['telegram', adapter]]),
    })

    await reader.handleMessages(fetched)

    expect(callOrder).toEqual([
      'ingest:photo1',
      'ingest:photo2',
      'ingest:photo3',
      'message:album',
      'message:text',
    ])
  })

  it('T-BR15 · passes AbortSignal.timeout to bot.api.getFile and aborts hung calls cleanly', async () => {
    vi.useFakeTimers()
    const adapter = new TelegramAdapter(null)
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[0]!

    const capturedSignals: Array<unknown> = []
    bot.api.getFile.mockImplementationOnce(
      (_fileId: string, signal?: AbortSignal) =>
        new Promise(() => {
          capturedSignals.push(signal)
        })
    )

    const descriptor: ProviderAttachmentDescriptorV1 = {
      providerAttachmentId: 'u-hang',
      filename: 'hang.pdf',
      declaredMediaType: 'application/pdf',
      reportedSizeBytes: 128,
      downloadRef: { provider: 'telegram', fileId: 'f-hang', kindHint: 'document' },
    }

    const downloadPromise = adapter.downloadAttachment(descriptor)
    expect(capturedSignals).toHaveLength(1)
    expect(capturedSignals[0]).toBeInstanceOf(AbortSignal)

    await vi.advanceTimersByTimeAsync(TELEGRAM_DOWNLOAD_TIMEOUT_MS)
    const timedOut = await downloadPromise
    expect(timedOut).toMatchObject({
      ok: false,
      code: 'provider_download_failed',
      retryable: true,
    })

    // Liveness witness: resolving getFile receives AbortSignal and succeeds with bytes
    bot.api.getFile.mockImplementationOnce(async (_fileId: string, signal?: AbortSignal) => {
      capturedSignals.push(signal)
      return { file_id: 'f-ok', file_path: 'docs/ok.pdf', file_size: 8 }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('%PDF-1.7', { status: 200 }))
    )

    const okResult = await adapter.downloadAttachment({
      ...descriptor,
      providerAttachmentId: 'u-ok',
      downloadRef: { provider: 'telegram', fileId: 'f-ok', kindHint: 'document' },
    })
    expect(capturedSignals[1]).toBeInstanceOf(AbortSignal)
    expect(okResult).toEqual({
      ok: true,
      bytes: Buffer.from('%PDF-1.7'),
      filename: 'hang.pdf',
      declaredMediaType: 'application/pdf',
    })
  })

  it('T-BR23 · concatenates multi-caption media groups and shifts caption_entities offsets', async () => {
    vi.useFakeTimers()
    const adapter = new TelegramAdapter(null)
    await adapter.connect({ telegramBotToken: TEST_TOKEN })
    const bot = grammy.instances[0]!
    const handler = getMessageHandler(bot)

    await adapter.fetchMessages('-100777', new Set(['123456']), {
      telegramChatType: 'group',
      replyOnlyWhenMentioned: true,
      providerTarget: PROVIDER_TARGET,
    })

    // Album item 1: "First" (bold 0..5), NO @mention
    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: -100777, type: 'group' },
      message: {
        message_id: 801,
        date: 1700000801,
        media_group_id: 'mg-multi-cap',
        caption: 'First',
        caption_entities: [{ type: 'bold', offset: 0, length: 5 }],
        photo: [{ file_id: 'p1', file_unique_id: 'u-mc-1', width: 640, height: 480 }],
      },
    })
    // Album item 2: "@test_bot Second" (mention 0..9) -> shifted to offset 6
    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: -100777, type: 'group' },
      message: {
        message_id: 802,
        date: 1700000801,
        media_group_id: 'mg-multi-cap',
        caption: '@test_bot Second',
        caption_entities: [{ type: 'mention', offset: 0, length: 9 }],
        photo: [{ file_id: 'p2', file_unique_id: 'u-mc-2', width: 640, height: 480 }],
      },
    })
    vi.advanceTimersByTime(TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS)

    const fetched = await adapter.fetchMessages('-100777', new Set(['123456']), {
      telegramChatType: 'group',
      replyOnlyWhenMentioned: true,
      providerTarget: PROVIDER_TARGET,
    })
    expect(fetched).toHaveLength(1)
    expect(fetched[0]!.content).toBe('First\n@test_bot Second')
    expect(fetched[0]!.rawData?.caption_entities).toEqual([
      { type: 'bold', offset: 0, length: 5 },
      { type: 'mention', offset: 6, length: 9 },
    ])

    // Liveness witnesses: 0-caption and 1-caption albums preserved in private chat
    await adapter.fetchMessages('111222', new Set(['123456']), {
      telegramChatType: 'private',
      providerTarget: PROVIDER_TARGET,
    })
    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: 111222, type: 'private' },
      message: {
        message_id: 810,
        date: 1700000810,
        media_group_id: 'mg-zero',
        photo: [{ file_id: 'pz1', file_unique_id: 'uz1', width: 640, height: 480 }],
      },
    })
    vi.advanceTimersByTime(TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS)
    handler({
      from: { id: 123456, username: 'alice' },
      chat: { id: 111222, type: 'private' },
      message: {
        message_id: 811,
        date: 1700000811,
        media_group_id: 'mg-one',
        caption: 'Only one',
        caption_entities: [{ type: 'italic', offset: 0, length: 4 }],
        photo: [{ file_id: 'po1', file_unique_id: 'uo1', width: 640, height: 480 }],
      },
    })
    vi.advanceTimersByTime(TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS)

    const privateFetched = await adapter.fetchMessages('111222', new Set(['123456']), {
      telegramChatType: 'private',
      providerTarget: PROVIDER_TARGET,
    })
    expect(privateFetched).toHaveLength(2)
    expect(privateFetched[0]!.content).toBe('')
    expect(privateFetched[1]!.content).toBe('Only one')
    expect(privateFetched[1]!.rawData?.caption_entities).toEqual([
      { type: 'italic', offset: 0, length: 4 },
    ])
  })
})
