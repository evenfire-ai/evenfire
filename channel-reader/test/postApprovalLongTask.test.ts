import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChannelAdapter, CommunicationChannelCRD, Message } from '../src/types'

interface StreamCall {
  taskId: string
  fireProgress: (steps: import('../src/types').ProgressStep[]) => void
  fireSuspended: (data: import('../src/progressClient').SuspendedEventData) => void
  fireTerminal: (data: import('../src/progressClient').TerminalEventData) => void
  fireError: (msg: string) => void
  closed: boolean
}
const streamCalls: StreamCall[] = []

vi.mock('../src/progressClient', () => ({
  createProgressStream: (options: import('../src/progressClient').ProgressStreamOptions) => {
    const entry: StreamCall = {
      taskId: options.taskId,
      fireProgress: options.onProgress,
      fireSuspended: options.onSuspended,
      fireTerminal: options.onTerminal,
      fireError: options.onError,
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

describe('post-approval long-running task (Bug A regression — issue #296)', () => {
  it('delivers the final response even when the post-approval phase exceeds 4 minutes (no 4-min cap)', async () => {
    vi.useFakeTimers()
    streamCalls.length = 0
    const editedContents: string[] = []
    const sentReplies: Array<{ channelId: string; content: string }> = []

    const adapter: ChannelAdapter = {
      channelType: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async (channelId, content) => {
        sentReplies.push({ channelId, content })
        return `bot-msg-${sentReplies.length}`
      }),
      editMessage: vi.fn(async (_c, _m, content) => {
        editedContents.push(content)
      }),
    }

    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-long-1',
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

    // Setup: send research request, get suspended.
    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'waiting_approval' as const,
      approval: {
        taskId: 'task-long-1',
        requestId: 'approval-long-1',
        userId: '516801777',
        notification: 'Tool `mcp-x__execute` requires approval. Reply /approve or /deny.',
      },
    })
    await reader.handleMessages([makeMessage('do a long analysis')])
    const stream = streamCalls[0]
    stream.fireSuspended({
      taskId: 'task-long-1',
      requestId: 'approval-long-1',
      toolName: 'mcp-x__execute',
      displayName: 'Mcp-x · execute',
      reason: 'approval_required',
    })
    await vi.advanceTimersByTimeAsync(20)

    // User approves
    await reader.handleMessages([makeMessage('/approve', 'msg-approve-long')])
    expect(sentReplies.some(r => r.content.includes('Approved'))).toBe(true)

    // Simulate 10 minutes of post-approval work — far past the old 4-min cap.
    // The stream keeps firing progress events; channel-reader keeps editing.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(100_000) // 100 seconds × 6 = 10 min total
      stream.fireProgress([
        {
          toolCallId: `c${i}`,
          toolName: 'mcp-x__execute',
          displayName: 'Mcp-x',
          intentSummary: `Step ${i}`,
          iteration: i + 1,
          stepIndex: i,
          totalSteps: 6,
          state: 'completed',
          durationMs: 50_000,
        },
      ])
    }

    // At this point the OLD code would have sent a "Timed out" reply after
    // the 4-min cap (240 s). Verify it didn't.
    const timeoutReplies = sentReplies.filter(r => r.content.includes('Timed out'))
    expect(timeoutReplies).toHaveLength(0)

    // Now the task actually completes.
    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'completed' as const,
      response: 'Long analysis complete: ...',
    })
    stream.fireTerminal({ taskId: 'task-long-1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(20)

    // Final response delivered.
    expect(editedContents.some(c => c.includes('Long analysis complete'))).toBe(true)

    vi.useRealTimers()
  })
})
