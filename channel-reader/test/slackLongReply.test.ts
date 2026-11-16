import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChannelAdapter, Message } from '../src/types'

vi.mock('../src/progressClient', () => ({
  createProgressStream: () => ({
    close: vi.fn(),
    get steps() {
      return []
    },
  }),
}))

let ChannelReader: typeof import('../src/main').ChannelReader

beforeAll(async () => {
  process.env.CLERUM_DEV_MODE = 'true'
  ;({ ChannelReader } = await import('../src/main'))
})

function slackMessage(content: string): Message {
  return {
    channelType: 'slack',
    channelId: 'D123',
    sender: 'U123',
    content,
    timestamp: new Date('2026-11-16T04:43:00.000Z'),
    messageId: '1710000000.000001',
    providerIdentity: {
      medium: 'slack',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'D123',
      providerEventId: 'slack:T123:D123:1710000000.000001',
    },
  }
}

function reader(options: {
  response?: string
  pending?: boolean
  edit?: ChannelAdapter['editMessage']
  send?: ChannelAdapter['sendMessage']
  runTimeoutMs?: number
}) {
  const cancelTask = vi.fn(async () => undefined)
  const rpc = {
    sendMessage: vi.fn(async () => ({
      success: true,
      status: 'pending' as const,
      taskId: 'task-long',
    })),
    getTaskResult: vi.fn(async () =>
      options.pending
        ? { success: true, status: 'pending' as const }
        : { success: true, status: 'completed' as const, response: options.response ?? 'ok' }
    ),
    getBaseUrl: () => 'http://mcp-host.test',
    cancelTask,
  }
  const editMessage = options.edit ?? vi.fn(async () => undefined)
  const sendMessage = options.send ?? vi.fn(async () => 'status-1')
  const adapter: ChannelAdapter = {
    channelType: 'slack',
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    fetchMessages: vi.fn(async () => []),
    sendMessage,
    editMessage,
  }
  const instance = new ChannelReader({
    rpcClient: rpc as never,
    notificationDeliveryClient: null,
    adapters: new Map(),
    runTimeoutMs: options.runTimeoutMs ?? 60_000,
  })
  return { instance, rpc, editMessage, sendMessage, cancelTask, adapter }
}

describe('Slack long replies', () => {
  it('edits the acknowledgement with the first chunk and posts the rest', async () => {
    vi.useFakeTimers()
    const text = `${'review '.repeat(900)}end`
    const { instance, editMessage, sendMessage, cancelTask, adapter } = reader({ response: text })
    const handle = instance as unknown as {
      handleMessageWithProgress(message: Message, channelAdapter: ChannelAdapter): Promise<void>
    }

    try {
      await handle.handleMessageWithProgress(slackMessage('Write a long answer'), adapter)
      await vi.advanceTimersByTimeAsync(2_000)

      const edited = editMessage.mock.calls.map(call => String(call[2]))
      const posted = sendMessage.mock.calls
        .map(call => String(call[1]))
        .filter(value => !value.includes('Processing'))
      expect(edited[0]?.length).toBeLessThanOrEqual(4_000)
      expect([edited[0], ...posted].join('')).toBe(text)
      expect(posted.length).toBeGreaterThan(0)
      expect(cancelTask).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('edits an error and cancels the task when Slack rejects the reply', async () => {
    vi.useFakeTimers()
    const editMessage = vi.fn(async (_channelId: string, _messageId: string, content: string) => {
      if (content.includes("couldn't finish")) return
      throw Object.assign(new Error('msg_too_long'), { data: { error: 'msg_too_long' } })
    })
    const sendMessage = vi.fn(async (_channelId: string, content: string) => {
      if (content.includes('Processing') || content.includes("couldn't finish")) return 'status-1'
      throw Object.assign(new Error('msg_too_long'), { data: { error: 'msg_too_long' } })
    })
    const { instance, cancelTask, adapter } = reader({
      response: 'hello from the model',
      edit: editMessage,
      send: sendMessage,
    })
    const handle = instance as unknown as {
      handleMessageWithProgress(message: Message, channelAdapter: ChannelAdapter): Promise<void>
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await handle.handleMessageWithProgress(slackMessage('hello'), adapter)
      await vi.advanceTimersByTimeAsync(2_000)

      expect(editMessage.mock.calls.map(call => String(call[2])).at(-1)).toContain(
        "couldn't finish this request (Slack msg_too_long)"
      )
      expect(cancelTask).toHaveBeenCalledWith(
        'task-long',
        expect.objectContaining({ channelType: 'slack' })
      )
      const logged = consoleError.mock.calls.map(call => String(call[0])).join('\n')
      expect(logged).toContain('task-long')
      expect(logged).toContain('msg_too_long')
    } finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it('edits a timeout error and cancels the task when the run does not finish', async () => {
    vi.useFakeTimers()
    const { instance, editMessage, cancelTask, adapter } = reader({
      pending: true,
      runTimeoutMs: 25,
    })
    const handle = instance as unknown as {
      handleMessageWithProgress(message: Message, channelAdapter: ChannelAdapter): Promise<void>
    }

    try {
      await handle.handleMessageWithProgress(slackMessage('Write a long answer'), adapter)
      await vi.advanceTimersByTimeAsync(2_100)

      const edited = editMessage.mock.calls.map(call => String(call[2]))
      expect(edited.at(-1)).toContain("couldn't finish this request (timed out)")
      expect(cancelTask).toHaveBeenCalledWith(
        'task-long',
        expect.objectContaining({ sender: 'U123' })
      )
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
