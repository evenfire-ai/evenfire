import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { SendMessageOptions } from '../src/types'
import type { ChannelAdapter, Message } from '../src/types'
import {
  ChannelReader,
  makeChannel,
  makeMessage,
  makeRpcClient,
} from './communicationChannelApprovalHarness'

interface StreamCall {
  taskId: string
  fireSuspended: (data: import('../src/progressClient').SuspendedEventData) => void
  fireTerminal: (data: import('../src/progressClient').TerminalEventData) => void
}

const streamCalls: StreamCall[] = []

vi.mock('../src/progressClient', () => ({
  createProgressStream: (options: import('../src/progressClient').ProgressStreamOptions) => {
    const entry: StreamCall = {
      taskId: options.taskId,
      fireSuspended: options.onSuspended,
      fireTerminal: options.onTerminal,
    }
    streamCalls.push(entry)
    return {
      close: () => undefined,
      get steps() {
        return []
      },
    }
  },
}))

beforeAll(async () => {
  process.env.CLERUM_DEV_MODE = 'true'
})

const OFFERED = { channelCommandOffered: true, desktopCommandOffered: false }
const NOTIFICATION =
  'Tool `shell_exec` requires approval. Parameters: {"command":"pwd"}. Reply /approve or /deny to this message.'
const unknownActionCode = 'abcdefghijklmnop'

function callbackValues(options: SendMessageOptions | undefined): string[] {
  const values: string[] = []
  for (const row of options?.telegramInlineKeyboard ?? []) {
    for (const button of row) values.push(button.callbackData)
  }
  for (const block of options?.slackBlocks ?? []) {
    if (block.type !== 'actions') continue
    for (const element of block.elements) values.push(element.value)
  }
  for (const action of options?.teamsActions ?? []) values.push(action.value)
  return values
}

function assertNoCommandCode(values: string[]): void {
  expect(values.some(value => /^tool:c:/.test(value))).toBe(false)
  for (const value of values) expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(64)
}

function slackMessage(content: string, messageId = '1710000000.000010'): Message {
  return {
    channelType: 'slack',
    channelId: 'C123',
    sender: 'U123',
    content,
    timestamp: new Date('2026-05-12T12:00:00.000Z'),
    messageId,
    providerIdentity: {
      medium: 'slack',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: `slack:T123:C123:${messageId}`,
    },
  }
}

function capturingAdapter(channelType: ChannelAdapter['channelType']) {
  const sent: Array<{ content: string; options?: SendMessageOptions }> = []
  const edits: Array<{ content: string; options?: SendMessageOptions }> = []
  const adapter: ChannelAdapter = {
    channelType,
    connect: vi.fn(),
    disconnect: vi.fn(),
    fetchMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async (_channelId, content, _replyTo, _attachments, options) => {
      sent.push({ content, options })
      return `status-${sent.length}`
    }),
    editMessage: vi.fn(async (_channelId, _messageId, content, options) => {
      edits.push({ content, options })
    }),
  }
  return { adapter, sent, edits }
}

describe('shell card approval handler', () => {
  it.each([
    ['telegram', 'command'],
    ['telegram', 'shell'],
    ['slack', 'command'],
    ['slack', 'shell'],
  ] as const)('inbound %s tool action calls sendApproval with %s', async (channel, shellAction) => {
    const code = shellAction === 'command' ? 'c' : 's'
    const { adapter, sent } = capturingAdapter(channel)
    const rpc = makeRpcClient({
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-inbound',
          requestId: 'approval-inbound',
          userId: channel === 'slack' ? 'U123' : '123456',
          notification: NOTIFICATION,
          shellCard: OFFERED,
        },
      })),
      sendApproval: vi.fn(async () => ({ success: true })),
      sendDenial: vi.fn(async () => ({ success: true })),
    })
    const reader = new ChannelReader({
      rpcClient: rpc,
      adapters: new Map([[channel, adapter]]),
      channels: channel === 'telegram' ? [makeChannel()] : [],
      sleep: async () => undefined,
    })
    const source = channel === 'slack' ? slackMessage('pwd') : makeMessage('pwd')

    await reader.handleMessages([source])
    const action = callbackValues(sent.at(-1)?.options).find(value =>
      value.startsWith(`tool:${code}:`)
    )
    expect(action).toBeDefined()

    const decision =
      channel === 'slack'
        ? slackMessage(action!, '1710000000.000011')
        : { ...makeMessage(action!), messageId: `choice-${code}` }
    await reader.handleMessages([decision])

    expect(rpc.sendApproval).toHaveBeenCalledWith(
      channel === 'slack' ? 'U123' : '123456',
      'approval-inbound',
      false,
      channel,
      channel === 'slack' ? 'C123' : 'telegram-chat-1',
      { shellAction }
    )
    expect(rpc.sendDenial).not.toHaveBeenCalled()
  })

  it('a Teams shell card offers Approve and Deny only', async () => {
    const { adapter, sent } = capturingAdapter('teams')
    const rpc = makeRpcClient({
      sendMessage: vi.fn(async () => ({
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-teams',
          requestId: 'approval-teams',
          userId: 'teams-user',
          notification: NOTIFICATION,
          shellCard: OFFERED,
        },
      })),
    })
    const reader = new ChannelReader({
      rpcClient: rpc,
      adapters: new Map([['teams', adapter]]),
      channels: [],
      sleep: async () => undefined,
    })
    await reader.handleMessages([
      {
        channelType: 'teams',
        channelId: '19:channel@thread.tacv2',
        sender: 'teams-user',
        content: 'pwd',
        timestamp: new Date('2026-05-12T12:00:00.000Z'),
        messageId: 'teams-msg-1',
      },
    ])
    const values = callbackValues(sent.at(-1)?.options)
    expect(values.some(value => value.startsWith('tool:a:'))).toBe(true)
    expect(values.some(value => value.startsWith('tool:c:'))).toBe(true)
    expect(values.some(value => value.startsWith('tool:s:'))).toBe(true)
    expect(values.some(value => value.startsWith('tool:d:'))).toBe(true)
    const titles = sent.at(-1)?.options?.teamsActions?.map(action => action.title)
    expect(titles).toEqual(['Allow once', 'Allow this command', 'Always allow shell', 'Deny'])
  })

  it('rejects an unknown code without sendDenial', async () => {
    const { adapter } = capturingAdapter('slack')
    const rpc = makeRpcClient({
      sendApproval: vi.fn(async () => ({ success: true })),
      sendDenial: vi.fn(async () => ({ success: true })),
    })
    const reader = new ChannelReader({
      rpcClient: rpc,
      adapters: new Map([['slack', adapter]]),
      channels: [],
      sleep: async () => undefined,
    })

    await reader.handleMessages([slackMessage(`tool:q:${unknownActionCode}`)])

    expect(rpc.sendDenial).not.toHaveBeenCalled()
    expect(rpc.sendApproval).not.toHaveBeenCalled()
    expect(rpc.sendMessage).not.toHaveBeenCalled()
  })

  it.each(['slack', 'telegram'] as const)(
    'omits c on a rendered %s card when channelCommandOffered is false',
    async channel => {
      streamCalls.length = 0
      const { adapter, edits } = capturingAdapter(channel)
      const rpc = makeRpcClient({
        sendMessage: vi.fn(async () => ({
          success: true,
          status: 'pending' as const,
          taskId: `task-flag-${channel}`,
        })),
        getTaskResult: vi.fn(async () => ({
          success: true,
          status: 'waiting_approval' as const,
          approval: {
            taskId: `task-flag-${channel}`,
            requestId: `approval-flag-${channel}`,
            userId: channel === 'slack' ? 'U123' : '123456',
            notification: NOTIFICATION,
            shellCard: { channelCommandOffered: false, desktopCommandOffered: true },
          },
        })),
      })
      const reader = new ChannelReader({
        rpcClient: rpc,
        adapters: new Map([[channel, adapter]]),
        channels: channel === 'telegram' ? [makeChannel()] : [],
        sleep: async () => undefined,
      })
      const source =
        channel === 'slack' ? slackMessage('pwd', '1710000000.000020') : makeMessage('pwd')

      await reader.handleMessages([source])
      streamCalls[0]!.fireSuspended({
        taskId: `task-flag-${channel}`,
        requestId: `approval-flag-${channel}`,
        toolName: 'shell_exec',
        displayName: 'Shell',
        reason: 'approval_required',
        shellCard: { channelCommandOffered: false, desktopCommandOffered: true },
      })
      await new Promise(resolve => setTimeout(resolve, 20))

      const prompt = edits.find(edit => edit.content.includes('{"command":"pwd"}'))
      const values = callbackValues(prompt?.options)
      assertNoCommandCode(values)
      expect(values.some(value => value.startsWith('tool:s:'))).toBe(true)
      expect(values.some(value => value.startsWith('tool:l:'))).toBe(false)
      streamCalls[0]!.fireTerminal({ taskId: `task-flag-${channel}`, status: 'cancelled' })
    }
  )

  it.each([
    ['slack', 'generic fallback'],
    ['telegram', 'generic fallback'],
    ['slack', 'lookup miss'],
    ['telegram', 'lookup miss'],
    ['slack', 'thrown lookup'],
    ['telegram', 'thrown lookup'],
  ] as const)(
    'omits c for a %s %s even when channelCommandOffered is true',
    async (channel, scenario) => {
      streamCalls.length = 0
      const taskId = `task-${channel}-${scenario.replace(/\s+/g, '-')}`
      const { adapter, edits } = capturingAdapter(channel)
      const getTaskResult = vi.fn(async () => {
        if (scenario === 'thrown lookup') throw new Error('approval lookup failed')
        if (scenario === 'lookup miss') return { success: false, status: 'pending' as const }
        return {
          success: true,
          status: 'waiting_approval' as const,
          approval: {
            taskId,
            requestId: `approval-${taskId}`,
            userId: channel === 'slack' ? 'U123' : '123456',
            notification: '',
            shellCard: OFFERED,
          },
        }
      })
      const rpc = makeRpcClient({
        sendMessage: vi.fn(async () => ({
          success: true,
          status: 'pending' as const,
          taskId,
        })),
        getTaskResult,
      })
      const reader = new ChannelReader({
        rpcClient: rpc,
        adapters: new Map([[channel, adapter]]),
        channels: channel === 'telegram' ? [makeChannel()] : [],
        sleep: async () => undefined,
      })
      const source =
        channel === 'slack'
          ? slackMessage('pwd', `1710000000.00003${scenario.length}`)
          : makeMessage(`pwd ${scenario}`)

      await reader.handleMessages([source])
      streamCalls[0]!.fireSuspended({
        taskId,
        requestId: `approval-${taskId}`,
        toolName: 'shell_exec',
        displayName: 'Shell',
        reason: 'approval_required',
        shellCard: OFFERED,
      })
      await new Promise(resolve => setTimeout(resolve, 30))

      const prompt = edits.find(
        edit => edit.options?.slackBlocks || edit.options?.telegramInlineKeyboard
      )
      expect(prompt).toBeDefined()
      expect(prompt?.content).not.toContain('{"command":"pwd"}')
      expect(prompt?.content).toContain('requires approval')
      assertNoCommandCode(callbackValues(prompt?.options))
      expect(callbackValues(prompt?.options).some(value => value.startsWith('tool:s:'))).toBe(true)
      expect(callbackValues(prompt?.options).some(value => value.startsWith('tool:l:'))).toBe(false)
      streamCalls[0]!.fireTerminal({ taskId, status: 'cancelled' })
    }
  )
})
