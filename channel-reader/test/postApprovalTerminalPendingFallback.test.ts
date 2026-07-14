import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChannelAdapter, CommunicationChannelCRD, Message } from '../src/types'

interface StreamCall {
  fireSuspended: (data: import('../src/progressClient').SuspendedEventData) => void
  fireTerminal: (data: import('../src/progressClient').TerminalEventData) => void
  closed: boolean
}

const streamCalls: StreamCall[] = []

vi.mock('../src/progressClient', () => ({
  createProgressStream: (options: import('../src/progressClient').ProgressStreamOptions) => {
    const entry: StreamCall = {
      fireSuspended: options.onSuspended,
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
    timestamp: new Date('2026-05-12T12:00:00.000Z'),
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

describe('post-approval terminal fallback', () => {
  it('continues polling when terminal arrives before the final task result is ready', async () => {
    vi.useFakeTimers()
    streamCalls.length = 0
    const editedContents: string[] = []
    const sentReplies: string[] = []

    const adapter: ChannelAdapter = {
      channelType: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async (_channelId, content) => {
        sentReplies.push(content)
        return `bot-msg-${sentReplies.length}`
      }),
      editMessage: vi.fn(async (_channelId, _messageId, content) => {
        editedContents.push(content)
      }),
    }

    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-terminal-pending',
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(),
      sendApproval: vi.fn(async () => ({ success: true })),
      sendDenial: vi.fn(),
      sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
      getCronResults: vi.fn(async () => []),
      acknowledgeCronResult: vi.fn(),
    }

    const reader = new ChannelReader({
      rpcClient,
      adapters: new Map([['telegram', adapter]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'waiting_approval' as const,
      approval: {
        taskId: 'task-terminal-pending',
        requestId: 'approval-terminal-pending',
        userId: '516801777',
        notification: 'Tool `http_request` requires approval. Reply /approve or /deny.',
      },
    })

    await reader.handleMessages([makeMessage('Research current NBA roster')])
    const stream = streamCalls[0]
    stream.fireSuspended({
      taskId: 'task-terminal-pending',
      requestId: 'approval-terminal-pending',
      toolName: 'http_request',
      displayName: 'HTTP · http_request',
      reason: 'approval_required',
    })
    await vi.advanceTimersByTimeAsync(20)

    await reader.handleMessages([makeMessage('/approve', 'msg-approve-terminal-pending')])
    expect(sentReplies).toContain('Approved. Processing...')

    rpcClient.getTaskResult
      .mockResolvedValueOnce({
        success: true,
        status: 'pending' as const,
      })
      .mockResolvedValueOnce({
        success: true,
        status: 'completed' as const,
        response: 'Final result delivered by fallback.',
      })

    stream.fireTerminal({ taskId: 'task-terminal-pending', status: 'completed' })
    await vi.advanceTimersByTimeAsync(20)
    expect(editedContents.some(c => c.includes('Final response is still syncing.'))).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(editedContents.some(c => c.includes('Final result delivered by fallback.'))).toBe(true)
    expect(stream.closed).toBe(true)
  })

  it('uses the same fallback for async tasks that complete without approval', async () => {
    vi.useFakeTimers()
    streamCalls.length = 0
    const editedContents: string[] = []

    const adapter: ChannelAdapter = {
      channelType: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => 'bot-msg-1'),
      editMessage: vi.fn(async (_channelId, _messageId, content) => {
        editedContents.push(content)
      }),
    }

    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-terminal-no-approval',
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(),
      sendApproval: vi.fn(),
      sendDenial: vi.fn(),
      sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
      getCronResults: vi.fn(async () => []),
      acknowledgeCronResult: vi.fn(),
    }

    const reader = new ChannelReader({
      rpcClient,
      adapters: new Map([['telegram', adapter]]),
      channels: [makeChannel()],
      sleep: async () => undefined,
    })

    await reader.handleMessages([makeMessage('Summarize public market news')])
    const stream = streamCalls[0]
    rpcClient.getTaskResult
      .mockResolvedValueOnce({
        success: true,
        status: 'pending' as const,
      })
      .mockResolvedValueOnce({
        success: true,
        status: 'completed' as const,
        response: 'Async final result delivered by fallback.',
      })

    stream.fireTerminal({ taskId: 'task-terminal-no-approval', status: 'completed' })
    await vi.advanceTimersByTimeAsync(20)
    expect(editedContents.some(c => c.includes('Final response is still syncing.'))).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(editedContents.some(c => c.includes('Async final result delivered by fallback.'))).toBe(
      true
    )
    expect(stream.closed).toBe(true)
  })
})
