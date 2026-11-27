import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer as createHttpServer } from 'node:http'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type SlackTargetHandoffContext,
  type TeamsTargetHandoffContext,
  handoffSlackMessageToChannelReader,
  handoffTeamsMessageToChannelReader,
} from '../src/channelReaderClient.js'
import type { ReaderConfig } from '../src/config.js'
import { normalizeSlackMessage, normalizeTeamsMessage } from '../src/decisionHandler.js'

vi.mock('../src/controlApiClient.js', () => ({
  resolveTeamsTarget: vi.fn(),
  resolveCommunicationChannelRef: vi.fn(),
  sendSlackTargetMessage: vi.fn().mockResolvedValue({ ok: true }),
  sendTeamsTargetMessage: vi.fn().mockResolvedValue({ ok: true }),
  updateSlackTargetMessage: vi.fn().mockResolvedValue({ ok: true }),
  updateTeamsTargetMessage: vi.fn().mockResolvedValue({ ok: true }),
  verifySlackTargetSignature: vi.fn(),
}))

vi.mock('../src/teamsAuth.js', () => ({
  verifyTeamsAuthorization: vi.fn().mockResolvedValue({ ok: true }),
}))

const SLACK_TARGET_ID = 'slack:inbound-target'
const TEAMS_TARGET_ID = 'teams:inbound-target'
const HANDOFF_TOKEN = 'test-handoff-token'

type CapturedHandoff = {
  path: string
  authorization: string | undefined
  body: Record<string, unknown>
}

async function startHandoffReceiver(
  handler?: (path: string, body: Record<string, unknown>) => { status: number; body: unknown }
): Promise<{
  urlTemplate: string
  received: CapturedHandoff[]
  close: () => Promise<void>
}> {
  const received: CapturedHandoff[] = []
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      received.push({
        path: req.url || '/',
        authorization: req.headers.authorization,
        body: parsed,
      })
      const reply = handler ? handler(req.url || '/', parsed) : { status: 200, body: { ok: true } }
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    urlTemplate: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function makeConfig(
  channelReaderUrlTemplate: string,
  mcpHostBaseUrl = 'http://127.0.0.1:1'
): ReaderConfig {
  return {
    port: 0,
    mcpHostBaseUrl,
    mcpHostRef: 'host-1',
    mcpHostTargets: [{ hostRef: 'host-1', baseUrl: mcpHostBaseUrl }],
    enabledMedia: new Set(['slack', 'teams']),
    mcpHostTimeoutMs: 5000,
    mcpHostMessageTimeoutMs: 120_000,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 1000,
    controlApiBaseUrl: '',
    controlApiToken: '',
    controlApiTimeoutMs: 4000,
    channelReaderUrlTemplate,
    channelReaderHandoffToken: HANDOFF_TOKEN,
    channelReaderHandoffTimeoutMs: 5000,
  }
}

async function postWebhook(
  server: http.Server,
  medium: 'slack' | 'teams',
  targetId: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const { port } = server.address() as AddressInfo
  const response = await fetch(
    `http://127.0.0.1:${port}/webhooks/${medium}/${encodeURIComponent(targetId)}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body,
    }
  )
  return { status: response.status, body: await response.json() }
}

async function waitForCount(items: unknown[], expected: number): Promise<void> {
  await vi.waitFor(() => {
    expect(items.length).toBeGreaterThanOrEqual(expected)
  })
}

const SLACK_HEADERS = {
  'x-slack-request-timestamp': '1710000000',
  'x-slack-signature': 'v0=verified-by-mock',
}

const TEAMS_HEADERS = {
  authorization: 'Bearer teams-verified-jwt',
}

describe('inbound attachments webhook normalization & handoff (X7 / X8)', () => {
  let createServer: typeof import('../src/server.js').createServer
  let verifySlackTargetSignature: ReturnType<typeof vi.fn>
  let resolveTeamsTarget: ReturnType<typeof vi.fn>
  let sendSlackTargetMessage: ReturnType<typeof vi.fn>
  let sendTeamsTargetMessage: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    ;({ createServer } = await import('../src/server.js'))
    const controlApi = await import('../src/controlApiClient.js')
    verifySlackTargetSignature = vi.mocked(controlApi.verifySlackTargetSignature)
    resolveTeamsTarget = vi.mocked(controlApi.resolveTeamsTarget)
    sendSlackTargetMessage = vi.mocked(controlApi.sendSlackTargetMessage)
    sendTeamsTargetMessage = vi.mocked(controlApi.sendTeamsTargetMessage)
    sendSlackTargetMessage.mockResolvedValue({ ok: true })
    sendTeamsTargetMessage.mockResolvedValue({ ok: true })

    verifySlackTargetSignature.mockResolvedValue({
      ok: true,
      hostRef: 'host-1',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: false,
      replyOnlyWhenMentioned: false,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })
    resolveTeamsTarget.mockResolvedValue({
      ok: true,
      hostRef: 'host-1',
      communicationChannelRef: 'channels/teams-bot',
      providerWorkspaceId: 'tenant-1',
      replyOnlyWhenMentioned: false,
      appId: 'teams-app-1',
      appName: 'evenfire',
      tenantId: 'tenant-1',
      channelName: 'teams-bot',
      channelNamespace: 'channels',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('normalizes_slack_file_share_with_text', async () => {
    const handoff = await startHandoffReceiver()
    const server = createServer(makeConfig(handoff.urlTemplate))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    try {
      const payload = {
        type: 'event_callback',
        team_id: 'T123',
        event_id: 'Ev-s7-file-share-1',
        authorizations: [{ team_id: 'T123', user_id: 'UBOTID', is_bot: true }],
        event: {
          type: 'message',
          subtype: 'file_share',
          user: 'U123',
          channel: 'C123',
          text: 'Please review these files',
          ts: '1710000100.000001',
          thread_ts: '1710000099.000001',
          files: [
            {
              id: 'F_PDF_1',
              name: 'contract.pdf',
              mimetype: 'application/pdf',
              size: 4096,
              url_private_download:
                'https://files.slack.com/files-pri/T123-F_PDF_1/download/contract.pdf',
              url_private: 'https://files.slack.com/files-pri/T123-F_PDF_1/contract.pdf',
              file_access: 'visible',
              is_external: false,
            },
            {
              id: 'F_BIN_2',
              name: 'NOTES',
              mimetype: 'application/octet-stream',
              size: 128,
              url_private_download: 'https://files.slack.com/files-pri/T123-F_BIN_2/download/notes',
              url_private: 'https://files.slack.com/files-pri/T123-F_BIN_2/notes',
            },
            {
              id: 'F_CONNECT_3',
              name: 'shared.xlsx',
              file_access: 'check_file_info',
              is_external: false,
            },
            {
              id: 'F_EXT_4',
              name: 'drive-doc',
              mimetype: 'application/vnd.google-apps.document',
              is_external: true,
              url_private: 'https://docs.google.com/document/d/abc',
            },
          ],
        },
      }

      const response = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify(payload),
        SLACK_HEADERS
      )

      expect(response).toEqual({ status: 200, body: { ok: true } })
      await waitForCount(handoff.received, 1)

      expect(handoff.received).toHaveLength(1)
      expect(handoff.received[0]!.path).toBe('/internal/slack/handoff')
      expect(handoff.received[0]!.authorization).toBe(`Bearer ${HANDOFF_TOKEN}`)
      expect(handoff.received[0]!.body).toEqual({
        kind: 'slack.attachment-message.v1',
        content: 'Please review these files',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
        providerEventId: 'slack:T123:C123:1710000100.000001',
        providerMessageTs: '1710000100.000001',
        threadTs: '1710000099.000001',
        responseThreadTs: null,
        eventKind: 'event_callback',
        slackEventType: 'message',
        attachments: [
          {
            providerAttachmentId: 'F_PDF_1',
            filename: 'contract.pdf',
            declaredMediaType: 'application/pdf',
            reportedSizeBytes: 4096,
            downloadRef: {
              provider: 'slack',
              fileId: 'F_PDF_1',
              urlPrivateDownload:
                'https://files.slack.com/files-pri/T123-F_PDF_1/download/contract.pdf',
              urlPrivate: 'https://files.slack.com/files-pri/T123-F_PDF_1/contract.pdf',
              fileAccess: 'visible',
              isExternal: false,
            },
          },
          {
            providerAttachmentId: 'F_BIN_2',
            filename: 'NOTES',
            declaredMediaType: 'application/octet-stream',
            reportedSizeBytes: 128,
            downloadRef: {
              provider: 'slack',
              fileId: 'F_BIN_2',
              urlPrivateDownload: 'https://files.slack.com/files-pri/T123-F_BIN_2/download/notes',
              urlPrivate: 'https://files.slack.com/files-pri/T123-F_BIN_2/notes',
              fileAccess: null,
              isExternal: false,
            },
          },
          {
            providerAttachmentId: 'F_CONNECT_3',
            filename: 'shared.xlsx',
            declaredMediaType: null,
            reportedSizeBytes: null,
            downloadRef: {
              provider: 'slack',
              fileId: 'F_CONNECT_3',
              urlPrivateDownload: null,
              urlPrivate: null,
              fileAccess: 'check_file_info',
              isExternal: false,
            },
          },
          {
            providerAttachmentId: 'F_EXT_4',
            filename: 'drive-doc',
            declaredMediaType: 'application/vnd.google-apps.document',
            reportedSizeBytes: null,
            downloadRef: {
              provider: 'slack',
              fileId: 'F_EXT_4',
              urlPrivateDownload: null,
              urlPrivate: 'https://docs.google.com/document/d/abc',
              fileAccess: null,
              isExternal: true,
            },
          },
        ],
        providerTarget: {
          hostRef: 'host-1',
          communicationChannelNamespace: 'channels',
          communicationChannelName: 'slack-app',
        },
      })

      // Negative assertion with liveness witness: webhook reader made 0 external
      // file download calls (the only outbound fetch calls are the test POST
      // and the internal channel-reader handoff).
      const fetchedUrls = fetchSpy.mock.calls.map(call => String(call[0]))
      expect(fetchedUrls.some(url => url.includes('/internal/slack/handoff'))).toBe(true)
      expect(fetchedUrls.filter(url => url.includes('files.slack.com'))).toHaveLength(0)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await handoff.close()
    }
  })

  it('preserves_slack_empty_text_and_mention_only_file_share', async () => {
    verifySlackTargetSignature.mockResolvedValue({
      ok: true,
      hostRef: 'host-1',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: false,
      replyOnlyWhenMentioned: true,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })

    const handoff = await startHandoffReceiver()
    const server = createServer(makeConfig(handoff.urlTemplate))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      // 1) DM file_share with empty text
      const dmRes = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-s8-dm-empty',
          authorizations: [{ team_id: 'T123', user_id: 'UBOTID' }],
          event: {
            type: 'message',
            subtype: 'file_share',
            user: 'U123',
            channel: 'D123',
            text: '',
            ts: '1710000200.000001',
            files: [
              {
                id: 'F_DM_1',
                name: 'receipt.pdf',
                mimetype: 'application/pdf',
                size: 1024,
                url_private_download:
                  'https://files.slack.com/files-pri/T123-F_DM_1/download/receipt.pdf',
              },
            ],
          },
        }),
        SLACK_HEADERS
      )
      expect(dmRes).toEqual({ status: 200, body: { ok: true } })

      // 2) Channel mention-only file_share under replyOnlyWhenMentioned=true
      const mentionOnlyFileRes = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-s8-channel-mention-only-file',
          authorizations: [{ team_id: 'T123', user_id: 'UBOTID' }],
          event: {
            type: 'message',
            subtype: 'file_share',
            user: 'U123',
            channel: 'C123',
            text: '<@UBOTID>',
            ts: '1710000200.000002',
            files: [
              {
                id: 'F_CH_1',
                name: 'invoice.pdf',
                mimetype: 'application/pdf',
                size: 2048,
                url_private_download:
                  'https://files.slack.com/files-pri/T123-F_CH_1/download/invoice.pdf',
              },
            ],
          },
        }),
        SLACK_HEADERS
      )
      expect(mentionOnlyFileRes).toEqual({ status: 200, body: { ok: true } })

      // 3) Negative control: mention-only message WITHOUT files must still be ignored
      const mentionOnlyNoFileRes = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-s8-channel-mention-only-no-file',
          authorizations: [{ team_id: 'T123', user_id: 'UBOTID' }],
          event: {
            type: 'message',
            user: 'U123',
            channel: 'C123',
            text: '<@UBOTID>',
            ts: '1710000200.000003',
          },
        }),
        SLACK_HEADERS
      )
      expect(mentionOnlyNoFileRes).toEqual({ status: 200, body: { ok: true, ignored: true } })

      await waitForCount(handoff.received, 2)
      expect(handoff.received).toHaveLength(2)
      expect(handoff.received[0]!.body).toMatchObject({
        kind: 'slack.attachment-message.v1',
        content: '',
        providerChannelId: 'D123',
        eventKind: 'event_callback',
        attachments: [expect.objectContaining({ providerAttachmentId: 'F_DM_1' })],
      })
      expect(handoff.received[1]!.body).toMatchObject({
        kind: 'slack.attachment-message.v1',
        content: '',
        providerChannelId: 'C123',
        eventKind: 'event_callback',
        attachments: [expect.objectContaining({ providerAttachmentId: 'F_CH_1' })],
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await handoff.close()
    }
  })

  it('accepts_slack_non_leading_mention_on_file_share', async () => {
    const handoff = await startHandoffReceiver()
    const server = createServer(makeConfig(handoff.urlTemplate))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      // Case A: botUserId resolved from signed payload.authorizations[].user_id
      verifySlackTargetSignature.mockResolvedValueOnce({
        ok: true,
        hostRef: 'host-1',
        communicationChannelRef: 'channels/slack-app',
        providerWorkspaceId: 'T123',
        replyInThreads: false,
        replyOnlyWhenMentioned: true,
        channelName: 'slack-app',
        channelNamespace: 'channels',
      })
      const authPayloadRes = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-s50-auth-1',
          authorizations: [{ team_id: 'T123', user_id: 'UBOTID', is_bot: true }],
          event: {
            type: 'message',
            subtype: 'file_share',
            user: 'U123',
            channel: 'C123',
            text: 'please analyze <@UBOTID>',
            ts: '1710000300.000001',
            files: [
              {
                id: 'F_S50_1',
                name: 'report.pdf',
                mimetype: 'application/pdf',
                size: 512,
                url_private_download:
                  'https://files.slack.com/files-pri/T123-F_S50_1/download/report.pdf',
              },
            ],
          },
        }),
        SLACK_HEADERS
      )
      expect(authPayloadRes).toEqual({ status: 200, body: { ok: true } })

      // Case B: botUserId fallback from SlackTargetContext.botUserId (control-api verify response)
      verifySlackTargetSignature.mockResolvedValueOnce({
        ok: true,
        hostRef: 'host-1',
        communicationChannelRef: 'channels/slack-app',
        providerWorkspaceId: 'T123',
        replyInThreads: false,
        replyOnlyWhenMentioned: true,
        botUserId: 'UBOTFALLBACK',
        channelName: 'slack-app',
        channelNamespace: 'channels',
      })
      const targetFallbackRes = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-s50-fallback-2',
          event: {
            type: 'message',
            subtype: 'file_share',
            user: 'U123',
            channel: 'C123',
            text: 'check this <@UBOTFALLBACK> please',
            ts: '1710000300.000002',
            files: [
              {
                id: 'F_S50_2',
                name: 'budget.xlsx',
                mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                size: 768,
                url_private_download:
                  'https://files.slack.com/files-pri/T123-F_S50_2/download/budget.xlsx',
              },
            ],
          },
        }),
        SLACK_HEADERS
      )
      expect(targetFallbackRes).toEqual({ status: 200, body: { ok: true } })

      // Case C (negative with liveness witness): message mentioning <@UOTHER> is ignored
      verifySlackTargetSignature.mockResolvedValueOnce({
        ok: true,
        hostRef: 'host-1',
        communicationChannelRef: 'channels/slack-app',
        providerWorkspaceId: 'T123',
        replyInThreads: false,
        replyOnlyWhenMentioned: true,
        channelName: 'slack-app',
        channelNamespace: 'channels',
      })
      const otherMentionRes = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-s50-other-3',
          authorizations: [{ team_id: 'T123', user_id: 'UBOTID', is_bot: true }],
          event: {
            type: 'message',
            subtype: 'file_share',
            user: 'U123',
            channel: 'C123',
            text: '<@UOTHER> please analyze',
            ts: '1710000300.000003',
            files: [
              {
                id: 'F_S50_3',
                name: 'other.pdf',
                mimetype: 'application/pdf',
                size: 100,
              },
            ],
          },
        }),
        SLACK_HEADERS
      )
      expect(otherMentionRes).toEqual({ status: 200, body: { ok: true, ignored: true } })

      await waitForCount(handoff.received, 2)
      expect(handoff.received).toHaveLength(2)
      expect(handoff.received[0]!.body).toMatchObject({
        kind: 'slack.attachment-message.v1',
        content: 'please analyze',
        attachments: [
          expect.objectContaining({ providerAttachmentId: 'F_S50_1', filename: 'report.pdf' }),
        ],
      })
      expect(handoff.received[1]!.body).toMatchObject({
        kind: 'slack.attachment-message.v1',
        content: 'check this please',
        attachments: [
          expect.objectContaining({ providerAttachmentId: 'F_S50_2', filename: 'budget.xlsx' }),
        ],
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await handoff.close()
    }
  })

  it('keys_slack_webhook_dedupe_on_event_id_so_app_mention_and_file_share_do_not_suppress_each_other', async () => {
    verifySlackTargetSignature.mockResolvedValue({
      ok: true,
      hostRef: 'host-1',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: false,
      replyOnlyWhenMentioned: true,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })

    const handoff = await startHandoffReceiver()
    const server = createServer(makeConfig(handoff.urlTemplate))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      const appMentionPayload = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event_id: 'Ev-s9-mention-1',
        authorizations: [{ team_id: 'T123', user_id: 'UBOTID' }],
        event: {
          type: 'app_mention',
          user: 'U123',
          channel: 'C123',
          text: '<@UBOTID> summarize this',
          ts: '1710000400.000001',
        },
      })
      const fileSharePayload = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event_id: 'Ev-s9-fileshare-2',
        authorizations: [{ team_id: 'T123', user_id: 'UBOTID' }],
        event: {
          type: 'message',
          subtype: 'file_share',
          user: 'U123',
          channel: 'C123',
          text: '<@UBOTID> summarize this',
          ts: '1710000400.000001',
          files: [
            {
              id: 'F_S9_1',
              name: 'summary.pdf',
              mimetype: 'application/pdf',
              size: 999,
            },
          ],
        },
      })

      const res1 = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        appMentionPayload,
        SLACK_HEADERS
      )
      const res2 = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        fileSharePayload,
        SLACK_HEADERS
      )
      const retryRes = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        fileSharePayload,
        SLACK_HEADERS
      )

      expect(res1).toEqual({ status: 200, body: { ok: true } })
      expect(res2).toEqual({ status: 200, body: { ok: true } })
      expect(retryRes).toEqual({ status: 200, body: { ok: true, ignored: true } })

      await waitForCount(handoff.received, 2)
      expect(handoff.received).toHaveLength(2)
      expect(handoff.received[0]!.body).toMatchObject({
        kind: 'slack.message',
        eventKind: 'event_callback',
        providerMessageTs: '1710000400.000001',
        content: 'summarize this',
      })
      expect(handoff.received[1]!.body).toMatchObject({
        kind: 'slack.attachment-message.v1',
        eventKind: 'event_callback',
        providerMessageTs: '1710000400.000001',
        content: 'summarize this',
        attachments: [expect.objectContaining({ providerAttachmentId: 'F_S9_1' })],
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await handoff.close()
    }
  })

  it('populates_slack_thread_ts_even_when_reply_in_threads_is_false_and_tags_event_kind', async () => {
    verifySlackTargetSignature.mockResolvedValue({
      ok: true,
      hostRef: 'host-1',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: false,
      replyOnlyWhenMentioned: true,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })

    const handoff = await startHandoffReceiver()
    const server = createServer(makeConfig(handoff.urlTemplate))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      // S56: replyInThreads=false still preserves inbound event.thread_ts while responseThreadTs is null
      await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-s56-thread-1',
          authorizations: [{ team_id: 'T123', user_id: 'UBOTID' }],
          event: {
            type: 'app_mention',
            user: 'U123',
            channel: 'C123',
            text: '<@UBOTID> check thread file',
            ts: '1710000500.000002',
            thread_ts: '1710000500.000001',
          },
        }),
        SLACK_HEADERS
      )

      // S59: two consecutive block_actions on the same reused status bubble carry eventKind='block_actions'
      const makeBlockAction = (triggerId: string, actionValue: string) =>
        JSON.stringify({
          type: 'block_actions',
          trigger_id: triggerId,
          user: { id: 'U123' },
          team: { id: 'T123' },
          channel: { id: 'C123' },
          message: { ts: '1710000500.000010', thread_ts: '1710000500.000001' },
          actions: [{ value: actionValue }],
        })

      await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        makeBlockAction('trigger-s59-1', 'tool:a:aaaaaaaaaaaaaaaa'),
        SLACK_HEADERS
      )
      await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        makeBlockAction('trigger-s59-2', 'tool:a:bbbbbbbbbbbbbbbb'),
        SLACK_HEADERS
      )

      await waitForCount(handoff.received, 3)
      expect(handoff.received[0]!.body).toMatchObject({
        kind: 'slack.message',
        eventKind: 'event_callback',
        threadTs: '1710000500.000001',
        responseThreadTs: null,
        providerMessageTs: '1710000500.000002',
      })
      expect(handoff.received[1]!.body).toMatchObject({
        kind: 'slack.message',
        eventKind: 'block_actions',
        providerEventId: 'slack:T123:C123:trigger-s59-1',
        providerMessageTs: '1710000500.000010',
        threadTs: '1710000500.000001',
        responseThreadTs: null,
      })
      expect(handoff.received[2]!.body).toMatchObject({
        kind: 'slack.message',
        eventKind: 'block_actions',
        providerEventId: 'slack:T123:C123:trigger-s59-2',
        providerMessageTs: '1710000500.000010',
        threadTs: '1710000500.000001',
        responseThreadTs: null,
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await handoff.close()
    }
  })

  it('normalizes_teams_file_download_info_and_empty_text', async () => {
    const handoff = await startHandoffReceiver()
    const server = createServer(makeConfig(handoff.urlTemplate))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      const activityWithText = {
        type: 'message',
        id: 'teams-s13-act-1',
        text: 'Please summarize this report',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        from: { id: 'teams-user-1' },
        conversation: {
          id: 'a:personal-chat-1',
          conversationType: 'personal',
          tenantId: 'tenant-1',
        },
        channelData: { tenant: { id: 'tenant-1' } },
        attachments: [
          {
            contentType: 'application/vnd.microsoft.teams.file.download.info',
            contentUrl: 'https://tenant.sharepoint.com/personal/u/Documents/report.pdf',
            name: 'report.pdf',
            content: {
              downloadUrl: 'https://tenant.sharepoint.com/_layouts/15/download.aspx?UniqueId=u1',
              uniqueId: 'unique-file-1',
              fileType: 'pdf',
            },
          },
          {
            contentType: 'application/vnd.microsoft.teams.file.download.info',
            name: 'archive.custombin',
            content: {
              downloadUrl: 'https://tenant.sharepoint.com/_layouts/15/download.aspx?UniqueId=u2',
              fileType: 'custombin',
            },
          },
        ],
      }

      const emptyTextActivity = {
        ...activityWithText,
        id: 'teams-s13-act-2',
        text: '',
        attachments: [activityWithText.attachments[0]],
      }

      const res1 = await postWebhook(
        server,
        'teams',
        TEAMS_TARGET_ID,
        JSON.stringify(activityWithText),
        TEAMS_HEADERS
      )
      const res2 = await postWebhook(
        server,
        'teams',
        TEAMS_TARGET_ID,
        JSON.stringify(emptyTextActivity),
        TEAMS_HEADERS
      )

      expect(res1).toEqual({ status: 200, body: { ok: true } })
      expect(res2).toEqual({ status: 200, body: { ok: true } })
      await waitForCount(handoff.received, 2)

      expect(handoff.received[0]!.path).toBe('/internal/teams/handoff')
      expect(handoff.received[0]!.body).toEqual({
        kind: 'teams.attachment-message.v1',
        content: 'Please summarize this report',
        providerUserId: 'teams-user-1',
        providerWorkspaceId: 'tenant-1',
        providerChannelId: 'a:personal-chat-1',
        providerConversationId: 'a:personal-chat-1',
        providerThreadRootId: 'teams-s13-act-1',
        providerReplyToMessageId: 'teams-s13-act-1',
        providerChannelType: 'personal',
        providerEventId: 'teams:tenant-1:a:personal-chat-1:teams-s13-act-1',
        providerMessageId: 'teams-s13-act-1',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        attachments: [
          {
            providerAttachmentId: 'unique-file-1',
            filename: 'report.pdf',
            declaredMediaType: 'application/pdf',
            reportedSizeBytes: null,
            downloadRef: {
              provider: 'teams',
              mode: 'file_download_info',
              downloadUrl: 'https://tenant.sharepoint.com/_layouts/15/download.aspx?UniqueId=u1',
              uniqueId: 'unique-file-1',
            },
          },
          {
            providerAttachmentId: 'teams:teams-s13-act-1:1',
            filename: 'archive.custombin',
            declaredMediaType: null,
            reportedSizeBytes: null,
            downloadRef: {
              provider: 'teams',
              mode: 'file_download_info',
              downloadUrl: 'https://tenant.sharepoint.com/_layouts/15/download.aspx?UniqueId=u2',
              uniqueId: null,
            },
          },
        ],
        providerTarget: {
          hostRef: 'host-1',
          communicationChannelNamespace: 'channels',
          communicationChannelName: 'teams-bot',
        },
      })

      expect(handoff.received[1]!.body).toMatchObject({
        kind: 'teams.attachment-message.v1',
        content: '',
        providerMessageId: 'teams-s13-act-2',
        providerThreadRootId: 'teams-s13-act-2',
        attachments: [expect.objectContaining({ providerAttachmentId: 'unique-file-1' })],
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await handoff.close()
    }
  })

  it('extracts_teams_inline_image_and_ignores_text_html', () => {
    const command = normalizeTeamsMessage({
      type: 'message',
      id: 'teams-s14-act-1',
      text: '',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'teams-user-1' },
      conversation: {
        id: 'a:personal-chat-1',
        conversationType: 'personal',
        tenantId: 'tenant-1',
      },
      channelData: { tenant: { id: 'tenant-1' } },
      attachments: [
        {
          contentType: 'text/html',
          content:
            '<p><img src="https://smba.trafficmanager.net/amer/v3/attachments/1/views/original"></p>',
        },
        {
          contentType: 'image/png',
          contentUrl: 'https://smba.trafficmanager.net/amer/v3/attachments/1/views/original',
        },
        {
          contentType: 'application/octet-stream',
          name: 'dump.bin',
          contentUrl: 'https://smba.trafficmanager.net/amer/v3/attachments/2/views/original',
        },
      ],
    })

    expect(command).not.toBeNull()
    expect(command?.content).toBe('')
    expect(command?.attachmentErrors).toBeUndefined()
    expect(command?.attachments).toEqual([
      {
        providerAttachmentId: 'teams:teams-s14-act-1:1',
        filename: null,
        declaredMediaType: 'image/png',
        reportedSizeBytes: null,
        downloadRef: {
          provider: 'teams',
          mode: 'inline_content',
          contentUrl: 'https://smba.trafficmanager.net/amer/v3/attachments/1/views/original',
          serviceUrl: 'https://smba.trafficmanager.net/amer/',
        },
      },
      {
        providerAttachmentId: 'teams:teams-s14-act-1:2',
        filename: 'dump.bin',
        declaredMediaType: 'application/octet-stream',
        reportedSizeBytes: null,
        downloadRef: {
          provider: 'teams',
          mode: 'inline_content',
          contentUrl: 'https://smba.trafficmanager.net/amer/v3/attachments/2/views/original',
          serviceUrl: 'https://smba.trafficmanager.net/amer/',
        },
      },
    ])

    // Text-only message with ONLY a text/html body clone produces no attachments and no errors.
    const htmlOnly = normalizeTeamsMessage({
      type: 'message',
      id: 'teams-s14-act-2',
      text: 'plain hello',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'teams-user-1' },
      conversation: {
        id: 'a:personal-chat-1',
        conversationType: 'personal',
        tenantId: 'tenant-1',
      },
      channelData: { tenant: { id: 'tenant-1' } },
      attachments: [{ contentType: 'text/html', content: '<p>plain hello</p>' }],
    })
    expect(htmlOnly?.content).toBe('plain hello')
    expect(htmlOnly?.attachments).toBeUndefined()
    expect(htmlOnly?.attachmentErrors).toBeUndefined()
  })

  it('reports_unsupported_teams_attachment_scope', async () => {
    resolveTeamsTarget.mockResolvedValue({
      ok: true,
      hostRef: 'host-1',
      communicationChannelRef: 'channels/teams-bot',
      providerWorkspaceId: 'tenant-1',
      replyOnlyWhenMentioned: true,
      appId: 'teams-app-1',
      appName: 'evenfire',
      tenantId: 'tenant-1',
      channelName: 'teams-bot',
      channelNamespace: 'channels',
    })

    const handoff = await startHandoffReceiver()
    const server = createServer(makeConfig(handoff.urlTemplate))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      const response = await postWebhook(
        server,
        'teams',
        TEAMS_TARGET_ID,
        JSON.stringify({
          type: 'message',
          id: 'teams-s16-act-1',
          text: '<at>evenfire</at> please review this channel file',
          serviceUrl: 'https://smba.trafficmanager.net/amer/',
          from: { id: 'teams-user-1' },
          conversation: {
            id: '19:abc@thread.tacv2;messageid=1001',
            conversationType: 'channel',
            tenantId: 'tenant-1',
          },
          channelData: {
            tenant: { id: 'tenant-1' },
            channel: { id: '19:abc@thread.tacv2' },
          },
          attachments: [
            {
              contentType: 'text/html',
              content: '<p><at>evenfire</at> please review this channel file</p>',
            },
            {
              contentType: 'application/vnd.microsoft.teams.file.download.info',
              name: 'channel-doc.pdf',
              content: { uniqueId: 'no-url-1' },
            },
            {
              contentType: 'application/vnd.microsoft.teams.card.file.info',
              name: 'channel-sheet.xlsx',
              content: {},
            },
          ],
        }),
        TEAMS_HEADERS
      )

      expect(response).toEqual({ status: 200, body: { ok: true } })
      await waitForCount(handoff.received, 1)
      expect(handoff.received[0]!.body).toMatchObject({
        kind: 'teams.attachment-message.v1',
        content: 'please review this channel file',
        providerThreadRootId: '1001',
        attachmentIngestErrors: [
          expect.objectContaining({
            filename: 'channel-doc.pdf',
            code: 'provider_scope_unsupported',
          }),
          expect.objectContaining({
            filename: 'channel-sheet.xlsx',
            code: 'provider_scope_unsupported',
          }),
        ],
      })
      expect(handoff.received[0]!.body.attachments).toBeUndefined()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await handoff.close()
    }
  })

  it('carries_teams_provider_thread_root_id_separately_from_reply_to_message_id', async () => {
    const handoff = await startHandoffReceiver()
    const server = createServer(makeConfig(handoff.urlTemplate))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      // Root post with ;messageid=1001
      await postWebhook(
        server,
        'teams',
        TEAMS_TARGET_ID,
        JSON.stringify({
          type: 'message',
          id: '1001',
          text: 'root post',
          serviceUrl: 'https://smba.trafficmanager.net/amer/',
          from: { id: 'teams-user-1' },
          conversation: {
            id: '19:abc@thread.tacv2;messageid=1001',
            conversationType: 'channel',
            tenantId: 'tenant-1',
          },
          channelData: {
            tenant: { id: 'tenant-1' },
            channel: { id: '19:abc@thread.tacv2' },
          },
        }),
        TEAMS_HEADERS
      )

      // Reply carrying body.replyToId='1002' and channelData.messageId='1003'
      await postWebhook(
        server,
        'teams',
        TEAMS_TARGET_ID,
        JSON.stringify({
          type: 'message',
          id: '1003',
          replyToId: '1002',
          text: 'summarize it',
          serviceUrl: 'https://smba.trafficmanager.net/amer/',
          from: { id: 'teams-user-1' },
          conversation: {
            id: '19:abc@thread.tacv2;messageid=1001',
            conversationType: 'channel',
            tenantId: 'tenant-1',
          },
          channelData: {
            tenant: { id: 'tenant-1' },
            channel: { id: '19:abc@thread.tacv2' },
            messageId: '1003',
          },
        }),
        TEAMS_HEADERS
      )

      await waitForCount(handoff.received, 2)
      expect(handoff.received[0]!.body).toMatchObject({
        kind: 'teams.message',
        providerThreadRootId: '1001',
        providerReplyToMessageId: '1001',
        providerMessageId: '1001',
      })
      expect(handoff.received[1]!.body).toMatchObject({
        kind: 'teams.message',
        providerThreadRootId: '1001',
        providerReplyToMessageId: '1002',
        providerMessageId: '1003',
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await handoff.close()
    }
  })

  it('uses_versioned_v1_handoff_discriminants_and_fails_closed_on_skew', async () => {
    // Simulate an older channel-reader pod that ONLY accepts legacy 'slack.message'
    // and 'teams.message', rejecting v1 attachment discriminants with 400.
    const oldChannelReader = await startHandoffReceiver((_path, body) => {
      if (body.kind === 'slack.message' || body.kind === 'teams.message') {
        return { status: 200, body: { ok: true } }
      }
      return { status: 400, body: { ok: false, error: 'unsupported_handoff_version' } }
    })

    const cfg = makeConfig(oldChannelReader.urlTemplate)
    const slackTarget: SlackTargetHandoffContext = {
      targetId: SLACK_TARGET_ID,
      hostRef: 'host-1',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: false,
      replyOnlyWhenMentioned: false,
    }
    const teamsTarget: TeamsTargetHandoffContext = {
      targetId: TEAMS_TARGET_ID,
      hostRef: 'host-1',
      communicationChannelRef: 'channels/teams-bot',
      providerWorkspaceId: 'tenant-1',
      replyOnlyWhenMentioned: false,
    }

    try {
      const slackTextCmd = normalizeSlackMessage({
        type: 'event_callback',
        team_id: 'T123',
        event_id: 'Ev-s69-slack-text',
        event: {
          type: 'message',
          user: 'U123',
          channel: 'C123',
          text: 'hello text only',
          ts: '1710000600.000001',
        },
      })!
      const slackAttachCmd = normalizeSlackMessage({
        type: 'event_callback',
        team_id: 'T123',
        event_id: 'Ev-s69-slack-attach',
        event: {
          type: 'message',
          subtype: 'file_share',
          user: 'U123',
          channel: 'C123',
          text: 'with file',
          ts: '1710000600.000002',
          files: [{ id: 'F_S69_1', name: 'doc.pdf', mimetype: 'application/pdf', size: 100 }],
        },
      })!
      const teamsTextCmd = normalizeTeamsMessage({
        type: 'message',
        id: 'teams-s69-text',
        text: 'hello teams text',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        from: { id: 'teams-user-1' },
        conversation: { id: 'a:personal-1', conversationType: 'personal', tenantId: 'tenant-1' },
        channelData: { tenant: { id: 'tenant-1' } },
      })!
      const teamsAttachCmd = normalizeTeamsMessage({
        type: 'message',
        id: 'teams-s69-attach',
        text: 'with file',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        from: { id: 'teams-user-1' },
        conversation: { id: 'a:personal-1', conversationType: 'personal', tenantId: 'tenant-1' },
        channelData: { tenant: { id: 'tenant-1' } },
        attachments: [
          {
            contentType: 'application/vnd.microsoft.teams.file.download.info',
            name: 'doc.pdf',
            content: {
              downloadUrl: 'https://tenant.sharepoint.com/_layouts/15/download.aspx?UniqueId=1',
              uniqueId: 'u-s69-1',
              fileType: 'pdf',
            },
          },
        ],
      })!

      const slackTextRes = await handoffSlackMessageToChannelReader(cfg, slackTarget, slackTextCmd)
      const slackAttachRes = await handoffSlackMessageToChannelReader(
        cfg,
        slackTarget,
        slackAttachCmd
      )
      const teamsTextRes = await handoffTeamsMessageToChannelReader(cfg, teamsTarget, teamsTextCmd)
      const teamsAttachRes = await handoffTeamsMessageToChannelReader(
        cfg,
        teamsTarget,
        teamsAttachCmd
      )

      // Legacy text-only succeeds 200; v1 attachment handoffs fail closed 400 (no silent downgrade)
      expect(slackTextRes).toEqual({ ok: true })
      expect(slackAttachRes).toEqual({
        ok: false,
        status: 400,
        error: 'unsupported_handoff_version',
      })
      expect(teamsTextRes).toEqual({ ok: true })
      expect(teamsAttachRes).toEqual({
        ok: false,
        status: 400,
        error: 'unsupported_handoff_version',
      })
      expect(oldChannelReader.received.map(r => r.body.kind)).toEqual([
        'slack.message',
        'slack.attachment-message.v1',
        'teams.message',
        'teams.attachment-message.v1',
      ])
    } finally {
      await oldChannelReader.close()
    }
  })

  it('emits_slack_event_type_in_normalization_and_handoff_T_BR02_a', async () => {
    const handoff = await startHandoffReceiver()
    const cfg = makeConfig(handoff.urlTemplate)
    const slackTarget: SlackTargetHandoffContext = {
      targetId: SLACK_TARGET_ID,
      hostRef: 'host-1',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: false,
      replyOnlyWhenMentioned: true,
    }

    try {
      const plainMessageCmd = normalizeSlackMessage({
        type: 'event_callback',
        team_id: 'T123',
        event_id: 'Ev-br02-msg-1',
        event: {
          type: 'message',
          user: 'U123',
          channel: 'C123',
          text: 'plain text message',
          ts: '1710000700.000001',
        },
      })
      const appMentionCmd = normalizeSlackMessage({
        type: 'event_callback',
        team_id: 'T123',
        event_id: 'Ev-br02-mention-1',
        authorizations: [{ team_id: 'T123', user_id: 'UBOTID' }],
        event: {
          type: 'app_mention',
          user: 'U123',
          channel: 'C123',
          text: '<@UBOTID> check this',
          ts: '1710000700.000002',
        },
      })
      const blockActionCmd = normalizeSlackMessage({
        type: 'block_actions',
        trigger_id: 'trigger-br02-1',
        user: { id: 'U123' },
        team: { id: 'T123' },
        channel: { id: 'C123' },
        message: { ts: '1710000700.000003' },
        actions: [{ value: 'tool:a:aaaaaaaaaaaaaaaa' }],
      })

      expect(plainMessageCmd?.slackEventType).toBe('message')
      expect(appMentionCmd?.slackEventType).toBe('app_mention')
      expect(blockActionCmd?.slackEventType).toBeUndefined()

      expect(await handoffSlackMessageToChannelReader(cfg, slackTarget, plainMessageCmd!)).toEqual({
        ok: true,
      })
      expect(await handoffSlackMessageToChannelReader(cfg, slackTarget, appMentionCmd!)).toEqual({
        ok: true,
      })
      expect(await handoffSlackMessageToChannelReader(cfg, slackTarget, blockActionCmd!)).toEqual({
        ok: true,
      })

      expect(handoff.received).toHaveLength(3)
      expect(handoff.received[0]!.body).toMatchObject({
        kind: 'slack.message',
        content: 'plain text message',
        eventKind: 'event_callback',
        slackEventType: 'message',
      })
      expect(handoff.received[1]!.body).toMatchObject({
        kind: 'slack.message',
        content: 'check this',
        eventKind: 'event_callback',
        slackEventType: 'app_mention',
      })
      expect(handoff.received[2]!.body).toMatchObject({
        kind: 'slack.message',
        eventKind: 'block_actions',
      })
      expect('slackEventType' in handoff.received[2]!.body).toBe(false)
    } finally {
      await handoff.close()
    }
  })

  it('forwards_mention_only_app_mention_and_ignores_unhandled_slack_event_callbacks_T_BR14_a', async () => {
    verifySlackTargetSignature.mockResolvedValue({
      ok: true,
      hostRef: 'host-1',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: false,
      replyOnlyWhenMentioned: true,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })

    // Direct unit check on normalizeSlackMessage:
    // - app_mention with only <@UBOTID> and no files returns content: '' + slackEventType: 'app_mention'
    // - message with empty text and 0 attachments still returns null
    const normalizedMentionOnly = normalizeSlackMessage(
      {
        type: 'event_callback',
        team_id: 'T123',
        event_id: 'Ev-br14-unit-mention',
        authorizations: [{ team_id: 'T123', user_id: 'UBOTID' }],
        event: {
          type: 'app_mention',
          user: 'U123',
          channel: 'C123',
          text: '<@UBOTID>',
          ts: '1710000800.000001',
        },
      },
      { stripLeadingMention: true, stripBotUserId: 'UBOTID' }
    )
    expect(normalizedMentionOnly).toMatchObject({
      content: '',
      eventKind: 'event_callback',
      slackEventType: 'app_mention',
    })
    const normalizedEmptyMessage = normalizeSlackMessage({
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev-br14-unit-empty-msg',
      event: {
        type: 'message',
        user: 'U123',
        channel: 'C123',
        text: '',
        ts: '1710000800.000002',
      },
    })
    expect(normalizedEmptyMessage).toBeNull()

    const handoff = await startHandoffReceiver()
    const mcpHost = await startHandoffReceiver()
    const server = createServer(makeConfig(handoff.urlTemplate, mcpHost.urlTemplate))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      // 1) app_mention with mention-only text and no files -> HTTP 200 and hands off empty content + slackEventType='app_mention'
      const mentionOnlyRes = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-br14-app-mention-only',
          authorizations: [{ team_id: 'T123', user_id: 'UBOTID' }],
          event: {
            type: 'app_mention',
            user: 'U123',
            channel: 'C123',
            text: '<@UBOTID>',
            ts: '1710000800.000010',
          },
        }),
        SLACK_HEADERS
      )
      expect(mentionOnlyRes).toEqual({ status: 200, body: { ok: true } })

      // 2) Ignored Slack event_callback (message_changed) -> HTTP 200 { ok: true, ignored: true } (never 400)
      const messageChangedRes = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-br14-msg-changed',
          event: {
            type: 'message',
            subtype: 'message_changed',
            channel: 'C123',
            ts: '1710000800.000011',
          },
        }),
        SLACK_HEADERS
      )
      expect(messageChangedRes).toEqual({ status: 200, body: { ok: true, ignored: true } })

      // 3) Ignored Slack event_callback (empty-text message without files) -> HTTP 200 { ok: true, ignored: true } (never 400)
      const emptyMsgRes = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-br14-empty-msg',
          event: {
            type: 'message',
            user: 'U123',
            channel: 'C123',
            text: '',
            ts: '1710000800.000012',
          },
        }),
        SLACK_HEADERS
      )
      expect(emptyMsgRes).toEqual({ status: 200, body: { ok: true, ignored: true } })

      // 4) Liveness witness: url_verification still returns challenge
      const challengeRes = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'url_verification',
          challenge: 'br14-challenge-token',
        }),
        SLACK_HEADERS
      )
      expect(challengeRes).toEqual({ status: 200, body: { challenge: 'br14-challenge-token' } })

      // 5) Liveness witness: Slack block_actions approval decision still routes to decision handler (not intercepted as ignored)
      const blockActionDecisionRes = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'block_actions',
          trigger_id: 'trigger-br14-decision',
          user: { id: 'U123' },
          team: { id: 'T123' },
          channel: { id: 'C123' },
          message: { ts: '1710000800.000013' },
          actions: [{ value: 'approve:00000000-0000-4000-8000-000000000001' }],
        }),
        SLACK_HEADERS
      )
      expect(blockActionDecisionRes).toEqual({ status: 200, body: { ok: true } })

      await waitForCount(handoff.received, 1)
      await waitForCount(mcpHost.received, 1)

      expect(handoff.received).toHaveLength(1)
      expect(handoff.received[0]!.body).toMatchObject({
        kind: 'slack.message',
        content: '',
        eventKind: 'event_callback',
        slackEventType: 'app_mention',
        providerChannelId: 'C123',
        providerMessageTs: '1710000800.000010',
      })
      expect(mcpHost.received).toHaveLength(1)
      expect(mcpHost.received[0]!.path).toBe('/v1/runtime/workflow-approvals/decide')
      expect(mcpHost.received[0]!.body).toMatchObject({
        approvalRequestId: '00000000-0000-4000-8000-000000000001',
        decision: 'approve',
        providerIdentity: expect.objectContaining({
          medium: 'slack',
          providerUserId: 'U123',
        }),
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await handoff.close()
      await mcpHost.close()
    }
  })

  it('notifies_user_on_unsupported_handoff_kind_during_rolling_upgrade_T_BR17_a', async () => {
    verifySlackTargetSignature.mockResolvedValue({
      ok: true,
      hostRef: 'host-1',
      communicationChannelRef: 'channels/slack-app',
      providerWorkspaceId: 'T123',
      replyInThreads: true,
      replyOnlyWhenMentioned: false,
      channelName: 'slack-app',
      channelNamespace: 'channels',
    })

    let handoffReply: { status: number; body: unknown } = {
      status: 400,
      body: { ok: false, error: 'unsupported_handoff_kind' },
    }
    const handoff = await startHandoffReceiver(() => handoffReply)
    const server = createServer(makeConfig(handoff.urlTemplate))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    const expectedNotice =
      'File attachments are temporarily unavailable while the assistant service is upgrading. Please resend your message in a moment.'

    try {
      // 1) Slack attachment handoff receiving HTTP 400 unsupported_handoff_kind -> sends Slack upgrade notice
      const slack400Res = await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-br17-slack-400',
          event: {
            type: 'message',
            subtype: 'file_share',
            user: 'U123',
            channel: 'C123',
            text: 'please check',
            ts: '1710000900.000002',
            thread_ts: '1710000900.000001',
            files: [{ id: 'F_BR17_1', name: 'doc.pdf', mimetype: 'application/pdf', size: 100 }],
          },
        }),
        SLACK_HEADERS
      )
      expect(slack400Res).toEqual({ status: 200, body: { ok: true } })

      // 2) Teams attachment handoff receiving HTTP 400 unsupported_handoff_kind -> sends Teams upgrade notice
      const teams400Res = await postWebhook(
        server,
        'teams',
        TEAMS_TARGET_ID,
        JSON.stringify({
          type: 'message',
          id: 'teams-br17-act-400',
          replyToId: 'teams-br17-reply-to',
          text: 'please check',
          serviceUrl: 'https://smba.trafficmanager.net/amer/',
          from: { id: 'teams-user-1' },
          conversation: {
            id: '19:abc@thread.tacv2;messageid=9001',
            conversationType: 'channel',
            tenantId: 'tenant-1',
          },
          channelData: {
            tenant: { id: 'tenant-1' },
            channel: { id: '19:abc@thread.tacv2' },
          },
          attachments: [
            {
              contentType: 'application/vnd.microsoft.teams.file.download.info',
              name: 'doc.pdf',
              content: {
                downloadUrl: 'https://tenant.sharepoint.com/_layouts/15/download.aspx?UniqueId=b17',
                uniqueId: 'u-br17-1',
                fileType: 'pdf',
              },
            },
          ],
        }),
        TEAMS_HEADERS
      )
      expect(teams400Res).toEqual({ status: 200, body: { ok: true } })

      await waitForCount(handoff.received, 2)
      await vi.waitFor(() => {
        expect(sendSlackTargetMessage).toHaveBeenCalledTimes(1)
        expect(sendTeamsTargetMessage).toHaveBeenCalledTimes(1)
      })
      expect(sendSlackTargetMessage).toHaveBeenCalledWith(expect.any(Object), {
        targetId: SLACK_TARGET_ID,
        channelId: 'C123',
        text: `<@U123> ${expectedNotice}`,
        threadTs: '1710000900.000001',
      })
      expect(sendTeamsTargetMessage).toHaveBeenCalledWith(expect.any(Object), {
        targetId: TEAMS_TARGET_ID,
        conversationId: '19:abc@thread.tacv2',
        threadConversationId: '19:abc@thread.tacv2;messageid=9001',
        replyToId: 'teams-br17-reply-to',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        text: expectedNotice,
      })

      // 3) Negative assertions with liveness witnesses: HTTP 504 and HTTP 200 do NOT send upgrade notices
      sendSlackTargetMessage.mockClear()
      sendTeamsTargetMessage.mockClear()

      handoffReply = { status: 504, body: { ok: false, error: 'gateway_timeout' } }
      await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-br17-slack-504',
          event: {
            type: 'message',
            subtype: 'file_share',
            user: 'U123',
            channel: 'C123',
            text: 'timeout test',
            ts: '1710000900.000003',
            files: [{ id: 'F_BR17_2', name: 'doc2.pdf', mimetype: 'application/pdf', size: 100 }],
          },
        }),
        SLACK_HEADERS
      )
      await postWebhook(
        server,
        'teams',
        TEAMS_TARGET_ID,
        JSON.stringify({
          type: 'message',
          id: 'teams-br17-act-504',
          text: 'timeout test',
          serviceUrl: 'https://smba.trafficmanager.net/amer/',
          from: { id: 'teams-user-1' },
          conversation: {
            id: 'a:personal-chat-br17',
            conversationType: 'personal',
            tenantId: 'tenant-1',
          },
          channelData: { tenant: { id: 'tenant-1' } },
          attachments: [
            {
              contentType: 'application/vnd.microsoft.teams.file.download.info',
              name: 'doc2.pdf',
              content: {
                downloadUrl: 'https://tenant.sharepoint.com/_layouts/15/download.aspx?UniqueId=b18',
                uniqueId: 'u-br17-2',
                fileType: 'pdf',
              },
            },
          ],
        }),
        TEAMS_HEADERS
      )

      await waitForCount(handoff.received, 4)

      handoffReply = { status: 200, body: { ok: true } }
      await postWebhook(
        server,
        'slack',
        SLACK_TARGET_ID,
        JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event_id: 'Ev-br17-slack-200',
          event: {
            type: 'message',
            subtype: 'file_share',
            user: 'U123',
            channel: 'C123',
            text: 'ok test',
            ts: '1710000900.000004',
            files: [{ id: 'F_BR17_3', name: 'doc3.pdf', mimetype: 'application/pdf', size: 100 }],
          },
        }),
        SLACK_HEADERS
      )
      await postWebhook(
        server,
        'teams',
        TEAMS_TARGET_ID,
        JSON.stringify({
          type: 'message',
          id: 'teams-br17-act-200',
          text: 'ok test',
          serviceUrl: 'https://smba.trafficmanager.net/amer/',
          from: { id: 'teams-user-1' },
          conversation: {
            id: 'a:personal-chat-br17',
            conversationType: 'personal',
            tenantId: 'tenant-1',
          },
          channelData: { tenant: { id: 'tenant-1' } },
          attachments: [
            {
              contentType: 'application/vnd.microsoft.teams.file.download.info',
              name: 'doc3.pdf',
              content: {
                downloadUrl: 'https://tenant.sharepoint.com/_layouts/15/download.aspx?UniqueId=b19',
                uniqueId: 'u-br17-3',
                fileType: 'pdf',
              },
            },
          ],
        }),
        TEAMS_HEADERS
      )

      // Liveness witness: all 6 handoff POSTs reached channel-reader (2 x 400, 2 x 504, 2 x 200)
      await waitForCount(handoff.received, 6)
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(handoff.received).toHaveLength(6)
      expect(sendSlackTargetMessage).not.toHaveBeenCalled()
      expect(sendTeamsTargetMessage).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await handoff.close()
    }
  })
})
