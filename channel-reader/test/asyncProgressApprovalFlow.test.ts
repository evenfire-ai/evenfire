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

function makeSlackMessage(content: string): Message {
  return {
    channelType: 'slack',
    channelId: 'C123',
    sender: 'U123',
    content,
    timestamp: new Date('2026-05-12T12:00:00.000Z'),
    messageId: '1710000000.000001',
    providerIdentity: {
      medium: 'slack',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:1710000000.000001',
    },
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

describe('async progress flow — SSE-driven approval', () => {
  it('routes /approve to mcp-host, sends "Approved." reply, and delivers final response via SSE terminal', async () => {
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
        taskId: 'task-async-1',
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

    // 1. User sends research request — stream opens, suspended notification arrives.
    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'waiting_approval' as const,
      approval: {
        taskId: 'task-async-1',
        requestId: 'approval-async-1',
        userId: '516801777',
        notification:
          'Tool `mcp-tavily-remote__tavily_research` requires approval. Reply /approve or /deny.',
      },
    })
    await reader.handleMessages([makeMessage('Research the best AI crypto tokens')])
    expect(streamCalls).toHaveLength(1)
    const stream = streamCalls[0]

    stream.fireSuspended({
      taskId: 'task-async-1',
      requestId: 'approval-async-1',
      toolName: 'mcp-tavily-remote__tavily_research',
      displayName: 'Mcp-tavily-remote · tavily_research',
      reason: 'approval_required',
    })
    await new Promise(r => setTimeout(r, 20))
    expect(editedContents).toContain(
      'Tool `mcp-tavily-remote__tavily_research` requires approval. Reply /approve or /deny.'
    )

    // 2. User replies /approve. handleApprovalCommand sends the approval HTTP,
    //    sends the "Approved." reply, and RETURNS — no inline polling.
    await reader.handleMessages([makeMessage('/approve', 'msg-approve')])

    expect(rpcClient.sendApproval).toHaveBeenCalledWith(
      '516801777',
      'approval-async-1',
      false,
      'telegram',
      'tg-chat-1'
    )
    expect(sentReplies.map(r => r.content)).toContain('Approved. Processing...')
    expect(stream.closed).toBe(false)

    // 3. SSE eventually fires terminal: completed. channel-reader fetches the final
    //    response via getTaskResult and edits the bubble.
    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'completed' as const,
      response: 'Research complete: 10 AI tokens listed.',
    })
    stream.fireTerminal({ taskId: 'task-async-1', status: 'completed' })
    await new Promise(r => setTimeout(r, 20))

    expect(editedContents.some(c => c.includes('Research complete'))).toBe(true)
    expect(stream.closed).toBe(true)

    // 4. Final response was delivered as an edit, not a new sendReply.
    const finalResponseSends = sentReplies.filter(r => r.content.includes('Research complete'))
    expect(finalResponseSends).toHaveLength(0)
  })

  it('delivers the final response through polling fallback when SSE misses terminal after approval', async () => {
    vi.useFakeTimers()
    streamCalls.length = 0
    const editedContents: string[] = []
    const sentReplies: Array<{
      channelId: string
      content: string
      attachments?: import('../src/types').Attachment[]
    }> = []

    const adapter: ChannelAdapter = {
      channelType: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async (channelId, content, _replyTo, attachments) => {
        sentReplies.push({ channelId, content, attachments })
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
        taskId: 'task-fallback-1',
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
        taskId: 'task-fallback-1',
        requestId: 'approval-fallback-1',
        userId: '516801777',
        notification: 'Tool `http_request` requires approval. Reply /approve or /deny.',
      },
    })
    await reader.handleMessages([makeMessage('Research current NBA roster')])
    const stream = streamCalls[0]

    stream.fireSuspended({
      taskId: 'task-fallback-1',
      requestId: 'approval-fallback-1',
      toolName: 'http_request',
      displayName: 'HTTP · http_request',
      reason: 'approval_required',
    })
    await vi.advanceTimersByTimeAsync(20)

    await reader.handleMessages([makeMessage('/approve', 'msg-approve-fallback')])
    expect(sentReplies.map(r => r.content)).toContain('Approved. Processing...')

    const attachment: import('../src/types').Attachment = {
      id: 'artifact-1',
      kind: 'file',
      mimeType: 'application/pdf',
      encoding: 'base64',
      dataBase64: 'JVBERi0xLjQK',
      filename: 'result.pdf',
      lane: 'internal_generated_artifact',
      artifactFormat: 'pdf',
    }
    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'completed' as const,
      response: 'Fallback complete with downloadable PDF.',
      attachments: [attachment],
    })

    await vi.advanceTimersByTimeAsync(2_000)

    expect(editedContents.some(c => c.includes('Fallback complete with downloadable PDF.'))).toBe(
      true
    )
    expect(sentReplies.some(r => r.attachments?.[0]?.filename === 'result.pdf')).toBe(true)
    expect(stream.closed).toBe(true)

    vi.useRealTimers()
  })

  it('delivers Slack final responses through polling when SSE misses terminal', async () => {
    vi.useFakeTimers()
    streamCalls.length = 0
    const editedContents: string[] = []

    const adapter: ChannelAdapter = {
      channelType: 'slack',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => 'slack-status-1'),
      editMessage: vi.fn(async (_channelId, _messageId, content) => {
        editedContents.push(content)
      }),
    }

    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-slack-fallback',
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
      adapters: new Map([['slack', adapter]]),
      channels: [],
      sleep: async () => undefined,
    })

    await reader.handleMessages([makeSlackMessage('<@U999> what workflows do you have access to?')])
    expect(streamCalls).toHaveLength(1)

    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'completed' as const,
      response: 'You can access research-summary-workflow.',
    })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(editedContents.some(c => c.includes('You can access research-summary-workflow.'))).toBe(
      true
    )
    expect(streamCalls[0].closed).toBe(true)

    vi.useRealTimers()
  })

  it('routes /deny and sends "Denied." reply', async () => {
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
        taskId: 'task-deny-1',
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-deny-1',
          requestId: 'approval-deny-1',
          userId: '516801777',
          notification: 'Tool `x` requires approval. Reply /approve or /deny.',
        },
      })),
      sendApproval: vi.fn(),
      sendDenial: vi.fn(async () => ({ success: true })),
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

    await reader.handleMessages([makeMessage('do something dangerous')])
    streamCalls[0].fireSuspended({
      taskId: 'task-deny-1',
      requestId: 'approval-deny-1',
      toolName: 'x',
      displayName: 'X',
      reason: 'approval_required',
    })
    await new Promise(r => setTimeout(r, 20))

    await reader.handleMessages([makeMessage('/deny', 'msg-deny')])

    expect(rpcClient.sendDenial).toHaveBeenCalledWith(
      '516801777',
      'approval-deny-1',
      'telegram',
      'tg-chat-1'
    )
    expect(sentReplies.map(r => r.content)).toContain('Denied. The tool will not be executed.')
  })
})
