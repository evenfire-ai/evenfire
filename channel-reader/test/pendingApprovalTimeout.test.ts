import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChannelAdapter, CommunicationChannelCRD, Message } from '../src/types'

interface StreamCall {
  fireSuspended: (data: import('../src/progressClient').SuspendedEventData) => void
}
const streamCalls: StreamCall[] = []

vi.mock('../src/progressClient', () => ({
  createProgressStream: (options: import('../src/progressClient').ProgressStreamOptions) => {
    streamCalls.push({ fireSuspended: options.onSuspended })
    return {
      close: () => undefined,
      get steps() {
        return []
      },
    }
  },
}))

let ChannelReader: typeof import('../src/main').ChannelReader
let DEFAULT_APPROVAL_TIMEOUT_MS: number

beforeAll(async () => {
  process.env.CLERUM_DEV_MODE = 'true'
  delete process.env.CLERUM_APPROVAL_TIMEOUT
  ;({ ChannelReader } = await import('../src/main'))
  ;({ DEFAULT_APPROVAL_TIMEOUT_MS } = await import('../src/config'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

function makeMessage(content: string, messageId: string): Message {
  return {
    channelType: 'telegram',
    channelId: 'tg-chat-1',
    sender: '516801777',
    content,
    timestamp: new Date('2026-11-12T12:00:00.000Z'),
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

async function suspendedReader(options: { approvalTimeoutMs?: number } = {}) {
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
      taskId: 'task-timeout-1',
    })),
    getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
    getTaskResult: vi.fn(async () => ({
      success: true,
      status: 'waiting_approval' as const,
      approval: {
        taskId: 'task-timeout-1',
        requestId: 'approval-timeout-A',
        userId: '516801777',
        notification: 'Tool A requires approval. Reply /approve or /deny.',
      },
    })),
    sendApproval: vi.fn(async () => ({ success: true })),
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
    ...options,
  })

  await reader.handleMessages([makeMessage('run the gated tool', 'msg-start')])
  expect(streamCalls).toHaveLength(1)
  streamCalls[0].fireSuspended({
    taskId: 'task-timeout-1',
    requestId: 'approval-timeout-A',
    toolName: 'tool-a',
    displayName: 'Tool A',
    reason: 'approval_required',
  })
  await new Promise(r => setTimeout(r, 20))

  return { reader, rpcClient, sentReplies }
}

/** Runs the poll-cycle sweep as if `elapsedMs` had passed since the approval prompt. */
function sweepAfter(reader: InstanceType<typeof ChannelReader>, elapsedMs: number): void {
  const realNow = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(realNow + elapsedMs)
  ;(reader as unknown as { cleanupStaleApprovals(): void }).cleanupStaleApprovals()
  vi.restoreAllMocks()
}

describe('pending tool approval lifetime (CLERUM_APPROVAL_TIMEOUT)', () => {
  it('defaults to 7 days, the same default as mcp-host', () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(7 * DAY_MS)
  })

  it('keeps the approval answerable after 10 minutes by default', async () => {
    const { reader, rpcClient } = await suspendedReader()

    sweepAfter(reader, 10 * MINUTE_MS + 1000)
    await reader.handleMessages([makeMessage('/approve', 'msg-approve')])

    expect(rpcClient.sendApproval).toHaveBeenCalledWith(
      '516801777',
      'approval-timeout-A',
      false,
      'telegram',
      'tg-chat-1'
    )
  })

  it('drops the approval once the default 7 days have passed', async () => {
    const { reader, rpcClient, sentReplies } = await suspendedReader()

    sweepAfter(reader, 7 * DAY_MS + 1000)
    await reader.handleMessages([makeMessage('/approve', 'msg-approve')])

    // Liveness witness: the command reached handleApprovalCommand and answered.
    expect(sentReplies).toContain(
      'No pending approval found. Send a message first that triggers a tool requiring approval.'
    )
    expect(rpcClient.sendApproval).not.toHaveBeenCalled()
  })

  it('honours a configured timeout', async () => {
    const { reader, rpcClient, sentReplies } = await suspendedReader({ approvalTimeoutMs: 1000 })

    sweepAfter(reader, 2000)
    await reader.handleMessages([makeMessage('/deny', 'msg-deny')])

    expect(sentReplies).toContain(
      'No pending approval found. Send a message first that triggers a tool requiring approval.'
    )
    expect(rpcClient.sendDenial).not.toHaveBeenCalled()
  })

  it('never drops the approval when the timeout is 0', async () => {
    const { reader, rpcClient } = await suspendedReader({ approvalTimeoutMs: 0 })

    sweepAfter(reader, 30 * DAY_MS)
    await reader.handleMessages([makeMessage('/deny', 'msg-deny')])

    expect(rpcClient.sendDenial).toHaveBeenCalledWith(
      '516801777',
      'approval-timeout-A',
      'telegram',
      'tg-chat-1'
    )
  })
})
