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

describe('multi-approval flow (issue #296 bonus regression)', () => {
  it('surfaces a second suspended event during post-approval and routes the second /approve', async () => {
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
        taskId: 'task-multi-1',
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

    // 1. Send message; first suspended.
    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'waiting_approval' as const,
      approval: {
        taskId: 'task-multi-1',
        requestId: 'approval-multi-A',
        userId: '516801777',
        notification: 'Tool A requires approval. Reply /approve or /deny.',
      },
    })
    await reader.handleMessages([makeMessage('multi-step task')])
    const stream = streamCalls[0]
    stream.fireSuspended({
      taskId: 'task-multi-1',
      requestId: 'approval-multi-A',
      toolName: 'tool-a',
      displayName: 'Tool A',
      reason: 'approval_required',
    })
    await new Promise(r => setTimeout(r, 20))

    // 2. First /approve.
    await reader.handleMessages([makeMessage('/approve', 'msg-approve-A')])
    expect(rpcClient.sendApproval).toHaveBeenNthCalledWith(
      1,
      '516801777',
      'approval-multi-A',
      false,
      'telegram',
      'tg-chat-1'
    )

    // 3. SSE fires a second suspended for a different tool/requestId.
    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'waiting_approval' as const,
      approval: {
        taskId: 'task-multi-1',
        requestId: 'approval-multi-B',
        userId: '516801777',
        notification: 'Tool B requires approval. Reply /approve or /deny.',
      },
    })
    stream.fireSuspended({
      taskId: 'task-multi-1',
      requestId: 'approval-multi-B',
      toolName: 'tool-b',
      displayName: 'Tool B',
      reason: 'approval_required',
    })
    await new Promise(r => setTimeout(r, 20))

    // Second notification surfaced to the user via editStatus.
    expect(editedContents).toContain('Tool B requires approval. Reply /approve or /deny.')

    // 4. Second /approve.
    await reader.handleMessages([makeMessage('/approve', 'msg-approve-B')])
    expect(rpcClient.sendApproval).toHaveBeenNthCalledWith(
      2,
      '516801777',
      'approval-multi-B', // <- the SECOND requestId, not the first
      false,
      'telegram',
      'tg-chat-1'
    )

    // 5. Terminal: completed. Final response delivered.
    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'completed' as const,
      response: 'Multi-step task done.',
    })
    stream.fireTerminal({ taskId: 'task-multi-1', status: 'completed' })
    await new Promise(r => setTimeout(r, 20))

    expect(editedContents.some(c => c.includes('Multi-step task done'))).toBe(true)
    expect(stream.closed).toBe(true)
    expect(rpcClient.sendApproval).toHaveBeenCalledTimes(2)
  })
})
