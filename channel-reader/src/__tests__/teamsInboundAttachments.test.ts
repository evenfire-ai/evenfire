import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TeamsAdapter,
  type TeamsFileDownloadAuthStrategy,
  isAllowedTeamsInlineContentUrl,
} from '../channels/teams'
import type { TeamsMessageHandoff } from '../handoffServer'
import { ChannelReader, type ChannelReaderOptions } from '../main'
import type { Message, ProviderAttachmentDescriptorV1 } from '../types'

vi.mock('../progressClient', () => ({
  createProgressStream: vi.fn(() => ({
    close: vi.fn(),
    get steps() {
      return []
    },
  })),
}))

vi.hoisted(() => {
  process.env.CLERUM_HOST_REF = process.env.CLERUM_HOST_REF ?? 'test-host'
})

const PROVIDER_TARGET = {
  hostRef: 'test-host',
  communicationChannelNamespace: 'channels',
  communicationChannelName: 'teams-cc',
}

function makeRpc(overrides: Partial<NonNullable<ChannelReaderOptions['rpcClient']>> = {}) {
  return {
    healthCheck: vi.fn(async () => true),
    sendMessage: vi.fn(async () => ({
      success: true,
      status: 'completed' as const,
      response: 'ok',
    })),
    getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
    getTaskResult: vi.fn(async () => ({
      success: true,
      status: 'completed' as const,
      response: 'ok',
    })),
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
    authorizeProviderMessage: vi.fn(async () => ({ authorized: true })),
    ingestChannelAttachment: vi.fn(async meta => ({
      ok: true as const,
      attachmentId: `att-${meta.providerAttachmentId}`,
      fileReference: { name: meta.filename ?? 'file.bin' },
      expiresAt: '2026-12-01T00:00:00.000Z',
    })),
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Teams inbound attachments (X8)', () => {
  it('S13 · downloads_sharepoint_file_without_bot_token', async () => {
    const pdfBytes = Buffer.from('%PDF-1.7 teams personal file')
    const seenAuthHeaders: Array<string | undefined> = []
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      seenAuthHeaders.push(headers.authorization ?? headers.Authorization)
      if (url === 'https://contoso.sharepoint.com/sites/docs/report.pdf') {
        return new Response(new Uint8Array(pdfBytes), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new TeamsAdapter()
    await adapter.connect({
      teamsAppId: 'app-1',
      teamsTenantId: 'tenant-1',
      teamsAppPassword: 'secret',
    })
    const sendReplySpy = vi.spyOn(adapter, 'sendMessage').mockResolvedValue('teams-reply-1')

    const ingestedMetas: Array<{ sessionThreadId?: string; filename: string | null }> = []
    const rpc = makeRpc({
      ingestChannelAttachment: vi.fn(async meta => {
        ingestedMetas.push({ sessionThreadId: meta.sessionThreadId, filename: meta.filename })
        return {
          ok: true as const,
          attachmentId: 'att-teams-sp-1',
          fileReference: { name: 'report.pdf' },
          expiresAt: '2026-12-01T00:00:00.000Z',
        }
      }),
    })
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['teams', adapter]]),
    })

    const handoff: TeamsMessageHandoff = {
      kind: 'teams.attachment-message.v1',
      content: '',
      providerUserId: 'teams-user-1',
      providerWorkspaceId: 'tenant-1',
      providerChannelId: 'personal-conv-1',
      providerConversationId: 'personal-conv-1',
      providerReplyToMessageId: 'act-1',
      providerChannelType: 'personal',
      providerEventId: 'teams:tenant-1:personal-conv-1:act-1',
      providerMessageId: 'act-1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      attachments: [
        {
          providerAttachmentId: 'sp-uniq-1',
          filename: 'report.pdf',
          declaredMediaType: 'application/pdf',
          reportedSizeBytes: pdfBytes.byteLength,
          downloadRef: {
            provider: 'teams',
            mode: 'file_download_info',
            downloadUrl: 'https://contoso.sharepoint.com/sites/docs/report.pdf',
            uniqueId: 'sp-uniq-1',
          },
        },
      ],
      providerTarget: PROVIDER_TARGET,
    }

    expect(await reader.handleTeamsHandoff(handoff)).toEqual({ ok: true })
    await reader.flushConversationQueues()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(seenAuthHeaders).toEqual([undefined])
    expect(sendReplySpy).toHaveBeenCalledTimes(1)
    expect(ingestedMetas).toEqual([{ sessionThreadId: undefined, filename: 'report.pdf' }])
    const sentMsg = (vi.mocked(rpc.sendMessage).mock.calls[0] as unknown as [Message])[0]
    expect(sentMsg.content).toBe('')
    expect(sentMsg.threadId).toBeUndefined()
    expect(sentMsg.channelAttachmentIds).toEqual(['att-teams-sp-1'])
  })

  it('S14 · downloads_inline_image_on_verified_service_url_and_ignores_text_html', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'bot-jwt-token', expires_in: 3600 }), {
          status: 200,
        })
      }
      if (url === 'https://smba.trafficmanager.net/amer/v3/attachments/img-1/views/original') {
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers.authorization).toBe('Bearer bot-jwt-token')
        return new Response(new Uint8Array(pngBytes), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new TeamsAdapter()
    await adapter.connect({
      teamsAppId: 'app-1',
      teamsTenantId: 'tenant-1',
      teamsAppPassword: 'secret',
    })

    const result = await adapter.downloadAttachment({
      providerAttachmentId: 'inline-img-1',
      filename: null,
      declaredMediaType: 'image/png',
      reportedSizeBytes: null,
      downloadRef: {
        provider: 'teams',
        mode: 'inline_content',
        contentUrl: 'https://smba.trafficmanager.net/amer/v3/attachments/img-1/views/original',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
      },
    })

    expect(result).toEqual({
      ok: true,
      bytes: pngBytes,
      filename: null,
      declaredMediaType: 'image/png',
    })
  })

  it('S15 · rejects_wildcard_trafficmanager_and_disallowed_hosts', async () => {
    let outboundRequests = 0
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'bot-jwt', expires_in: 3600 }), {
          status: 200,
        })
      }
      if (url.startsWith('https://smba.trafficmanager.net/amer/v3/attachments/good')) {
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers.authorization).toBe('Bearer bot-jwt')
        return new Response('png-ok', { status: 200 })
      }
      outboundRequests += 1
      return new Response('should not reach', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    // Verify wildcard *.trafficmanager.net is strictly rejected
    expect(
      isAllowedTeamsInlineContentUrl(
        'https://attacker.trafficmanager.net/img.png',
        'https://smba.trafficmanager.net/amer/'
      )
    ).toBe(false)
    expect(
      isAllowedTeamsInlineContentUrl(
        'https://us-api.asm.skype.com/v1/objects/123/views/imgo',
        'https://smba.trafficmanager.net/amer/'
      )
    ).toBe(true)

    const adapter = new TeamsAdapter()
    await adapter.connect({
      teamsAppId: 'app-1',
      teamsTenantId: 'tenant-1',
      teamsAppPassword: 'secret',
    })

    const badInline = await adapter.downloadAttachment({
      providerAttachmentId: 'bad-inline',
      filename: 'img.png',
      declaredMediaType: 'image/png',
      reportedSizeBytes: 100,
      downloadRef: {
        provider: 'teams',
        mode: 'inline_content',
        contentUrl: 'https://attacker.trafficmanager.net/img.png',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
      },
    })
    const badFileInfo = await adapter.downloadAttachment({
      providerAttachmentId: 'bad-sp',
      filename: 'a.pdf',
      declaredMediaType: 'application/pdf',
      reportedSizeBytes: 100,
      downloadRef: {
        provider: 'teams',
        mode: 'file_download_info',
        downloadUrl: 'https://evil.example/a.pdf',
      },
    })

    expect(badInline).toMatchObject({ ok: false, code: 'provider_download_host_rejected' })
    expect(badFileInfo).toMatchObject({ ok: false, code: 'provider_download_host_rejected' })
    expect(outboundRequests).toBe(0)

    // Liveness witness: verified serviceUrl origin succeeds in the same test
    const goodInline = await adapter.downloadAttachment({
      providerAttachmentId: 'good-inline',
      filename: 'ok.png',
      declaredMediaType: 'image/png',
      reportedSizeBytes: 6,
      downloadRef: {
        provider: 'teams',
        mode: 'inline_content',
        contentUrl: 'https://smba.trafficmanager.net/amer/v3/attachments/good',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
      },
    })
    expect(goodInline).toMatchObject({ ok: true, bytes: Buffer.from('png-ok') })
  })

  it('S16 · surfaces_provider_scope_unsupported_for_missing_download_url', async () => {
    const adapter = new TeamsAdapter()
    await adapter.connect({
      teamsAppId: 'app-1',
      teamsTenantId: 'tenant-1',
      teamsAppPassword: 'secret',
    })

    const result = await adapter.downloadAttachment({
      providerAttachmentId: 'chan-att-1',
      filename: 'channel-file.pdf',
      declaredMediaType: 'application/pdf',
      reportedSizeBytes: null,
      downloadRef: {
        provider: 'teams',
        mode: 'file_download_info',
        downloadUrl: '',
      },
    })
    expect(result).toMatchObject({ ok: false, code: 'provider_scope_unsupported' })
  })

  it('S45 · keeps_teams_1to1_turns_in_single_fifo_and_session_key', async () => {
    const adapter = new TeamsAdapter()
    await adapter.connect({
      teamsAppId: 'app-1',
      teamsTenantId: 'tenant-1',
      teamsAppPassword: 'secret',
    })

    const callOrder: string[] = []
    let releaseSlow!: () => void
    const slowGate = new Promise<void>(resolve => {
      releaseSlow = resolve
    })

    vi.spyOn(adapter, 'downloadAttachment').mockImplementation(async d => {
      await slowGate
      return {
        ok: true,
        bytes: Buffer.from('%PDF-1.7'),
        filename: d.filename,
        declaredMediaType: d.declaredMediaType,
      }
    })
    const sendReplySpy = vi.spyOn(adapter, 'sendMessage').mockResolvedValue('reply-id')

    const sentMsgs: Message[] = []
    const rpc = makeRpc({
      ingestChannelAttachment: vi.fn(async meta => {
        callOrder.push(`ingest:${meta.messageId}`)
        return {
          ok: true as const,
          attachmentId: 'att-m1',
          fileReference: { name: 'doc.pdf' },
          expiresAt: '2026-12-01T00:00:00.000Z',
        }
      }),
      sendMessage: vi.fn(async msg => {
        callOrder.push(`message:${msg.messageId}`)
        sentMsgs.push(msg)
        return { success: true, status: 'completed' as const, response: `done-${msg.messageId}` }
      }),
    })

    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['teams', adapter]]),
    })

    // m1 (act-1, PDF, slow) and m2 (act-2, "summarize it") arrive back-to-back in 1:1 chat
    await reader.handleTeamsHandoff({
      kind: 'teams.attachment-message.v1',
      content: '',
      providerUserId: 'teams-user-1',
      providerWorkspaceId: 'tenant-1',
      providerChannelId: 'a:personal-chat',
      providerConversationId: 'a:personal-chat',
      providerReplyToMessageId: 'act-1',
      providerChannelType: 'personal',
      providerEventId: 'teams:tenant-1:a:personal-chat:act-1',
      providerMessageId: 'act-1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      attachments: [
        {
          providerAttachmentId: 'f1',
          filename: 'doc.pdf',
          declaredMediaType: 'application/pdf',
          reportedSizeBytes: 8,
          downloadRef: {
            provider: 'teams',
            mode: 'file_download_info',
            downloadUrl: 'https://contoso.sharepoint.com/doc.pdf',
          },
        },
      ],
      providerTarget: PROVIDER_TARGET,
    })
    await reader.handleTeamsHandoff({
      kind: 'teams.message',
      content: 'summarize it',
      providerUserId: 'teams-user-1',
      providerWorkspaceId: 'tenant-1',
      providerChannelId: 'a:personal-chat',
      providerConversationId: 'a:personal-chat',
      providerReplyToMessageId: 'act-2',
      providerChannelType: 'personal',
      providerEventId: 'teams:tenant-1:a:personal-chat:act-2',
      providerMessageId: 'act-2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      providerTarget: PROVIDER_TARGET,
    })

    releaseSlow()
    await reader.flushConversationQueues()

    expect(callOrder).toEqual(['ingest:act-1', 'message:act-1', 'message:act-2'])
    expect(sentMsgs[0]!.threadId).toBeUndefined()
    expect(sentMsgs[1]!.threadId).toBeUndefined()
    // Delivery replies still target act-1 and act-2 separately
    expect(sendReplySpy.mock.calls[0]?.[2]).toBe('act-1')
    expect(sendReplySpy.mock.calls[1]?.[2]).toBe('act-2')
  })

  it('S61 · keeps_teams_channel_thread_replies_with_replyToId_in_one_session', async () => {
    const adapter = new TeamsAdapter()
    await adapter.connect({
      teamsAppId: 'app-1',
      teamsTenantId: 'tenant-1',
      teamsAppPassword: 'secret',
    })
    vi.spyOn(adapter, 'downloadAttachment').mockResolvedValue({
      ok: true,
      bytes: Buffer.from('%PDF-1.7'),
      filename: 'spec.pdf',
      declaredMediaType: 'application/pdf',
    })
    const sendReplySpy = vi.spyOn(adapter, 'sendMessage').mockResolvedValue('reply-id')

    const sentMsgs: Message[] = []
    const rpc = makeRpc({
      sendMessage: vi.fn(async msg => {
        sentMsgs.push(msg)
        return { success: true, status: 'completed' as const, response: 'ok' }
      }),
    })

    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['teams', adapter]]),
    })

    // Root post (id=1001, PDF)
    await reader.handleTeamsHandoff({
      kind: 'teams.attachment-message.v1',
      content: 'here is the spec',
      providerUserId: 'teams-user-1',
      providerWorkspaceId: 'tenant-1',
      providerChannelId: '19:abc@thread.tacv2',
      providerConversationId: '19:abc@thread.tacv2;messageid=1001',
      providerThreadRootId: '1001',
      providerReplyToMessageId: '1001',
      providerChannelType: 'channel',
      providerEventId: 'teams:tenant-1:1001:1001',
      providerMessageId: '1001',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      attachments: [
        {
          providerAttachmentId: 'f1',
          filename: 'spec.pdf',
          declaredMediaType: 'application/pdf',
          reportedSizeBytes: 8,
          downloadRef: {
            provider: 'teams',
            mode: 'file_download_info',
            downloadUrl: 'https://contoso.sharepoint.com/spec.pdf',
          },
        },
      ],
      providerTarget: PROVIDER_TARGET,
    })

    // Thread reply (id=1003, replyToId=1002, providerReplyToMessageId=1003, providerThreadRootId=1001)
    await reader.handleTeamsHandoff({
      kind: 'teams.message',
      content: 'summarize it',
      providerUserId: 'teams-user-1',
      providerWorkspaceId: 'tenant-1',
      providerChannelId: '19:abc@thread.tacv2',
      providerConversationId: '19:abc@thread.tacv2;messageid=1001',
      providerThreadRootId: '1001',
      providerReplyToMessageId: '1003',
      providerChannelType: 'channel',
      providerEventId: 'teams:tenant-1:1001:1003',
      providerMessageId: '1003',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      providerTarget: PROVIDER_TARGET,
    })
    await reader.flushConversationQueues()

    expect(sentMsgs).toHaveLength(2)
    expect(sentMsgs[0]!.threadId).toBe('1001')
    expect(sentMsgs[1]!.threadId).toBe('1001')
    // Raw providerConversationId preserved for channelRuntimeSourceMismatch & Bot Framework delivery
    expect(sentMsgs[1]!.channelId).toBe('19:abc@thread.tacv2;messageid=1001')
    // Delivery reply still uses providerReplyToMessageId = '1003'
    expect(sendReplySpy.mock.calls[1]?.[2]).toBe('1003')
  })

  it('S70 · routes_file_download_through_auth_strategy_and_reports_401_410_expiry', async () => {
    const descriptor: ProviderAttachmentDescriptorV1 = {
      providerAttachmentId: 'sp-2027',
      filename: 'budget.xlsx',
      declaredMediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      reportedSizeBytes: 50,
      downloadRef: {
        provider: 'teams',
        mode: 'file_download_info',
        downloadUrl: 'https://contoso.sharepoint.com/sites/fin/budget.xlsx',
        uniqueId: 'sp-2027',
      },
    }

    // 1. Default strategy: 0 Authorization headers, maps 401 -> provider_download_auth_required, 410 -> provider_download_expired
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('Gone', { status: 410 }))
      .mockResolvedValueOnce(new Response('xlsx-2027-bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const defaultAdapter = new TeamsAdapter()
    const res401 = await defaultAdapter.downloadAttachment(descriptor)
    const res410 = await defaultAdapter.downloadAttachment(descriptor)

    expect(res401).toMatchObject({ ok: false, code: 'provider_download_auth_required' })
    expect(res410).toMatchObject({ ok: false, code: 'provider_download_expired' })
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toEqual({})
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toEqual({})

    // 2. Pluggable 2027 RSC/app-only strategy attaches storage token cleanly without changing descriptor
    const rscStrategy: TeamsFileDownloadAuthStrategy = {
      prepareDownloadRequest: vi.fn(async req => ({
        ok: true as const,
        url: new URL(req.downloadUrl),
        headers: { authorization: 'Bearer graph-rsc-storage-token' },
      })),
    }
    const rscAdapter = new TeamsAdapter({ fileDownloadAuthStrategy: rscStrategy })
    const res2027 = await rscAdapter.downloadAttachment(descriptor)

    expect(rscStrategy.prepareDownloadRequest).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toEqual({
      authorization: 'Bearer graph-rsc-storage-token',
    })
    expect(res2027).toEqual({
      ok: true,
      bytes: Buffer.from('xlsx-2027-bytes'),
      filename: 'budget.xlsx',
      declaredMediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
  })
})
