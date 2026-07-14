import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChannelAdapter, CommunicationChannelCRD, Message } from '../src/types'

/**
 * issue #581 — the progress-stream `onError` must NOT collapse
 * `task_not_found_or_expired` into "Lost connection". mcp-host is healthy; the
 * code means either the result already exists (TTL eviction / late reconnect →
 * deliver it) or the task is still queued (>180s → keep polling). Only a genuine
 * transport error keeps the "Lost connection" message.
 */

interface StreamCall {
  fireError: (error: string) => void
  fireTerminal: (data: import('../src/progressClient').TerminalEventData) => void
  closed: boolean
}

const streamCalls: StreamCall[] = []

vi.mock('../src/progressClient', () => ({
  createProgressStream: (options: import('../src/progressClient').ProgressStreamOptions) => {
    const entry: StreamCall = {
      fireError: options.onError,
      fireTerminal: options.onTerminal,
      closed: false,
    }
    streamCalls.push(entry)
    return {
      close: () => {
        entry.closed = true
      },
      get steps() {
        return []
      },
    }
  },
}))

let ChannelReader: typeof import('../src/main').ChannelReader

beforeAll(async () => {
  process.env.CLERUM_DEV_MODE = 'true'
  ;({ ChannelReader } = await import('../src/main'))
})

afterEach(() => {
  vi.useRealTimers()
  streamCalls.length = 0
})

function makeMessage(content: string, messageId = `msg-${content.replace(/\W+/g, '-')}`): Message {
  return {
    channelType: 'telegram',
    channelId: 'tg-chat-1',
    sender: '516801777',
    content,
    timestamp: new Date('2026-06-17T12:00:00.000Z'),
    messageId,
  }
}

function makeChannel(): CommunicationChannelCRD {
  return {
    name: 'chatllm-telegram',
    namespace: 'channels',
    spec: {
      hostRef: 'chatllm',
      telegram: [{ channelId: 'tg-chat-1', userIds: ['516801777'] }],
    },
  }
}

function makeAdapter(editedContents: string[]): ChannelAdapter {
  return {
    channelType: 'telegram',
    connect: vi.fn(),
    disconnect: vi.fn(),
    fetchMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => 'bot-msg-1'),
    editMessage: vi.fn(async (_channelId, _messageId, content) => {
      editedContents.push(content)
    }),
  }
}

function makeRpcClient() {
  return {
    healthCheck: vi.fn(async () => true),
    sendMessage: vi.fn(async () => ({
      success: true,
      status: 'pending' as const,
      taskId: 'task-tnf',
    })),
    getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
    getTaskResult: vi.fn(),
    sendApproval: vi.fn(),
    sendDenial: vi.fn(),
    sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
    getCronResults: vi.fn(async () => []),
    acknowledgeCronResult: vi.fn(),
  }
}

describe('issue #581 — task_not_found_or_expired reconciliation', () => {
  it('Path B: delivers the already-stored result instead of "Lost connection"', async () => {
    const editedContents: string[] = []
    const adapter = makeAdapter(editedContents)
    const rpcClient = makeRpcClient()
    const reader = new ChannelReader({
      rpcClient,
      adapters: new Map([['telegram', adapter]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    // The reporter was evicted (>5min) but the result is durably stored.
    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'completed' as const,
      response: 'Here is the answer that already existed.',
    })

    await reader.handleMessages([makeMessage('estás vivo?')])
    const stream = streamCalls[0]!
    await stream.fireError('task_not_found_or_expired')

    expect(editedContents.some(c => c.includes('Here is the answer that already existed.'))).toBe(
      true
    )
    expect(editedContents.some(c => c.includes('Lost connection'))).toBe(false)
    expect(stream.closed).toBe(true)
  })

  it('Path A: keeps polling (no "Lost connection") when the task is still processing', async () => {
    vi.useFakeTimers()
    const editedContents: string[] = []
    const adapter = makeAdapter(editedContents)
    const rpcClient = makeRpcClient()
    const reader = new ChannelReader({
      rpcClient,
      adapters: new Map([['telegram', adapter]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    // First reconcile: still pending (queue saturation). Then the fallback poll
    // finds the completed result.
    rpcClient.getTaskResult
      .mockResolvedValueOnce({ success: true, status: 'pending' as const })
      .mockResolvedValueOnce({
        success: true,
        status: 'completed' as const,
        response: 'Delivered by polling fallback.',
      })

    await reader.handleMessages([makeMessage('busca noticias')])
    const stream = streamCalls[0]!
    await stream.fireError('task_not_found_or_expired')
    await vi.advanceTimersByTimeAsync(20)

    expect(editedContents.some(c => c.includes('Still processing'))).toBe(true)
    expect(editedContents.some(c => c.includes('Lost connection'))).toBe(false)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(editedContents.some(c => c.includes('Delivered by polling fallback.'))).toBe(true)
    expect(stream.closed).toBe(true)
  })

  it('Path B throws → still falls through to polling (no "Lost connection")', async () => {
    vi.useFakeTimers()
    const editedContents: string[] = []
    const adapter = makeAdapter(editedContents)
    const rpcClient = makeRpcClient()
    const reader = new ChannelReader({
      rpcClient,
      adapters: new Map([['telegram', adapter]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    // The reconcile fetch rejects; the handler must not cry "Lost connection" —
    // it falls into Path A polling, which then finds the completed result.
    rpcClient.getTaskResult
      .mockRejectedValueOnce(new Error('transient fetch boom'))
      .mockResolvedValueOnce({
        success: true,
        status: 'completed' as const,
        response: 'Delivered after the reconcile fetch failed.',
      })

    await reader.handleMessages([makeMessage('dame un resumen')])
    const stream = streamCalls[0]!
    await stream.fireError('task_not_found_or_expired')
    await vi.advanceTimersByTimeAsync(20)

    expect(editedContents.some(c => c.includes('Still processing'))).toBe(true)
    expect(editedContents.some(c => c.includes('Lost connection'))).toBe(false)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(
      editedContents.some(c => c.includes('Delivered after the reconcile fetch failed.'))
    ).toBe(true)
    expect(stream.closed).toBe(true)
  })

  it('keeps "Lost connection" for a genuine transport error', async () => {
    const editedContents: string[] = []
    const adapter = makeAdapter(editedContents)
    const rpcClient = makeRpcClient()
    const reader = new ChannelReader({
      rpcClient,
      adapters: new Map([['telegram', adapter]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    await reader.handleMessages([makeMessage('hola')])
    const stream = streamCalls[0]!
    await stream.fireError('ECONNRESET')

    expect(editedContents.some(c => c.includes('Lost connection'))).toBe(true)
    expect(rpcClient.getTaskResult).not.toHaveBeenCalled()
  })
})
