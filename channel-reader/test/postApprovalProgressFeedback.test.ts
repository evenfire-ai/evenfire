import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChannelAdapter, CommunicationChannelCRD, Message } from '../src/types'

// Mock createProgressStream with per-call triggers so tests can fire events
// at specific points in the orchestration.
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

describe('post-approval progress feedback (Bug B regression)', () => {
  it('keeps editing the status bubble with tool progress AFTER /approve is consumed', async () => {
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
        taskId: 'task-bug-b',
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-bug-b',
          requestId: 'approval-bug-b-1',
          userId: '516801777',
          notification:
            'Tool `mcp-coingecko-remote__execute` requires approval. Reply /approve or /deny.',
        },
      })),
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

    // 1. User sends the message; SSE stream is created.
    await reader.handleMessages([makeMessage('research best AI tokens')])
    expect(streamCalls).toHaveLength(1)
    const stream = streamCalls[0]
    expect(stream.taskId).toBe('task-bug-b')

    // 2. SSE fires suspended → channel-reader fetches approval notification and edits bubble.
    stream.fireSuspended({
      taskId: 'task-bug-b',
      requestId: 'approval-bug-b-1',
      toolName: 'mcp-coingecko-remote__execute',
      displayName: 'Mcp-coingecko-remote · execute',
      reason: 'approval_required',
    })
    await new Promise(r => setTimeout(r, 20))
    expect(editedContents).toContain(
      'Tool `mcp-coingecko-remote__execute` requires approval. Reply /approve or /deny.'
    )

    // 3. User replies /approve. handleApprovalCommand sends the approval and
    //    the "Approved." reply, then returns. Stream stays open.
    rpcClient.getTaskResult.mockClear() // Reset so later assertions on terminal-fetch are clear.
    await reader.handleMessages([makeMessage('/approve', 'msg-approve')])
    expect(rpcClient.sendApproval).toHaveBeenCalledWith(
      '516801777',
      'approval-bug-b-1',
      false,
      'telegram',
      'tg-chat-1'
    )
    expect(sentReplies.some(r => r.content.includes('Approved'))).toBe(true)
    expect(stream.closed).toBe(false) // ← The critical assertion: stream NOT closed.

    // 4. SSE fires three tool_start/tool_complete events post-approval.
    //    The new progressClient debounces but our fixture skips that — each
    //    fireProgress synchronously calls onProgress, which inside handleMessage-
    //    WithProgress calls editStatus.
    const editCountBeforeProgress = editedContents.length
    stream.fireProgress([
      {
        toolCallId: 'c1',
        toolName: 'mcp-coingecko-remote__execute',
        displayName: 'Mcp-coingecko-remote',
        intentSummary: 'Using…',
        iteration: 1,
        stepIndex: 0,
        totalSteps: 1,
        state: 'running',
      },
    ])
    await new Promise(r => setTimeout(r, 20))
    expect(editedContents.length).toBeGreaterThan(editCountBeforeProgress)

    stream.fireProgress([
      {
        toolCallId: 'c1',
        toolName: 'mcp-coingecko-remote__execute',
        displayName: 'Mcp-coingecko-remote',
        intentSummary: 'Using…',
        iteration: 1,
        stepIndex: 0,
        totalSteps: 1,
        state: 'completed',
        durationMs: 3400,
      },
      {
        toolCallId: 'c2',
        toolName: 'clerum__generate_chart',
        displayName: 'Clerum · generate_chart',
        intentSummary: 'Building chart',
        iteration: 2,
        stepIndex: 1,
        totalSteps: 2,
        state: 'running',
      },
    ])
    await new Promise(r => setTimeout(r, 20))
    const editsAfterTwoProgress = editedContents.length
    expect(editsAfterTwoProgress).toBeGreaterThan(editCountBeforeProgress + 1)

    // 5. SSE fires terminal: completed. channel-reader fetches the final response
    //    via getTaskResult and edits the bubble.
    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'completed' as const,
      response: 'Top AI tokens: TAO, RNDR, AGIX.',
    })
    stream.fireTerminal({ taskId: 'task-bug-b', status: 'completed' })
    await new Promise(r => setTimeout(r, 20))

    // Final response appears in an edit.
    expect(editedContents.some(c => c.includes('Top AI tokens'))).toBe(true)
    expect(stream.closed).toBe(true)
  })
})
