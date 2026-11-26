import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlackAdapter } from '../channels/slack'
import type { SlackMessageHandoff } from '../handoffServer'
import { ChannelReader, type ChannelReaderOptions } from '../main'
import type { Message, ProviderAttachmentDescriptorV1 } from '../types'

const slackState = vi.hoisted(() => ({
  instances: [] as Array<{
    auth: { test: ReturnType<typeof vi.fn> }
    conversations: {
      history: ReturnType<typeof vi.fn>
      replies: ReturnType<typeof vi.fn>
      info: ReturnType<typeof vi.fn>
      list: ReturnType<typeof vi.fn>
    }
    users: { info: ReturnType<typeof vi.fn> }
    chat: {
      postMessage: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
      postEphemeral: ReturnType<typeof vi.fn>
    }
    files: {
      info: ReturnType<typeof vi.fn>
      uploadV2: ReturnType<typeof vi.fn>
    }
  }>,
}))

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function () {
    const instance = {
      auth: {
        test: vi.fn().mockResolvedValue({
          user: 'clerum_bot',
          user_id: 'U_BOT',
          team_id: 'T123',
          ok: true,
        }),
      },
      conversations: {
        history: vi.fn().mockResolvedValue({ messages: [], ok: true }),
        replies: vi.fn().mockResolvedValue({ messages: [], ok: true }),
        info: vi.fn().mockResolvedValue({ channel: { id: 'C123', name: 'general' }, ok: true }),
        list: vi.fn().mockResolvedValue({ channels: [], ok: true }),
      },
      users: {
        info: vi.fn().mockResolvedValue({ user: { name: 'alice' }, ok: true }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1700000000.000100', ok: true }),
        update: vi.fn().mockResolvedValue({ ok: true }),
        postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      },
      files: {
        info: vi.fn().mockResolvedValue({ ok: true, file: {} }),
        uploadV2: vi.fn().mockResolvedValue({ ok: true }),
      },
    }
    slackState.instances.push(instance)
    return instance
  }),
}))

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

const SLACK_TOKEN = 'xoxb-slack-secret-token'
const PROVIDER_TARGET = {
  hostRef: 'test-host',
  communicationChannelNamespace: 'channels',
  communicationChannelName: 'slack-cc',
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

beforeEach(() => {
  slackState.instances.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Slack inbound attachments (X7)', () => {
  it('S9 · dedupes_app_mention_and_file_share_across_replicas_and_hydrates_files', async () => {
    const adapter = new SlackAdapter(null)
    await adapter.connect({ slackBotToken: SLACK_TOKEN })
    const client = slackState.instances[0]!

    const pdfBytes = Buffer.from('%PDF-1.7 quarterly report')
    client.conversations.history.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          ts: '1700001001.000100',
          user: 'U123',
          text: '<@U_BOT> analyze this',
          files: [
            {
              id: 'F_REPORT',
              name: 'report.pdf',
              mimetype: 'application/pdf',
              size: pdfBytes.byteLength,
              url_private_download:
                'https://files.slack.com/files-pri/T123-F_REPORT/download/report.pdf',
            },
          ],
        },
      ],
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(pdfBytes), { status: 200 }))
    )

    const rpc = makeRpc()
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['slack', adapter]]),
    })

    // Replica 1 delivers `app_mention` (0 attachments, event_id Ev1) first
    const appMentionHandoff: SlackMessageHandoff = {
      kind: 'slack.message',
      content: 'analyze this',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:Ev1',
      providerMessageTs: '1700001001.000100',
      threadTs: null,
      responseThreadTs: null,
      eventKind: 'event_callback',
      providerTarget: PROVIDER_TARGET,
    }
    // Replica 2 delivers `message(file_share)` (with attachments, distinct event_id Ev2)
    const fileShareHandoff: SlackMessageHandoff = {
      kind: 'slack.attachment-message.v1',
      content: 'analyze this',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:Ev2',
      providerMessageTs: '1700001001.000100',
      threadTs: null,
      responseThreadTs: null,
      eventKind: 'event_callback',
      attachments: [
        {
          providerAttachmentId: 'F_REPORT',
          filename: 'report.pdf',
          declaredMediaType: 'application/pdf',
          reportedSizeBytes: pdfBytes.byteLength,
          downloadRef: {
            provider: 'slack',
            fileId: 'F_REPORT',
            urlPrivateDownload:
              'https://files.slack.com/files-pri/T123-F_REPORT/download/report.pdf',
          },
        },
      ],
      providerTarget: PROVIDER_TARGET,
    }

    expect(await reader.handleSlackHandoff(appMentionHandoff)).toEqual({ ok: true })
    expect(await reader.handleSlackHandoff(fileShareHandoff)).toEqual({ ok: true })
    await reader.flushConversationQueues()

    expect(client.conversations.history).toHaveBeenCalledTimes(1)
    expect(rpc.ingestChannelAttachment).toHaveBeenCalledTimes(1)
    expect(rpc.sendMessage).toHaveBeenCalledTimes(1)
    const sentMsg = (vi.mocked(rpc.sendMessage).mock.calls[0] as unknown as [Message])[0]
    expect(sentMsg.channelAttachmentIds).toEqual(['att-F_REPORT'])
  })

  it('S10 · resolves_slack_connect_check_file_info', async () => {
    const adapter = new SlackAdapter(null)
    await adapter.connect({ slackBotToken: SLACK_TOKEN })
    const client = slackState.instances[0]!

    const content = Buffer.from('slack-connect-doc-bytes')
    client.files.info.mockResolvedValueOnce({
      ok: true,
      file: {
        id: 'F_CONNECT',
        name: 'shared.txt',
        mimetype: 'text/plain',
        size: content.byteLength,
        url_private_download:
          'https://files.slack.com/files-pri/T123-F_CONNECT/download/shared.txt',
      },
    })

    const fetchMock = vi.fn(async () => new Response(new Uint8Array(content), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.downloadAttachment({
      providerAttachmentId: 'F_CONNECT',
      filename: null,
      declaredMediaType: null,
      reportedSizeBytes: null,
      downloadRef: {
        provider: 'slack',
        fileId: 'F_CONNECT',
        fileAccess: 'check_file_info',
      },
    })

    expect(client.files.info).toHaveBeenCalledTimes(1)
    expect(client.files.info).toHaveBeenCalledWith({ file: 'F_CONNECT' })
    expect(result).toEqual({
      ok: true,
      bytes: content,
      filename: 'shared.txt',
      declaredMediaType: 'text/plain',
    })
  })

  it('S11 · detects_missing_files_read_scope_and_signin_html', async () => {
    const adapter = new SlackAdapter(null)
    await adapter.connect({ slackBotToken: SLACK_TOKEN })
    const client = slackState.instances[0]!

    // Case 1: files.info returns missing_scope
    client.files.info.mockRejectedValueOnce(
      Object.assign(new Error('An API error occurred: missing_scope'), {
        data: { error: 'missing_scope' },
      })
    )

    // Case 2: 302 redirect to /signin
    // Case 3: 200 text/html login page
    // Case 4 (liveness witness): valid non-HTML file succeeds
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('F_SIGNIN')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://myteam.slack.com/signin?redir=/files-pri/F_SIGNIN' },
        })
      }
      if (url.includes('F_HTML')) {
        return new Response('<html><body>Sign in to your workspace</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      if (url.includes('F_GOOD')) {
        return new Response('%PDF-1.7 ok', {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const descriptors: ProviderAttachmentDescriptorV1[] = [
      {
        providerAttachmentId: 'F_SCOPE',
        filename: 'scope.pdf',
        declaredMediaType: 'application/pdf',
        reportedSizeBytes: 100,
        downloadRef: { provider: 'slack', fileId: 'F_SCOPE', fileAccess: 'check_file_info' },
      },
      {
        providerAttachmentId: 'F_SIGNIN',
        filename: 'signin.pdf',
        declaredMediaType: 'application/pdf',
        reportedSizeBytes: 100,
        downloadRef: {
          provider: 'slack',
          fileId: 'F_SIGNIN',
          urlPrivateDownload: 'https://files.slack.com/files-pri/T123-F_SIGNIN/signin.pdf',
        },
      },
      {
        providerAttachmentId: 'F_HTML',
        filename: 'html.pdf',
        declaredMediaType: 'application/pdf',
        reportedSizeBytes: 100,
        downloadRef: {
          provider: 'slack',
          fileId: 'F_HTML',
          urlPrivateDownload: 'https://files.slack.com/files-pri/T123-F_HTML/html.pdf',
        },
      },
      {
        providerAttachmentId: 'F_GOOD',
        filename: 'good.pdf',
        declaredMediaType: 'application/pdf',
        reportedSizeBytes: 11,
        downloadRef: {
          provider: 'slack',
          fileId: 'F_GOOD',
          urlPrivateDownload: 'https://files.slack.com/files-pri/T123-F_GOOD/good.pdf',
        },
      },
    ]

    const rpc = makeRpc()
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['slack', adapter]]),
    })

    await reader.handleSlackHandoff({
      kind: 'slack.attachment-message.v1',
      content: 'read these',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:EvScope',
      providerMessageTs: '1700001100.000100',
      eventKind: 'event_callback',
      attachments: descriptors,
      providerTarget: PROVIDER_TARGET,
    })
    await reader.flushConversationQueues()

    // Only the 1 valid non-HTML PDF reached /ingest
    expect(rpc.ingestChannelAttachment).toHaveBeenCalledTimes(1)
    const sentMsg = (vi.mocked(rpc.sendMessage).mock.calls[0] as unknown as [Message])[0]
    expect(sentMsg.channelAttachmentIds).toEqual(['att-F_GOOD'])
    expect(sentMsg.attachmentIngestErrors?.map(e => e.code)).toEqual([
      'slack_files_read_scope_missing',
      'slack_files_read_scope_missing',
      'slack_files_read_scope_missing',
    ])
  })

  it('S12 · blocks_bearer_token_on_external_or_redirected_slack_files', async () => {
    const adapter = new SlackAdapter(null)
    await adapter.connect({ slackBotToken: SLACK_TOKEN })

    let externalAuthHeadersSeen = 0
    let externalRequestCount = 0

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (url.startsWith('https://evil.example')) {
        externalRequestCount += 1
        if (headers.authorization || headers.Authorization) {
          externalAuthHeadersSeen += 1
        }
        return new Response('evil', { status: 200 })
      }
      if (url.includes('F_REDIRECT')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/file' },
        })
      }
      if (url.includes('F_OK')) {
        expect(headers.authorization).toBe(`Bearer ${SLACK_TOKEN}`)
        return new Response('ok-bytes', { status: 200 })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const extRes = await adapter.downloadAttachment({
      providerAttachmentId: 'F_EXT',
      filename: 'gdoc.link',
      declaredMediaType: null,
      reportedSizeBytes: null,
      downloadRef: {
        provider: 'slack',
        fileId: 'F_EXT',
        urlPrivateDownload: 'https://evil.example/gdoc',
        isExternal: true,
      },
    })
    const redirRes = await adapter.downloadAttachment({
      providerAttachmentId: 'F_REDIRECT',
      filename: 'redir.pdf',
      declaredMediaType: 'application/pdf',
      reportedSizeBytes: 10,
      downloadRef: {
        provider: 'slack',
        fileId: 'F_REDIRECT',
        urlPrivateDownload: 'https://files.slack.com/files-pri/T123-F_REDIRECT/redir.pdf',
      },
    })
    const okRes = await adapter.downloadAttachment({
      providerAttachmentId: 'F_OK',
      filename: 'ok.txt',
      declaredMediaType: 'text/plain',
      reportedSizeBytes: 8,
      downloadRef: {
        provider: 'slack',
        fileId: 'F_OK',
        urlPrivateDownload: 'https://files.slack.com/files-pri/T123-F_OK/ok.txt',
      },
    })

    expect(extRes).toMatchObject({ ok: false, code: 'provider_remote_file_unsupported' })
    expect(redirRes).toMatchObject({ ok: false, code: 'provider_remote_file_unsupported' })
    expect(externalRequestCount).toBe(0)
    expect(externalAuthHeadersSeen).toBe(0)
    // Liveness witness: valid files.slack.com download succeeds with token
    expect(okRes).toEqual({
      ok: true,
      bytes: Buffer.from('ok-bytes'),
      filename: 'ok.txt',
      declaredMediaType: 'text/plain',
    })
  })

  it('S55 · handles_slack_replyInThreads_dm_and_channel_thread_continuity', async () => {
    const adapter = new SlackAdapter(null)
    await adapter.connect({ slackBotToken: SLACK_TOKEN })

    const callOrder: string[] = []
    let resolveSlowDownload!: () => void
    const slowDownloadGate = new Promise<void>(resolve => {
      resolveSlowDownload = resolve
    })

    vi.spyOn(adapter, 'downloadAttachment').mockImplementation(async d => {
      await slowDownloadGate
      return {
        ok: true,
        bytes: Buffer.from(`bytes-${d.providerAttachmentId}`),
        filename: d.filename,
        declaredMediaType: d.declaredMediaType,
      }
    })

    const sentMsgs: Message[] = []
    const rpc = makeRpc({
      ingestChannelAttachment: vi.fn(async meta => {
        callOrder.push(`ingest:${meta.messageId}`)
        return {
          ok: true as const,
          attachmentId: `att-${meta.messageId}`,
          fileReference: { name: 'doc.pdf' },
          expiresAt: '2026-12-01T00:00:00.000Z',
        }
      }),
      sendMessage: vi.fn(async msg => {
        callOrder.push(`message:${msg.messageId}`)
        sentMsgs.push(msg)
        return { success: true, status: 'completed' as const, response: 'ok' }
      }),
    })

    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['slack', adapter]]),
      channels: [
        {
          name: 'slack-cc',
          namespace: 'channels',
          spec: {
            hostRef: 'test-host',
            slackSettings: { workspaceId: 'T123', replyInThreads: true },
            slack: [{ channelId: 'C123' }, { channelId: 'D999' }],
          },
        },
      ],
    })

    // (a) Slack DM (`D999`) with replyInThreads: true -> m1 (PDF, slow) + m2 (fast follow-up)
    await reader.handleSlackHandoff({
      kind: 'slack.attachment-message.v1',
      content: '',
      providerUserId: 'U1',
      providerWorkspaceId: 'T123',
      providerChannelId: 'D999',
      providerEventId: 'slack:T123:D999:EvM1',
      providerMessageTs: '1001',
      threadTs: null,
      responseThreadTs: '1001',
      eventKind: 'event_callback',
      attachments: [
        {
          providerAttachmentId: 'F1',
          filename: 'doc.pdf',
          declaredMediaType: 'application/pdf',
          reportedSizeBytes: 100,
          downloadRef: {
            provider: 'slack',
            fileId: 'F1',
            urlPrivateDownload: 'https://files.slack.com/files-pri/T123-F1/doc.pdf',
          },
        },
      ],
      providerTarget: PROVIDER_TARGET,
    })
    await reader.handleSlackHandoff({
      kind: 'slack.message',
      content: 'summarize it',
      providerUserId: 'U1',
      providerWorkspaceId: 'T123',
      providerChannelId: 'D999',
      providerEventId: 'slack:T123:D999:EvM2',
      providerMessageTs: '1002',
      threadTs: null,
      responseThreadTs: '1002',
      eventKind: 'event_callback',
      rawData: { eventType: 'message' },
      providerTarget: PROVIDER_TARGET,
    })

    resolveSlowDownload()
    await reader.flushConversationQueues()

    expect(callOrder).toEqual(['ingest:1001', 'message:1001', 'message:1002'])
    // Both DM messages MUST have sessionThreadId === undefined (:default), while replyToMessageId keeps responseThreadTs!
    expect(sentMsgs[0]!.threadId).toBeUndefined()
    expect(sentMsgs[0]!.replyToMessageId).toBe('1001')
    expect(sentMsgs[1]!.threadId).toBeUndefined()
    expect(sentMsgs[1]!.replyToMessageId).toBe('1002')

    // (b) Slack channel (`C123`) with replyInThreads: true -> top-level m1 (ts=2001) + thread reply m3 (thread_ts=2001)
    await reader.handleSlackHandoff({
      kind: 'slack.attachment-message.v1',
      content: 'upload',
      providerUserId: 'U1',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:EvC1',
      providerMessageTs: '2001',
      threadTs: null,
      responseThreadTs: '2001',
      eventKind: 'event_callback',
      attachments: [
        {
          providerAttachmentId: 'F2',
          filename: 'c.pdf',
          declaredMediaType: 'application/pdf',
          reportedSizeBytes: 50,
          downloadRef: {
            provider: 'slack',
            fileId: 'F2',
            urlPrivateDownload: 'https://files.slack.com/files-pri/T123-F2/c.pdf',
          },
        },
      ],
      providerTarget: PROVIDER_TARGET,
    })
    await reader.handleSlackHandoff({
      kind: 'slack.message',
      content: 'follow up in thread',
      providerUserId: 'U1',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:EvC3',
      providerMessageTs: '2003',
      threadTs: '2001',
      responseThreadTs: '2001',
      eventKind: 'event_callback',
      rawData: { eventType: 'message' },
      providerTarget: PROVIDER_TARGET,
    })
    await reader.flushConversationQueues()

    expect(sentMsgs[2]!.threadId).toBe('2001')
    expect(sentMsgs[3]!.threadId).toBe('2001')
  })

  it('S56 · hydrates_thread_files_via_conversations_replies_when_replyInThreads_false', async () => {
    const adapter = new SlackAdapter(null)
    await adapter.connect({ slackBotToken: SLACK_TOKEN })
    const client = slackState.instances[0]!

    const reportBytes = Buffer.from('%PDF-1.7 thread report')
    // Slack conversations.replies always returns thread parent at [0] and the target reply at [1]
    client.conversations.replies.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          ts: 'T1',
          user: 'U0',
          text: 'thread root',
          files: [{ id: 'F_PARENT', name: 'parent.txt' }],
        },
        {
          ts: '1700005002.000100',
          thread_ts: 'T1',
          user: 'U1',
          text: '<@U_BOT> analyze thread file',
          files: [
            {
              id: 'F_THREAD_PDF',
              name: 'report.pdf',
              mimetype: 'application/pdf',
              size: reportBytes.byteLength,
              url_private_download:
                'https://files.slack.com/files-pri/T123-F_THREAD_PDF/report.pdf',
            },
          ],
        },
      ],
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(reportBytes), { status: 200 }))
    )

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
      adapters: new Map([['slack', adapter]]),
      channels: [
        {
          name: 'slack-cc',
          namespace: 'channels',
          spec: {
            hostRef: 'test-host',
            slackSettings: { workspaceId: 'T123', replyInThreads: false },
            slack: [{ channelId: 'C123' }],
          },
        },
      ],
    })

    await reader.handleSlackHandoff({
      kind: 'slack.message',
      content: 'analyze thread file',
      providerUserId: 'U1',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:EvThreadMention',
      providerMessageTs: '1700005002.000100',
      threadTs: 'T1',
      responseThreadTs: null,
      eventKind: 'event_callback',
      providerTarget: PROVIDER_TARGET,
    })
    await reader.flushConversationQueues()

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: 'C123',
      ts: 'T1',
      latest: '1700005002.000100',
      oldest: '1700005002.000100',
      inclusive: true,
      limit: 10,
    })
    expect(client.conversations.history).not.toHaveBeenCalled()
    expect(sentMsgs).toHaveLength(1)
    expect(sentMsgs[0]!.threadId).toBe('T1')
    expect(sentMsgs[0]!.replyToMessageId).toBeNull()
    expect(sentMsgs[0]!.channelAttachmentIds).toEqual(['att-F_THREAD_PDF'])
  })

  it('S59 · allows_consecutive_block_actions_approvals_on_reused_status_bubble', async () => {
    const adapter = new SlackAdapter(null)
    await adapter.connect({ slackBotToken: SLACK_TOKEN })
    const client = slackState.instances[0]!

    let sendCount = 0
    const rpc = makeRpc({
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-multi',
          requestId: `req-${++sendCount}`,
          userId: 'U1',
          notification: `Approve tool #${sendCount}`,
        },
      })),
    })

    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['slack', adapter]]),
    })

    // Register first pending approval directly via initial turn
    await reader.handleSlackHandoff({
      kind: 'slack.message',
      content: 'run two tools',
      providerUserId: 'U1',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:EvInit',
      providerMessageTs: '1700009000.000100',
      threadTs: null,
      responseThreadTs: '1700009000.000100',
      eventKind: 'event_callback',
      rawData: { eventType: 'message' },
      providerTarget: PROVIDER_TARGET,
    })
    await reader.flushConversationQueues()

    const pendingMap = (
      reader as unknown as {
        pendingApprovals: Map<string, { actionToken: string; requestId: string }>
      }
    ).pendingApprovals
    const firstPending = [...pendingMap.values()][0]!

    // Click #1 on status bubble T_bubble
    await reader.handleSlackHandoff({
      kind: 'slack.message',
      content: `tool:a:${firstPending.actionToken}`,
      providerUserId: 'U1',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:trigger-click-1',
      providerMessageTs: 'T_bubble',
      threadTs: null,
      responseThreadTs: '1700009000.000100',
      eventKind: 'block_actions',
      providerTarget: PROVIDER_TARGET,
    })
    await reader.flushConversationQueues()

    // Re-populate pending approval #2 on the same edited status bubble T_bubble
    pendingMap.set('slack:C123:1700009000.000100:U1', {
      taskId: 'task-multi',
      requestId: 'req-2',
      userId: 'U1',
      channelType: 'slack',
      channelId: 'C123',
      originalMessage: {
        channelType: 'slack',
        channelId: 'C123',
        sender: 'U1',
        content: 'run two tools',
        timestamp: new Date(),
        messageId: '1700009000.000100',
        threadId: '1700009000.000100',
        providerIdentity: {
          medium: 'slack',
          providerUserId: 'U1',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
          providerEventId: 'slack:T123:C123:EvInit',
          providerTarget: PROVIDER_TARGET,
        },
      },
      createdAt: new Date(),
      actionToken: 'secondToken12345',
    } as never)

    // Click #2 on the EXACT SAME status bubble `providerMessageTs: 'T_bubble'` with distinct trigger_id
    await reader.handleSlackHandoff({
      kind: 'slack.message',
      content: 'tool:a:secondToken12345',
      providerUserId: 'U1',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:trigger-click-2',
      providerMessageTs: 'T_bubble',
      threadTs: null,
      responseThreadTs: '1700009000.000100',
      eventKind: 'block_actions',
      providerTarget: PROVIDER_TARGET,
    })
    await reader.flushConversationQueues()

    expect(rpc.sendApproval).toHaveBeenCalledTimes(2)
    expect(client.conversations.history).toHaveBeenCalledTimes(0)
  })
})
