import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlackAdapter } from '../channels/slack'
import type { SlackMessageHandoff } from '../handoffServer'
import { ChannelReader, type ChannelReaderOptions } from '../main'
import { createProgressStream } from '../progressClient'
import { RPCClient } from '../rpcClient'
import type { ChannelAdapter, Message, ProviderAttachmentDescriptorV1 } from '../types'

const streamControl = vi.hoisted(() => ({
  calls: [] as Array<{
    taskId: string
    close: ReturnType<typeof vi.fn>
    onSuspended: (data: {
      taskId: string
      requestId: string
      toolName: string
      displayName: string
      reason: string
    }) => Promise<void> | void
  }>,
}))

vi.mock('../progressClient', () => ({
  createProgressStream: vi.fn(
    (options: {
      taskId: string
      onSuspended: (data: {
        taskId: string
        requestId: string
        toolName: string
        displayName: string
        reason: string
      }) => Promise<void> | void
    }) => {
      const close = vi.fn()
      streamControl.calls.push({
        taskId: options.taskId,
        close,
        onSuspended: options.onSuspended,
      })
      return {
        close,
        get steps() {
          return []
        },
      }
    }
  ),
}))

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return {
      auth: {
        test: vi.fn().mockResolvedValue({ user: 'bot', user_id: 'U_BOT', team_id: 'T1', ok: true }),
      },
      conversations: { history: vi.fn(), replies: vi.fn(), info: vi.fn(), list: vi.fn() },
      users: { info: vi.fn() },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1700.1', ok: true }),
        update: vi.fn().mockResolvedValue({ ok: true }),
        postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      },
      files: { info: vi.fn(), uploadV2: vi.fn() },
    }
  }),
}))

vi.hoisted(() => {
  process.env.CLERUM_HOST_REF = process.env.CLERUM_HOST_REF ?? 'test-host'
})

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

function makeStubAdapter(
  channelType: 'telegram' | 'slack' | 'teams',
  overrides: Partial<ChannelAdapter> = {}
): ChannelAdapter {
  return {
    channelType,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    fetchMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => 'status-msg-1'),
    editMessage: vi.fn(async () => undefined),
    sendEphemeral: vi.fn(async () => undefined),
    downloadAttachment: vi.fn(async d => ({
      ok: true as const,
      bytes: Buffer.from(`bytes-${d.providerAttachmentId}`),
      filename: d.filename,
      declaredMediaType: d.declaredMediaType,
    })),
    ...overrides,
  }
}

function sampleDescriptor(id = 'att-1'): ProviderAttachmentDescriptorV1 {
  return {
    providerAttachmentId: id,
    filename: `${id}.pdf`,
    declaredMediaType: 'application/pdf',
    reportedSizeBytes: 16,
    downloadRef: {
      provider: 'slack',
      fileId: id,
      urlPrivateDownload: `https://files.slack.com/files-pri/T1-${id}/${id}.pdf`,
    },
  }
}

afterEach(() => {
  streamControl.calls.length = 0
  vi.mocked(createProgressStream).mockClear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ChannelReader inbound concurrency, auth ordering, retries & revocation (X5)', () => {
  it('S17 · authorizes_before_any_provider_download', async () => {
    const adapter = makeStubAdapter('slack')
    const rpc = makeRpc({
      authorizeProviderMessage: vi
        .fn()
        .mockResolvedValueOnce({ authorized: false, reason: 'unresolved' })
        .mockResolvedValueOnce({ authorized: true }),
    })
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['slack', adapter]]),
    })

    const baseMsg = (sender: string, eventId: string): Message => ({
      channelType: 'slack',
      channelId: 'C1',
      sender,
      content: 'read this',
      timestamp: new Date(),
      messageId: eventId,
      attachments: [sampleDescriptor('F1')],
      providerIdentity: {
        medium: 'slack',
        providerUserId: sender,
        providerWorkspaceId: 'T1',
        providerChannelId: 'C1',
        providerEventId: `slack:T1:C1:${eventId}`,
      },
    })

    // Unlinked sender -> 0 downloads, 0 ingests, unresolved notice sent
    await reader.handleMessages([baseMsg('U_UNLINKED', 'm1')])
    expect(rpc.authorizeProviderMessage).toHaveBeenCalledTimes(1)
    expect(adapter.downloadAttachment).not.toHaveBeenCalled()
    expect(rpc.ingestChannelAttachment).not.toHaveBeenCalled()
    expect(adapter.sendEphemeral).toHaveBeenCalledTimes(1)

    // Liveness witness: authorized sender completes download + ingest + dispatch
    await reader.handleMessages([baseMsg('U_LINKED', 'm2')])
    expect(adapter.downloadAttachment).toHaveBeenCalledTimes(1)
    expect(rpc.ingestChannelAttachment).toHaveBeenCalledTimes(1)
    expect(rpc.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('S18 · dedupes_concurrent_webhook_retry_across_authorize_await', async () => {
    const adapter = makeStubAdapter('slack')
    let releaseAuth!: () => void
    const authGate = new Promise<void>(resolve => {
      releaseAuth = resolve
    })

    const rpc = makeRpc({
      authorizeProviderMessage: vi.fn(async () => {
        await authGate
        return { authorized: true }
      }),
    })
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['slack', adapter]]),
    })

    const msg: Message = {
      channelType: 'slack',
      channelId: 'C1',
      sender: 'U1',
      content: 'hi',
      timestamp: new Date(),
      messageId: '1700.1',
      slackEventKind: 'event_callback',
      attachments: [sampleDescriptor('F1')],
      providerIdentity: {
        medium: 'slack',
        providerUserId: 'U1',
        providerWorkspaceId: 'T1',
        providerChannelId: 'C1',
        providerEventId: 'slack:T1:C1:Ev1',
      },
    }

    // Two concurrent handleMessages calls overlap while authorizeProviderMessage is suspended
    const p1 = reader.handleMessages([msg])
    const p2 = reader.handleMessages([msg])

    releaseAuth()
    await Promise.all([p1, p2])

    expect(rpc.authorizeProviderMessage).toHaveBeenCalledTimes(1)
    expect(adapter.downloadAttachment).toHaveBeenCalledTimes(1)
    expect(rpc.ingestChannelAttachment).toHaveBeenCalledTimes(1)
    expect(rpc.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('S19 · serializes_attachment_then_followup_per_conversation_fifo', async () => {
    const callOrder: string[] = []
    let releaseDownload!: () => void
    const downloadGate = new Promise<void>(resolve => {
      releaseDownload = resolve
    })

    const adapter = makeStubAdapter('slack', {
      downloadAttachment: vi.fn(async d => {
        await downloadGate
        return {
          ok: true as const,
          bytes: Buffer.from('pdf-bytes'),
          filename: d.filename,
          declaredMediaType: d.declaredMediaType,
        }
      }),
    })
    const rpc = makeRpc({
      ingestChannelAttachment: vi.fn(async meta => {
        callOrder.push(`ingest:${meta.messageId}`)
        return {
          ok: true as const,
          attachmentId: 'att-1',
          fileReference: { name: 'doc.pdf' },
          expiresAt: '2026-12-01T00:00:00.000Z',
        }
      }),
      sendMessage: vi.fn(async msg => {
        callOrder.push(`message:${msg.messageId}`)
        return { success: true, status: 'completed' as const, response: 'ok' }
      }),
    })

    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['slack', adapter]]),
    })

    // Handoff 1 (slow PDF download) returns HTTP 200 immediately once enqueued
    const h1: SlackMessageHandoff = {
      kind: 'slack.attachment-message.v1',
      content: '',
      providerUserId: 'U1',
      providerWorkspaceId: 'T1',
      providerChannelId: 'C1',
      providerEventId: 'slack:T1:C1:Ev1',
      providerMessageTs: '1',
      eventKind: 'event_callback',
      attachments: [sampleDescriptor('F1')],
      providerTarget: PROVIDER_TARGET,
    }
    const h2: SlackMessageHandoff = {
      kind: 'slack.message',
      content: 'summarize it',
      providerUserId: 'U1',
      providerWorkspaceId: 'T1',
      providerChannelId: 'C1',
      providerEventId: 'slack:T1:C1:Ev2',
      providerMessageTs: '2',
      eventKind: 'event_callback',
      rawData: { eventType: 'message' },
      providerTarget: PROVIDER_TARGET,
    }

    expect(await reader.handleSlackHandoff(h1)).toEqual({ ok: true })
    expect(await reader.handleSlackHandoff(h2)).toEqual({ ok: true })

    releaseDownload()
    await reader.flushConversationQueues()

    expect(callOrder).toEqual(['ingest:1', 'message:1', 'message:2'])
  })

  it('S20 · survives_crd_restart_during_inflight_download', async () => {
    const adapter = new SlackAdapter(null)
    await adapter.connect({ slackBotToken: 'xoxb-initial-token' })

    let releaseFetch!: () => void
    const fetchGate = new Promise<void>(resolve => {
      releaseFetch = resolve
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        await fetchGate
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers.authorization).toBe('Bearer xoxb-initial-token')
        return new Response('downloaded-during-restart', { status: 200 })
      })
    )

    const downloadPromise = adapter.downloadAttachment(sampleDescriptor('F_RESTART'))

    // Simulate CRD restart tearing down the adapter while download is suspended at `await`
    await adapter.disconnect()

    releaseFetch()
    const result = await downloadPromise
    expect(result).toEqual({
      ok: true,
      bytes: Buffer.from('downloaded-during-restart'),
      filename: 'F_RESTART.pdf',
      declaredMediaType: 'application/pdf',
    })

    // Reconnecting adapter works cleanly with rotated token
    await adapter.connect({ slackBotToken: 'xoxb-rotated-token' })
  })

  it('S21 · retries_ingest_after_host_draining_503', async () => {
    const sleepCalls: number[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'host_draining', retryable: true }), { status: 503 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            attachmentId: 'att-after-drain',
            fileReference: { name: 'a.pdf' },
            expiresAt: '2026-12-01T00:00:00.000Z',
          }),
          { status: 200 }
        )
      )
    vi.stubGlobal('fetch', fetchMock)

    const client = new RPCClient('http://mcp-host.test', {
      sleep: async ms => {
        sleepCalls.push(ms)
      },
      drainRetryBaseDelayMs: 10,
      drainRetryMaxMs: 500,
    })

    const receipt = await client.ingestChannelAttachment(
      {
        channelType: 'slack',
        channelId: 'C1',
        sender: 'U1',
        messageId: '1700.1',
        providerIdentity: {
          medium: 'slack',
          providerUserId: 'U1',
          providerWorkspaceId: 'T1',
          providerChannelId: 'C1',
          providerEventId: 'slack:T1:C1:1700.1',
        },
        providerAttachmentId: 'F1',
        filename: 'a.pdf',
        declaredMediaType: 'application/pdf',
      },
      Buffer.from('%PDF-1.7')
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleepCalls).toEqual([10])
    expect(receipt).toMatchObject({ ok: true, attachmentId: 'att-after-drain' })
  })

  it('S33 · enforces_max_count_and_surfaces_partial_ingest_errors', async () => {
    const adapter = makeStubAdapter('slack', {
      downloadAttachment: vi.fn(async d => {
        if (d.providerAttachmentId === 'F4') {
          return {
            ok: false as const,
            code: 'provider_download_failed',
            message: 'Download timed out',
            retryable: true,
          }
        }
        return {
          ok: true as const,
          bytes: Buffer.from(`bytes-${d.providerAttachmentId}`),
          filename: d.filename,
          declaredMediaType: d.declaredMediaType,
        }
      }),
    })
    const rpc = makeRpc()
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['slack', adapter]]),
    })

    // Case A: > 10 attachments rejected explicitly with too_many_attachments (never silently truncated)
    const elevenDescriptors = Array.from({ length: 11 }, (_, i) => sampleDescriptor(`F${i + 1}`))
    await reader.handleMessages([
      {
        channelType: 'slack',
        channelId: 'C1',
        sender: 'U1',
        content: 'too many',
        timestamp: new Date(),
        messageId: 'm-11',
        attachments: elevenDescriptors,
        providerIdentity: {
          medium: 'slack',
          providerUserId: 'U1',
          providerWorkspaceId: 'T1',
          providerChannelId: 'C1',
          providerEventId: 'slack:T1:C1:m-11',
        },
      },
    ])
    expect(rpc.ingestChannelAttachment).not.toHaveBeenCalled()
    expect(rpc.sendMessage).not.toHaveBeenCalled()
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('too_many_attachments'),
      undefined,
      undefined,
      undefined
    )

    // Case B: 3 valid + 1 failed descriptor -> forwards 3 attachment IDs AND 1 typed error
    await reader.handleMessages([
      {
        channelType: 'slack',
        channelId: 'C1',
        sender: 'U1',
        content: 'partial batch',
        timestamp: new Date(),
        messageId: 'm-4',
        attachments: ['F1', 'F2', 'F3', 'F4'].map(id => sampleDescriptor(id)),
        providerIdentity: {
          medium: 'slack',
          providerUserId: 'U1',
          providerWorkspaceId: 'T1',
          providerChannelId: 'C1',
          providerEventId: 'slack:T1:C1:m-4',
        },
      },
    ])
    expect(rpc.ingestChannelAttachment).toHaveBeenCalledTimes(3)
    expect(rpc.sendMessage).toHaveBeenCalledTimes(1)
    const dispatched = (vi.mocked(rpc.sendMessage).mock.calls[0] as unknown as [Message])[0]
    expect(dispatched.channelAttachmentIds).toEqual(['att-F1', 'att-F2', 'att-F3'])
    expect(dispatched.attachmentIngestErrors).toEqual([
      { filename: 'F4.pdf', code: 'provider_download_failed', message: 'Download timed out' },
    ])
  })

  it('S65 · retries_sendMessage_after_host_draining_and_preserves_transient_auth_retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'host_draining' }), { status: 503 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'host_draining' }), { status: 503 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            status: 'completed',
            response: 'delivered on attempt 3',
          }),
          { status: 200 }
        )
      )
    vi.stubGlobal('fetch', fetchMock)

    const client = new RPCClient('http://mcp-host.test', {
      sleep: async () => undefined,
      drainRetryBaseDelayMs: 5,
      drainRetryMaxMs: 500,
    })

    const msg: Message = {
      channelType: 'slack',
      channelId: 'C1',
      sender: 'U1',
      content: 'after ingest',
      timestamp: new Date(),
      messageId: 'm-drain',
      channelAttachmentIds: ['att-1'],
      providerIdentity: {
        medium: 'slack',
        providerUserId: 'U1',
        providerWorkspaceId: 'T1',
        providerChannelId: 'C1',
        providerEventId: 'slack:T1:C1:m-drain',
      },
    }

    const res = await client.sendMessage(msg)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(res).toMatchObject({ success: true, response: 'delivered on attempt 3' })

    // Exhausted 503 host_draining delivers user-visible error AND does NOT permanently cache dedupe
    const adapter = makeStubAdapter('slack')
    const rpc = makeRpc({
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({
          success: false,
          error: {
            code: 'host_draining',
            message: 'Host is restarting',
            retryable: true,
            provider: 'mcp-host',
          },
        })
        .mockResolvedValueOnce({
          success: true,
          status: 'completed' as const,
          response: 'recovered!',
        }),
    })
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['slack', adapter]]),
    })

    await reader.handleMessages([msg])
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('Host is restarting'),
      undefined,
      undefined,
      undefined
    )

    // Replay of the exact same event succeeds because retryable failure was not cached in processedProviderEvents
    await reader.handleMessages([msg])
    expect(rpc.sendMessage).toHaveBeenCalledTimes(2)
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      'C1',
      'recovered!',
      undefined,
      undefined,
      undefined
    )
  })

  it('S69 · fails_closed_on_404_ingest_during_rolling_upgrade', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 }))
    )

    const client = new RPCClient('http://mcp-host.test', { sleep: async () => undefined })
    const sendMessageSpy = vi.spyOn(client, 'sendMessage')
    vi.spyOn(client, 'authorizeProviderMessage').mockResolvedValue({ authorized: true })

    const adapter = makeStubAdapter('slack')
    const reader = new ChannelReader({
      rpcClient: client,
      notificationDeliveryClient: null,
      adapters: new Map([['slack', adapter]]),
    })

    await reader.handleMessages([
      {
        channelType: 'slack',
        channelId: 'C1',
        sender: 'U1',
        content: 'caption that must NOT be sent without files',
        timestamp: new Date(),
        messageId: 'm-upgrade',
        attachments: [sampleDescriptor('F1')],
        providerIdentity: {
          medium: 'slack',
          providerUserId: 'U1',
          providerWorkspaceId: 'T1',
          providerChannelId: 'C1',
          providerEventId: 'slack:T1:C1:m-upgrade',
        },
      },
    ])

    // ZERO /v1/runtime/messages calls; 1 explicit upgrade-in-progress notice delivered to user
    expect(sendMessageSpy).not.toHaveBeenCalled()
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1)
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('host_attachment_ingest_unsupported'),
      undefined,
      undefined,
      undefined
    )
  })

  it('S81 · returns_error_reason_on_authorize_http_5xx_and_allows_retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }))
      .mockRejectedValueOnce(new Error('read ECONNRESET'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authorized: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorized: false, reason: 'unresolved' }), { status: 200 })
      )
    vi.stubGlobal('fetch', fetchMock)

    const client = new RPCClient('http://mcp-host.test', { sleep: async () => undefined })
    const identity = {
      medium: 'slack' as const,
      providerUserId: 'U1',
      providerWorkspaceId: 'T1',
      providerChannelId: 'C1',
      providerEventId: 'slack:T1:C1:Ev503',
    }

    // Case A (HTTP 503) & Case B (ECONNRESET) both return explicit reason: 'error'
    expect(await client.authorizeProviderMessage(identity)).toEqual({
      authorized: false,
      reason: 'error',
    })
    expect(await client.authorizeProviderMessage(identity)).toEqual({
      authorized: false,
      reason: 'error',
    })

    // Full ChannelReader retry check: transient error does NOT cache processedProviderEvents,
    // so redelivery succeeds end-to-end; unresolved DOES cache processedProviderEvents.
    const adapter = makeStubAdapter('slack')
    const rpc = makeRpc({
      authorizeProviderMessage: vi
        .fn()
        .mockResolvedValueOnce({ authorized: false, reason: 'error' })
        .mockResolvedValueOnce({ authorized: true })
        .mockResolvedValueOnce({ authorized: false, reason: 'unresolved' }),
    })
    const reader = new ChannelReader({
      rpcClient: rpc,
      notificationDeliveryClient: null,
      adapters: new Map([['slack', adapter]]),
    })

    const msg: Message = {
      channelType: 'slack',
      channelId: 'C1',
      sender: 'U1',
      content: 'retry me',
      timestamp: new Date(),
      messageId: 'm-503',
      attachments: [sampleDescriptor('F1')],
      providerIdentity: identity,
    }

    await reader.handleMessages([msg])
    expect(rpc.ingestChannelAttachment).not.toHaveBeenCalled()
    expect(rpc.sendMessage).not.toHaveBeenCalled()

    // Redelivery succeeds after recovery
    await reader.handleMessages([msg])
    expect(rpc.ingestChannelAttachment).toHaveBeenCalledTimes(1)
    expect(rpc.sendMessage).toHaveBeenCalledTimes(1)

    // Unresolved event IS cached so duplicate redelivery does not re-authorize
    const unresolvedMsg: Message = {
      ...msg,
      messageId: 'm-unres',
      providerIdentity: { ...identity, providerEventId: 'slack:T1:C1:EvUnres' },
    }
    await reader.handleMessages([unresolvedMsg, unresolvedMsg])
    expect(rpc.authorizeProviderMessage).toHaveBeenCalledTimes(3)
  })

  it('S84 · aborts_onSuspended_without_fallback_prompt_when_task_result_revoked', async () => {
    const runCase = async (
      taskId: string,
      taskResult: Awaited<
        ReturnType<NonNullable<ChannelReaderOptions['rpcClient']>['getTaskResult']>
      >
    ) => {
      streamControl.calls.length = 0
      const adapter = makeStubAdapter('telegram')
      const rpc = makeRpc({
        sendMessage: vi.fn(async () => ({
          success: true,
          status: 'pending' as const,
          taskId,
        })),
        getTaskResult: vi.fn(async () => taskResult),
      })
      const reader = new ChannelReader({
        rpcClient: rpc,
        notificationDeliveryClient: null,
        adapters: new Map([['telegram', adapter]]),
      })

      await reader.handleMessages([
        {
          channelType: 'telegram',
          channelId: '111222',
          sender: '123456',
          content: 'save file',
          timestamp: new Date(),
          messageId: `msg-${taskId}`,
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerWorkspaceId: null,
            providerChannelId: '111222',
            providerEventId: `telegram:111222:${taskId}`,
          },
        },
      ])

      const stream = streamControl.calls[0]!
      await stream.onSuspended({
        taskId,
        requestId: `req-${taskId}`,
        toolName: 'clerum__gfs_save_attachment',
        displayName: 'Save Attachment',
        reason: 'approval_required',
      })

      const pendingApprovals = (reader as unknown as { pendingApprovals: Map<string, unknown> })
        .pendingApprovals

      return {
        editCalls: vi.mocked(adapter.editMessage).mock.calls,
        pendingSize: pendingApprovals.size,
        streamClosed: stream.close.mock.calls.length,
      }
    }

    // Case A: approval_identity_revoked -> aborts, closes stream, 0 prompt edits, 0 pendingApprovals
    const caseA = await runCase('t-revoked', {
      success: false,
      status: 'completed',
      error: {
        code: 'approval_identity_revoked',
        message: 'Revoked',
        retryable: false,
        provider: 'mcp-host',
      },
    })
    expect(caseA.editCalls).toHaveLength(0)
    expect(caseA.pendingSize).toBe(0)
    expect(caseA.streamClosed).toBe(1)

    // Case B: approval_identity_mismatch -> aborts, closes stream, 0 prompt edits, 0 pendingApprovals
    const caseB = await runCase('t-mismatch', {
      success: false,
      error: {
        code: 'approval_identity_mismatch',
        message: 'Mismatch',
        retryable: false,
        provider: 'mcp-host',
      },
    })
    expect(caseB.editCalls).toHaveLength(0)
    expect(caseB.pendingSize).toBe(0)
    expect(caseB.streamClosed).toBe(1)

    // Liveness witness (Case C): `{ success: true, status: 'pending' }` micro-race still delivers fallback prompt
    const caseC = await runCase('t-pending', {
      success: true,
      status: 'pending',
    })
    expect(caseC.editCalls).toHaveLength(1)
    expect(String(caseC.editCalls[0]?.[2])).toContain('clerum__gfs_save_attachment')
    expect(caseC.pendingSize).toBe(1)
    expect(caseC.streamClosed).toBe(0)
  })
})
