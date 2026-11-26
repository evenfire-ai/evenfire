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

function makeTeamsMessage(content: string, overrides: Partial<Message> = {}): Message {
  return {
    channelType: 'teams',
    channelId: '19:channel-1@thread.tacv2;messageid=root-post-1',
    sender: 'teams-user-1',
    content,
    timestamp: new Date('2026-05-12T12:00:00.000Z'),
    messageId: 'activity-1',
    threadId: 'root-post-1',
    providerIdentity: {
      medium: 'teams',
      providerUserId: 'teams-user-1',
      providerWorkspaceId: 'tenant-1',
      providerChannelId: '19:channel-1@thread.tacv2',
      providerChannelType: 'channel',
      providerEventId: 'teams:tenant-1:conversation-1:activity-1',
    },
    ...overrides,
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

    const editMessage = vi.fn<ChannelAdapter['editMessage']>(async (_c, _m, content) => {
      editedContents.push(content)
    })
    const adapter: ChannelAdapter = {
      channelType: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async (channelId, content) => {
        sentReplies.push({ channelId, content })
        return `bot-msg-${sentReplies.length}`
      }),
      editMessage,
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
    const approvalEdit = editMessage.mock.calls.find(call => call[2].includes('requires approval'))
    expect(approvalEdit?.[3]?.telegramInlineKeyboard).toEqual([
      [
        expect.objectContaining({
          text: 'Approve',
          callbackData: expect.stringMatching(/^tool:a:/),
        }),
        expect.objectContaining({ text: 'Deny', callbackData: expect.stringMatching(/^tool:d:/) }),
      ],
      [
        expect.objectContaining({
          text: 'Always approve',
          callbackData: expect.stringMatching(/^tool:l:/),
        }),
      ],
    ])
    const editCountAfterApprovalPrompt = editMessage.mock.calls.length
    stream.fireProgress([
      {
        toolCallId: 'tool-progress-after-approval-prompt',
        toolName: 'mcp-tavily-remote__tavily_research',
        displayName: 'Mcp-tavily-remote',
        intentSummary: 'Still working',
        iteration: 1,
        stepIndex: 1,
        totalSteps: 1,
        state: 'running',
      },
    ])
    await new Promise(r => setTimeout(r, 20))
    expect(editMessage).toHaveBeenCalledTimes(editCountAfterApprovalPrompt)

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

  it('omits Always approve on a card the Host cannot allowlist, and does not claim a grant', async () => {
    streamCalls.length = 0
    const sentReplies: Array<{ channelId: string; content: string }> = []
    const editMessage = vi.fn<ChannelAdapter['editMessage']>(async () => undefined)
    const adapter: ChannelAdapter = {
      channelType: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async (channelId, content) => {
        sentReplies.push({ channelId, content })
        return `bot-msg-${sentReplies.length}`
      }),
      editMessage,
    }
    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-reask-1',
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-reask-1',
          requestId: 'approval-reask-1',
          userId: '516801777',
          notification: 'Tool `shell_exec` was denied and must be approved again.',
          alwaysApproveAllowed: false as const,
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

    await reader.handleMessages([makeMessage('run the denied tool', 'msg-reask')])
    streamCalls[0].fireSuspended({
      taskId: 'task-reask-1',
      requestId: 'approval-reask-1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      reason: 'approval_required',
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    const approvalEdit = editMessage.mock.calls.find(call =>
      call[2].includes('must be approved again')
    )
    expect(approvalEdit?.[3]?.telegramInlineKeyboard).toEqual([
      [
        expect.objectContaining({
          text: 'Approve',
          callbackData: expect.stringMatching(/^tool:a:/),
        }),
        expect.objectContaining({ text: 'Deny', callbackData: expect.stringMatching(/^tool:d:/) }),
      ],
    ])

    await reader.handleMessages([makeMessage('/approve always', 'msg-reask-always')])
    expect(rpcClient.sendApproval).toHaveBeenCalledWith(
      '516801777',
      'approval-reask-1',
      true,
      'telegram',
      'tg-chat-1'
    )
    expect(sentReplies.map(reply => reply.content)).toContain('Approved. Processing...')
    expect(sentReplies.map(reply => reply.content)).not.toContain(
      'Approved (always for this tool). Processing...'
    )
  })

  it('omits Slack Always approve when the Host cannot store a grant', async () => {
    streamCalls.length = 0
    const editMessage = vi.fn<ChannelAdapter['editMessage']>(async () => undefined)
    const adapter: ChannelAdapter = {
      channelType: 'slack',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => 'slack-status-reask-1'),
      editMessage,
    }
    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-slack-reask-1',
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-slack-reask-1',
          requestId: 'approval-slack-reask-1',
          userId: 'U123',
          notification: 'Tool `shell_exec` was denied and must be approved again.',
          alwaysApproveAllowed: false as const,
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
      adapters: new Map([['slack', adapter]]),
      channels: [],
      sleep: async () => undefined,
    })

    await reader.handleMessages([makeSlackMessage('<@U999> run the denied tool')])
    streamCalls[0].fireSuspended({
      taskId: 'task-slack-reask-1',
      requestId: 'approval-slack-reask-1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      reason: 'approval_required',
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    const approvalEdit = editMessage.mock.calls.find(call =>
      call[2].includes('must be approved again')
    )
    const actions = approvalEdit?.[3]?.slackBlocks?.find(block => block.type === 'actions')
    expect(actions?.elements?.map(element => element.action_id)).toEqual([
      'tool_approval_approve',
      'tool_approval_deny',
    ])
    streamCalls[0].fireTerminal({ taskId: 'task-slack-reask-1', status: 'cancelled' })
  })

  it('omits Teams Always approve when the Host cannot store a grant', async () => {
    streamCalls.length = 0
    const editMessage = vi.fn<ChannelAdapter['editMessage']>(async () => undefined)
    const adapter: ChannelAdapter = {
      channelType: 'teams',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => 'teams-status-reask-1'),
      editMessage,
    }
    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-teams-reask-1',
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-teams-reask-1',
          requestId: 'approval-teams-reask-1',
          userId: 'teams-user-1',
          notification: 'Tool `shell_exec` was denied and must be approved again.',
          alwaysApproveAllowed: false as const,
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
      adapters: new Map([['teams', adapter]]),
      channels: [],
      sleep: async () => undefined,
    })

    await reader.handleMessages([makeTeamsMessage('run the denied tool', { messageId: 'reask-1' })])
    streamCalls[0].fireSuspended({
      taskId: 'task-teams-reask-1',
      requestId: 'approval-teams-reask-1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      reason: 'approval_required',
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    const approvalEdit = editMessage.mock.calls.find(call =>
      call[2].includes('must be approved again')
    )
    expect(approvalEdit?.[3]?.teamsActions?.map(action => action.title)).toEqual([
      'Approve',
      'Deny',
    ])
    streamCalls[0].fireTerminal({ taskId: 'task-teams-reask-1', status: 'cancelled' })
  })

  it('omits Always approve on the sync fallback when the Host cannot store a grant', async () => {
    streamCalls.length = 0
    const sent: Array<{ content: string; options?: { telegramInlineKeyboard?: unknown } }> = []
    const adapter: ChannelAdapter = {
      channelType: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async (_channelId, content, _replyTo, _attachments, options) => {
        sent.push({ content, options })
        return `bot-msg-${sent.length}`
      }),
      editMessage: vi.fn(async () => undefined),
    }
    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('progress unavailable'))
        .mockResolvedValueOnce({
          success: true,
          status: 'waiting_approval' as const,
          approval: {
            taskId: 'task-sync-reask-1',
            requestId: 'approval-sync-reask-1',
            userId: '516801777',
            notification: 'Tool `shell_exec` was denied and must be approved again.',
            alwaysApproveAllowed: false as const,
          },
        }),
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

    await reader.handleMessages([makeMessage('run the denied tool', 'msg-sync-reask')])

    const approval = sent.find(call => call.content.includes('must be approved again'))
    const labels = (
      approval?.options?.telegramInlineKeyboard as Array<Array<{ text: string }>> | undefined
    )?.flatMap(row => row.map(button => button.text))
    expect(labels).toEqual(['Approve', 'Deny'])
    expect(rpcClient.sendMessage).toHaveBeenCalledTimes(2)

    await reader.handleMessages([makeMessage('/approve always', 'msg-sync-reask-always')])
    expect(rpcClient.sendApproval).toHaveBeenCalledWith(
      '516801777',
      'approval-sync-reask-1',
      true,
      'telegram',
      'tg-chat-1'
    )
    expect(sent.map(call => call.content)).toContain('Approved. Processing...')
    expect(sent.map(call => call.content)).not.toContain(
      'Approved (always for this tool). Processing...'
    )
  })

  it('omits Always approve when the async send returns no task id', async () => {
    streamCalls.length = 0
    const sent: Array<{ content: string; options?: { telegramInlineKeyboard?: unknown } }> = []
    const adapter: ChannelAdapter = {
      channelType: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async (_channelId, content, _replyTo, _attachments, options) => {
        sent.push({ content, options })
        return `bot-msg-${sent.length}`
      }),
      editMessage: vi.fn(async () => undefined),
    }
    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-no-id-reask-1',
          requestId: 'approval-no-id-reask-1',
          userId: '516801777',
          notification: 'Tool `shell_exec` was denied and must be approved again.',
          alwaysApproveAllowed: false as const,
        },
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

    await reader.handleMessages([makeMessage('run the denied tool', 'msg-no-id-reask')])

    // No taskId means no progress stream: the card comes from the sync branch.
    expect(streamCalls).toHaveLength(0)
    const approval = sent.find(call => call.content.includes('must be approved again'))
    const labels = (
      approval?.options?.telegramInlineKeyboard as Array<Array<{ text: string }>> | undefined
    )?.flatMap(row => row.map(button => button.text))
    expect(labels).toEqual(['Approve', 'Deny'])

    await reader.handleMessages([makeMessage('/approve always', 'msg-no-id-reask-always')])
    expect(rpcClient.sendApproval).toHaveBeenCalledWith(
      '516801777',
      'approval-no-id-reask-1',
      true,
      'telegram',
      'tg-chat-1'
    )
    expect(sent.map(call => call.content)).toContain('Approved. Processing...')
    expect(sent.map(call => call.content)).not.toContain(
      'Approved (always for this tool). Processing...'
    )
  })

  it('does not claim a lasting grant on an email card the Host cannot allowlist', async () => {
    streamCalls.length = 0
    const sent: string[] = []
    const adapter: ChannelAdapter = {
      channelType: 'email',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async (_channelId, content) => {
        sent.push(content)
        return `email-msg-${sent.length}`
      }),
    }
    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-email-reask-1',
          requestId: 'approval-email-reask-1',
          userId: 'user@example.com',
          notification: 'Tool `shell_exec` was denied and must be approved again.',
          alwaysApproveAllowed: false as const,
        },
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(),
      sendApproval: vi.fn(async () => ({ success: true })),
      sendDenial: vi.fn(),
      sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
      getCronResults: vi.fn(async () => []),
      acknowledgeCronResult: vi.fn(),
    }
    const emailMessage = (content: string, messageId: string): Message => ({
      channelType: 'email',
      channelId: 'support-inbox',
      sender: 'user@example.com',
      content,
      timestamp: new Date('2026-05-12T12:00:00.000Z'),
      messageId,
    })
    const reader = new ChannelReader({
      rpcClient,
      adapters: new Map([['email', adapter]]),
      channels: [
        {
          name: 'chatllm-email',
          namespace: 'channels',
          spec: {
            hostRef: 'chatllm',
            email: [{ channelId: 'support-inbox', emails: ['user@example.com'] }],
          },
        },
      ],
      sleep: async () => undefined,
    })

    await reader.handleMessages([emailMessage('run the denied tool', 'email-reask')])
    // Email takes the synchronous branch: one send, no progress stream.
    expect(streamCalls).toHaveLength(0)
    expect(rpcClient.sendMessage).toHaveBeenCalledTimes(1)
    expect(sent).toContain('Tool `shell_exec` was denied and must be approved again.')

    await reader.handleMessages([emailMessage('/approve always', 'email-reask-always')])
    expect(rpcClient.sendApproval).toHaveBeenCalledWith(
      'user@example.com',
      'approval-email-reask-1',
      true,
      'email',
      'support-inbox'
    )
    expect(sent).toContain('Approved. Processing...')
    expect(sent).not.toContain('Approved (always for this tool). Processing...')
  })

  it('omits Always approve when result polling finds a second card the Host cannot allowlist', async () => {
    vi.useFakeTimers()
    try {
      await pollingReaskScenario()
    } finally {
      // A failed assertion must not leave fake timers to the tests that follow.
      vi.useRealTimers()
    }
  })

  async function pollingReaskScenario(): Promise<void> {
    streamCalls.length = 0
    const sentReplies: string[] = []
    const editMessage = vi.fn<ChannelAdapter['editMessage']>(async () => undefined)
    const adapter: ChannelAdapter = {
      channelType: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async (_channelId, content) => {
        sentReplies.push(content)
        return `bot-msg-${sentReplies.length}`
      }),
      editMessage,
    }
    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-poll-reask-1',
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

    // First card: an ordinary approval that may store a grant.
    rpcClient.getTaskResult.mockResolvedValueOnce({
      success: true,
      status: 'waiting_approval' as const,
      approval: {
        taskId: 'task-poll-reask-1',
        requestId: 'approval-poll-1',
        userId: '516801777',
        notification: 'Tool `http_request` requires approval. Reply /approve or /deny.',
      },
    })
    await reader.handleMessages([makeMessage('fetch and then run', 'msg-poll-reask')])
    streamCalls[0].fireSuspended({
      taskId: 'task-poll-reask-1',
      requestId: 'approval-poll-1',
      toolName: 'http_request',
      displayName: 'HTTP · http_request',
      reason: 'approval_required',
    })
    await vi.advanceTimersByTimeAsync(20)
    await reader.handleMessages([makeMessage('/approve', 'msg-poll-approve-1')])
    expect(sentReplies).toContain('Approved. Processing...')

    // SSE stays silent; the polling fallback finds a second, exact-invocation card.
    rpcClient.getTaskResult.mockResolvedValue({
      success: true,
      status: 'waiting_approval' as const,
      approval: {
        taskId: 'task-poll-reask-1',
        requestId: 'approval-poll-2',
        userId: '516801777',
        notification: 'Tool `shell_exec` was denied and must be approved again.',
        alwaysApproveAllowed: false as const,
      },
    })
    await vi.advanceTimersByTimeAsync(2_000)

    const secondCard = editMessage.mock.calls.find(call =>
      call[2].includes('must be approved again')
    )
    const labels = (
      secondCard?.[3]?.telegramInlineKeyboard as Array<Array<{ text: string }>> | undefined
    )?.flatMap(row => row.map(button => button.text))
    expect(labels).toEqual(['Approve', 'Deny'])

    await reader.handleMessages([makeMessage('/approve always', 'msg-poll-approve-2')])
    expect(rpcClient.sendApproval).toHaveBeenLastCalledWith(
      '516801777',
      'approval-poll-2',
      true,
      'telegram',
      'tg-chat-1'
    )
    // One plain acknowledgement per approval: the second card was answered too.
    expect(sentReplies.filter(reply => reply === 'Approved. Processing...')).toHaveLength(2)
    expect(sentReplies).not.toContain('Approved (always for this tool). Processing...')

    streamCalls[0].fireTerminal({ taskId: 'task-poll-reask-1', status: 'cancelled' })
  }

  it('confirms a lasting grant when the card may store one', async () => {
    streamCalls.length = 0
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
      editMessage: vi.fn(async () => undefined),
    }
    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-always-1',
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-always-1',
          requestId: 'approval-always-1',
          userId: '516801777',
          notification: 'Tool `http_request` requires approval. Reply /approve or /deny.',
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

    await reader.handleMessages([makeMessage('fetch the page', 'msg-always')])
    streamCalls[0].fireSuspended({
      taskId: 'task-always-1',
      requestId: 'approval-always-1',
      toolName: 'http_request',
      displayName: 'HTTP · http_request',
      reason: 'approval_required',
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    await reader.handleMessages([makeMessage('/approve always', 'msg-always-approve')])
    expect(rpcClient.sendApproval).toHaveBeenCalledWith(
      '516801777',
      'approval-always-1',
      true,
      'telegram',
      'tg-chat-1'
    )
    expect(sentReplies).toContain('Approved (always for this tool). Processing...')
    streamCalls[0].fireTerminal({ taskId: 'task-always-1', status: 'cancelled' })
  })

  it('renders Slack tool approval buttons in the originating thread', async () => {
    streamCalls.length = 0
    const editMessage = vi.fn<ChannelAdapter['editMessage']>(async () => undefined)
    const adapter: ChannelAdapter = {
      channelType: 'slack',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => 'slack-status-approval-1'),
      editMessage,
    }
    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-slack-button-1',
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-slack-button-1',
          requestId: 'approval-slack-button-1',
          userId: 'U123',
          notification: 'HTTP search requires approval.',
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
      adapters: new Map([['slack', adapter]]),
      channels: [],
      sleep: async () => undefined,
    })
    const source = makeSlackMessage('<@U999> search the web')
    source.threadId = '1710000000.000000'

    await reader.handleMessages([source])
    streamCalls[0].fireSuspended({
      taskId: 'task-slack-button-1',
      requestId: 'approval-slack-button-1',
      toolName: 'http_request',
      displayName: 'HTTP search',
      reason: 'approval_required',
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    const approvalEdit = editMessage.mock.calls.find(
      call => call[2] === 'HTTP search requires approval.'
    )
    const actions = approvalEdit?.[3]?.slackBlocks?.find(block => block.type === 'actions')
    expect(actions).toMatchObject({
      type: 'actions',
      elements: [
        expect.objectContaining({
          action_id: 'tool_approval_approve',
          value: expect.stringMatching(/^tool:a:/),
        }),
        expect.objectContaining({
          action_id: 'tool_approval_always',
          value: expect.stringMatching(/^tool:l:/),
        }),
        expect.objectContaining({
          action_id: 'tool_approval_deny',
          value: expect.stringMatching(/^tool:d:/),
        }),
      ],
    })
    streamCalls[0].fireTerminal({ taskId: 'task-slack-button-1', status: 'cancelled' })
  })

  it('renders a shell card keyboard with once, command, and shell instead of tool:l', async () => {
    streamCalls.length = 0
    const editMessage = vi.fn<ChannelAdapter['editMessage']>(async () => undefined)
    const adapter: ChannelAdapter = {
      channelType: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => 'tg-status-shell-1'),
      editMessage,
    }
    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-shell-keyboard-1',
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-shell-keyboard-1',
          requestId: 'approval-shell-keyboard-1',
          userId: '516801777',
          notification:
            'Tool `shell_exec` requires approval. Parameters: {"command":"ls"}. Reply /approve or /deny to this message.',
          shellCard: { channelCommandOffered: true, desktopCommandOffered: false },
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

    await reader.handleMessages([makeMessage('ls', 'msg-shell-keyboard')])
    streamCalls[0].fireSuspended({
      taskId: 'task-shell-keyboard-1',
      requestId: 'approval-shell-keyboard-1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      reason: 'approval_required',
      shellCard: { channelCommandOffered: true, desktopCommandOffered: false },
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    const approvalEdit = editMessage.mock.calls.find(call => call[2].includes('{"command":"ls"}'))
    expect(approvalEdit?.[2]).toContain('/approve allows this command once.')
    expect(approvalEdit?.[3]?.telegramInlineKeyboard).toEqual([
      [
        expect.objectContaining({
          text: 'Allow once',
          callbackData: expect.stringMatching(/^tool:a:/),
        }),
        expect.objectContaining({ text: 'Deny', callbackData: expect.stringMatching(/^tool:d:/) }),
      ],
      [
        expect.objectContaining({
          text: 'Allow this command',
          callbackData: expect.stringMatching(/^tool:c:/),
        }),
      ],
      [
        expect.objectContaining({
          text: 'Always allow shell',
          callbackData: expect.stringMatching(/^tool:s:/),
        }),
      ],
    ])
    const callbacks = (approvalEdit?.[3]?.telegramInlineKeyboard ?? []).flatMap(row =>
      row.map(button => button.callbackData)
    )
    expect(callbacks.some(callback => callback.startsWith('tool:l:'))).toBe(false)
    for (const callback of callbacks) {
      expect(Buffer.byteLength(callback, 'utf8')).toBeLessThanOrEqual(64)
    }
    streamCalls[0].fireTerminal({ taskId: 'task-shell-keyboard-1', status: 'cancelled' })
  })

  it('routes a Teams tool button through the original runtime conversation', async () => {
    streamCalls.length = 0
    const editMessage = vi.fn<ChannelAdapter['editMessage']>(async () => undefined)
    const adapter: ChannelAdapter = {
      channelType: 'teams',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => 'teams-status-1'),
      editMessage,
    }
    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-teams-button-1',
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-teams-button-1',
          requestId: 'approval-teams-button-1',
          userId: 'teams-user-1',
          notification: 'HTTP search requires approval.',
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
      adapters: new Map([['teams', adapter]]),
      channels: [],
      sleep: async () => undefined,
    })

    await reader.handleMessages([makeTeamsMessage('Search the web')])
    streamCalls[0].fireSuspended({
      taskId: 'task-teams-button-1',
      requestId: 'approval-teams-button-1',
      toolName: 'http_request',
      displayName: 'HTTP search',
      reason: 'approval_required',
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    const approvalEdit = editMessage.mock.calls.find(
      call => call[2] === 'HTTP search requires approval.'
    )
    const approveAction = approvalEdit?.[3]?.teamsActions?.find(
      action => action.title === 'Approve'
    )
    expect(approveAction?.value).toMatch(/^tool:a:[A-Za-z0-9_-]{16}$/)

    await reader.handleMessages([
      makeTeamsMessage(approveAction!.value, {
        channelId: '19:channel-1@thread.tacv2',
        messageId: 'button-activity-1',
        providerIdentity: {
          medium: 'teams',
          providerUserId: 'teams-user-1',
          providerWorkspaceId: 'tenant-1',
          providerChannelId: '19:channel-1@thread.tacv2',
          providerChannelType: 'channel',
          providerEventId: 'teams:tenant-1:conversation-1:button-activity-1',
        },
      }),
    ])

    expect(rpcClient.sendApproval).toHaveBeenCalledWith(
      'teams-user-1',
      'approval-teams-button-1',
      false,
      'teams',
      '19:channel-1@thread.tacv2;messageid=root-post-1',
      { shellAction: 'once' }
    )
    expect(editMessage).toHaveBeenCalledWith(
      '19:channel-1@thread.tacv2;messageid=root-post-1',
      'teams-status-1',
      'Approved. Processing...',
      { runId: 'task-teams-button-1' }
    )
    streamCalls[0].fireTerminal({ taskId: 'task-teams-button-1', status: 'cancelled' })
  })

  it('does not let a slow Teams progress edit overwrite the terminal response', async () => {
    streamCalls.length = 0
    let releaseProgressEdit!: () => void
    const progressEditBlocked = new Promise<void>(resolve => {
      releaseProgressEdit = resolve
    })
    const editedContents: string[] = []
    const editMessage = vi.fn<ChannelAdapter['editMessage']>(
      async (_channelId, _messageId, content) => {
        editedContents.push(content)
        if (editedContents.length === 1) await progressEditBlocked
      }
    )
    const adapter: ChannelAdapter = {
      channelType: 'teams',
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => 'teams-status-race-1'),
      editMessage,
    }
    const rpcClient = {
      healthCheck: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'pending' as const,
        taskId: 'task-teams-race-1',
      })),
      getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
      getTaskResult: vi.fn(async () => ({
        success: true,
        status: 'completed' as const,
        response: 'The final World Cup answer.',
      })),
      sendApproval: vi.fn(),
      sendDenial: vi.fn(),
      sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
      getCronResults: vi.fn(async () => []),
      acknowledgeCronResult: vi.fn(),
    }
    const reader = new ChannelReader({
      rpcClient,
      adapters: new Map([['teams', adapter]]),
      channels: [],
      sleep: async () => undefined,
    })

    await reader.handleMessages([makeTeamsMessage('How is the World Cup going?')])
    const stream = streamCalls[0]
    const completedStep: import('../src/types').ProgressStep = {
      toolCallId: 'tool-1',
      toolName: 'memory_search',
      displayName: 'Memory search',
      intentSummary: 'Search memory',
      iteration: 1,
      stepIndex: 1,
      totalSteps: 1,
      state: 'completed',
      durationMs: 6,
    }
    stream.fireProgress([completedStep])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(editMessage).toHaveBeenCalledTimes(1)

    stream.fireTerminal({ taskId: 'task-teams-race-1', status: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(editMessage).toHaveBeenCalledTimes(1)

    releaseProgressEdit()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(editedContents).toHaveLength(2)
    expect(editedContents[1]).toContain('The final World Cup answer.')

    stream.fireProgress([{ ...completedStep, toolCallId: 'tool-late' }])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(editedContents).toHaveLength(2)
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
