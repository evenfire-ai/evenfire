import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChannelAdapter, Message } from '../src/types'

interface CapturedStream {
  onProgress: import('../src/progressClient').ProgressStreamOptions['onProgress']
  onActivity?: () => void
  onSuspended: import('../src/progressClient').ProgressStreamOptions['onSuspended']
  onTerminal: import('../src/progressClient').ProgressStreamOptions['onTerminal']
}
const streamCalls: CapturedStream[] = []
const deliveredSteps: Array<{ displayName: string; state: 'success' }> = []

vi.mock('../src/progressClient', () => ({
  createProgressStream: (options: import('../src/progressClient').ProgressStreamOptions) => {
    streamCalls.push({
      onProgress: options.onProgress,
      onActivity: options.onActivity,
      onSuspended: options.onSuspended,
      onTerminal: options.onTerminal,
    })
    return {
      close: vi.fn(),
      get steps() {
        return deliveredSteps
      },
    }
  },
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
  getTaskResult?: () => Promise<unknown>
}) {
  const cancelTask = vi.fn(async () => undefined)
  const rpc = {
    sendMessage: vi.fn(async () => ({
      success: true,
      status: 'pending' as const,
      taskId: 'task-long',
    })),
    getTaskResult: vi.fn(
      options.getTaskResult ??
        (async () =>
          options.pending
            ? { success: true, status: 'pending' as const }
            : { success: true, status: 'completed' as const, response: options.response ?? 'ok' })
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

function progressHandle(instance: InstanceType<typeof ChannelReader>) {
  return instance as unknown as {
    handleMessageWithProgress(message: Message, channelAdapter: ChannelAdapter): Promise<void>
  }
}

describe('Slack long replies', () => {
  afterEach(() => {
    streamCalls.length = 0
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('edits the acknowledgement with the first chunk and posts the rest', async () => {
    vi.useFakeTimers()
    const prose = `${'review '.repeat(520)}\n`
    const fence = '```\n' + 'const alpha = 1\n'.repeat(40) + '```\n'
    const text = `${prose}${fence}${'tail '.repeat(200)}`
    expect(text.slice(0, 4_000).includes(fence)).toBe(false)
    const { instance, editMessage, sendMessage, cancelTask, adapter } = reader({ response: text })
    const handle = progressHandle(instance)

    await handle.handleMessageWithProgress(slackMessage('Write a long answer'), adapter)
    await vi.advanceTimersByTimeAsync(2_000)

    const processingId = await sendMessage.mock.results[0]!.value
    expect(editMessage.mock.calls.length).toBeGreaterThan(0)
    for (const call of editMessage.mock.calls) {
      expect(call[1]).toBe(processingId)
    }
    const lastEdit = String(editMessage.mock.calls.at(-1)?.[2])
    const posted = sendMessage.mock.calls.slice(1).map(call => String(call[1]))
    expect(lastEdit.length).toBeLessThanOrEqual(4_000)
    expect(lastEdit).not.toBe(text.slice(0, 4_000))
    expect([lastEdit, ...posted].join('')).toBe(text)
    expect([lastEdit, ...posted].some(part => part.includes(fence))).toBe(true)
    expect(posted.length).toBeGreaterThan(0)
    expect(cancelTask).not.toHaveBeenCalled()
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
    const handle = progressHandle(instance)
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
    }
  })

  it('keeps a long Slack answer intact when tool steps are present', async () => {
    vi.useFakeTimers()
    const response = `${'word '.repeat(1_200)}TAIL`
    deliveredSteps.push({ displayName: 'Read', state: 'success' })
    const { instance, editMessage, sendMessage, adapter } = reader({ response })
    const handle = progressHandle(instance)
    try {
      await handle.handleMessageWithProgress(slackMessage('long'), adapter)
      await vi.advanceTimersByTimeAsync(2_000)
      const posted = [
        ...editMessage.mock.calls.map(call => String(call[2])),
        ...sendMessage.mock.calls.map(call => String(call[1])),
      ].join('')
      expect(posted).toContain('TAIL')
      expect(posted.endsWith('...')).toBe(false)
    } finally {
      deliveredSteps.length = 0
    }
  })

  it('cancels a paused approval at the poll deadline when the host stays down', async () => {
    vi.useFakeTimers()
    const { instance, editMessage, cancelTask, adapter } = reader({
      runTimeoutMs: 60 * 60 * 1000,
      getTaskResult: async () => {
        throw new Error('host_unreachable')
      },
    })
    const handle = progressHandle(instance)
    await handle.handleMessageWithProgress(slackMessage('Run a long tool'), adapter)
    await streamCalls.at(-1)!.onSuspended({
      taskId: 'task-long',
      requestId: 'approval-1',
      toolName: 'shell_exec',
      displayName: 'Shell',
      reason: 'approval_required',
    })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(cancelTask).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(21 * 60 * 1000)
    expect(editMessage.mock.calls.map(call => String(call[2])).join('\n')).toContain(
      "couldn't finish this request (timed out)"
    )
    expect(cancelTask).toHaveBeenCalled()
  }, 30_000)

  it('does not cancel a run the host still reports as pending', async () => {
    vi.useFakeTimers()
    const runTimeoutMs = 5_000
    let hostDown = false
    const { instance, editMessage, cancelTask, adapter } = reader({
      runTimeoutMs,
      getTaskResult: async () => {
        if (hostDown) throw new Error('host_unreachable')
        return { success: true, status: 'pending' as const }
      },
    })
    const handle = progressHandle(instance)

    await handle.handleMessageWithProgress(slackMessage('still working'), adapter)
    await vi.advanceTimersByTimeAsync(runTimeoutMs * 4)

    expect(editMessage.mock.calls.map(call => String(call[2])).join('\n')).not.toContain(
      "couldn't finish this request (timed out)"
    )
    expect(cancelTask).not.toHaveBeenCalled()

    hostDown = true
    await vi.advanceTimersByTimeAsync(runTimeoutMs + 1_000)
    expect(editMessage.mock.calls.map(call => String(call[2])).join('\n')).toContain(
      "couldn't finish this request (timed out)"
    )
  })

  it('retries a Teams answer when the first send throws', async () => {
    vi.useFakeTimers()
    let answerEdits = 0
    const editMessage = vi.fn(async (_channelId: string, _messageId: string, content: string) => {
      if (content !== 'Teams answer') return
      answerEdits += 1
      if (answerEdits === 1) {
        await new Promise(resolve => setTimeout(resolve, 3_000))
        throw new Error('teams_activity_edit_failed_500')
      }
    })
    const sendMessage = vi.fn(async (_channelId: string, content: string) => {
      if (content === 'Teams answer') throw new Error('teams_activity_failed_500')
      return 'status-1'
    })
    const { instance, cancelTask, adapter } = reader({
      response: 'Teams answer',
      edit: editMessage,
      send: sendMessage,
      runTimeoutMs: 60_000,
    })
    const handle = progressHandle(instance)
    const message = slackMessage('hello')
    message.channelType = 'teams'

    await handle.handleMessageWithProgress(message, adapter)
    const terminal = streamCalls.at(-1)!.onTerminal({ taskId: 'task-long', status: 'completed' })
    await vi.advanceTimersByTimeAsync(8_000)
    await terminal

    const posted = editMessage.mock.calls.map(call => String(call[2]))
    expect(posted.filter(text => text === 'Teams answer').length).toBeGreaterThan(1)
    expect(posted.at(-1)).toBe('Teams answer')
    expect(posted.some(text => text.includes("couldn't finish"))).toBe(false)
    expect(cancelTask).not.toHaveBeenCalled()
  })

  it('shows a timeout while the host is down and posts the answer when it returns', async () => {
    vi.useFakeTimers()
    const runTimeoutMs = 5_000
    let hostUp = false
    const { instance, editMessage, sendMessage, cancelTask, adapter } = reader({
      runTimeoutMs,
      getTaskResult: async () => {
        if (!hostUp) throw new Error('host_unreachable')
        return { success: true, status: 'completed' as const, response: 'Late answer' }
      },
    })
    const handle = progressHandle(instance)

    await handle.handleMessageWithProgress(slackMessage('Write a long answer'), adapter)
    const processingId = await sendMessage.mock.results[0]!.value
    await vi.advanceTimersByTimeAsync(runTimeoutMs - 1_000)
    expect(editMessage.mock.calls.map(call => String(call[2])).join('\n')).not.toContain(
      "couldn't finish this request (timed out)"
    )

    await vi.advanceTimersByTimeAsync(2_000)
    const timeoutEdit = editMessage.mock.calls.find(call =>
      String(call[2]).includes("couldn't finish this request (timed out)")
    )
    expect(timeoutEdit?.[1]).toBe(processingId)
    expect(cancelTask).not.toHaveBeenCalled()

    hostUp = true
    await vi.advanceTimersByTimeAsync(2_000)
    expect(editMessage.mock.calls.map(call => String(call[2])).at(-1)).toContain('Late answer')
    expect(cancelTask).not.toHaveBeenCalled()
  })

  it('ends an approval at the poll deadline when every later host read fails', async () => {
    vi.useFakeTimers()
    const runTimeoutMs = 5 * 60 * 1000
    let hostDown = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { instance, editMessage, cancelTask, adapter } = reader({
      runTimeoutMs,
      getTaskResult: async () => {
        if (hostDown) throw new Error('host_unreachable')
        return {
          success: true,
          status: 'waiting_approval' as const,
          approval: {
            taskId: 'task-long',
            requestId: 'approval-1',
            userId: 'U123',
            notification: 'Tool `shell_exec` requires approval.',
          },
        }
      },
    })
    const handle = progressHandle(instance)

    try {
      await handle.handleMessageWithProgress(slackMessage('Run a long tool'), adapter)
      const stream = streamCalls.at(-1)
      expect(stream?.onSuspended).toEqual(expect.any(Function))
      expect(stream?.onActivity).toEqual(expect.any(Function))
      await stream!.onSuspended({
        taskId: 'task-long',
        requestId: 'approval-1',
        toolName: 'shell_exec',
        displayName: 'Shell',
        reason: 'approval_required',
      })
      stream!.onActivity?.()
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

      const duringApproval = editMessage.mock.calls.map(call => String(call[2])).join('\n')
      expect(duringApproval).toContain('Tool `shell_exec` requires approval.')
      expect(duringApproval).not.toContain("couldn't finish this request (timed out)")
      expect(cancelTask).not.toHaveBeenCalled()

      hostDown = true
      await vi.advanceTimersByTimeAsync(21 * 60 * 1000)

      expect(editMessage.mock.calls.map(call => String(call[2])).join('\n')).toContain(
        "couldn't finish this request (timed out)"
      )
      expect(cancelTask).toHaveBeenCalledWith(
        'task-long',
        expect.objectContaining({ channelType: 'slack' })
      )
    } finally {
      warn.mockRestore()
    }
  }, 30_000)

  it('posts a completed answer when it arrives at the poll deadline', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const { instance, editMessage, cancelTask, adapter } = reader({
      runTimeoutMs: 60 * 60 * 1000,
      getTaskResult: async () => {
        if (Date.now() - startedAt < 30 * 60 * 1000) {
          return { success: true, status: 'pending' as const }
        }
        return { success: true, status: 'completed' as const, response: 'Saved answer' }
      },
    })
    const handle = progressHandle(instance)
    await handle.handleMessageWithProgress(slackMessage('Still working'), adapter)
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    expect(editMessage.mock.calls.map(call => String(call[2])).join('\n')).toContain('Saved answer')
    expect(editMessage.mock.calls.map(call => String(call[2])).join('\n')).not.toContain(
      "couldn't finish this request (timed out)"
    )
    expect(cancelTask).not.toHaveBeenCalled()
  }, 30_000)

  it('ends a pending run when the poll deadline is reached', async () => {
    vi.useFakeTimers()
    const getTaskResult = vi.fn(async () => ({ success: true, status: 'pending' as const }))
    const { instance, editMessage, cancelTask, adapter } = reader({
      getTaskResult,
      runTimeoutMs: 60 * 60 * 1000,
    })
    const handle = progressHandle(instance)

    await handle.handleMessageWithProgress(slackMessage('Still working'), adapter)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(getTaskResult).toHaveBeenCalled()
    expect(cancelTask).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(21 * 60 * 1000)
    expect(editMessage.mock.calls.map(call => String(call[2])).join('\n')).toContain(
      "couldn't finish this request (timed out)"
    )
    expect(cancelTask).toHaveBeenCalled()
  }, 30_000)

  it('treats heartbeats as activity when result polls are failing', async () => {
    vi.useFakeTimers()
    const runTimeoutMs = 5 * 60 * 1000
    const { instance, editMessage, cancelTask, adapter } = reader({
      runTimeoutMs,
      getTaskResult: async () => {
        throw new Error('host_unreachable')
      },
    })
    const handle = progressHandle(instance)

    await handle.handleMessageWithProgress(slackMessage('Run shell_exec'), adapter)
    const stream = streamCalls.at(-1)!
    expect(stream.onActivity).toEqual(expect.any(Function))

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    stream.onActivity!()
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    stream.onActivity!()
    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(editMessage.mock.calls.map(call => String(call[2])).join('\n')).not.toContain(
      "couldn't finish this request (timed out)"
    )
    expect(cancelTask).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(runTimeoutMs + 1_000)
    expect(editMessage.mock.calls.map(call => String(call[2])).join('\n')).toContain(
      "couldn't finish this request (timed out)"
    )
    expect(cancelTask).not.toHaveBeenCalled()
  })

  it('does not let the silence timer replace an answer that is already being delivered', async () => {
    vi.useFakeTimers()
    const answer = 'Short answer ready.'
    const editMessage = vi.fn(async (_channelId: string, _messageId: string, content: string) => {
      if (content === answer) await new Promise(resolve => setTimeout(resolve, 200))
    })
    const { instance, sendMessage, cancelTask, adapter } = reader({
      runTimeoutMs: 50,
      getTaskResult: () =>
        new Promise(resolve => {
          setTimeout(() => {
            resolve({ success: true, status: 'completed', response: answer })
          }, 10)
        }),
      edit: editMessage,
    })
    const handle = progressHandle(instance)

    await handle.handleMessageWithProgress(slackMessage('answer now'), adapter)
    const processingId = await sendMessage.mock.results[0]!.value
    const stream = streamCalls.at(-1)!
    const terminal = stream.onTerminal({ taskId: 'task-long', status: 'completed' })
    await vi.advanceTimersByTimeAsync(30)
    const cancelled = stream.onTerminal({
      taskId: 'task-long',
      status: 'cancelled',
      reason: 'user_requested',
    })
    await vi.advanceTimersByTimeAsync(500)
    await terminal
    await cancelled

    const edits = editMessage.mock.calls.filter(call => call[1] === processingId)
    expect(String(edits.at(-1)?.[2])).toBe(answer)
    expect(edits.some(call => String(call[2]).includes("couldn't finish"))).toBe(false)
    expect(edits.some(call => String(call[2]).includes('Request cancelled'))).toBe(false)
    expect(cancelTask).not.toHaveBeenCalled()
  })

  it('keeps the timeout apology when it wins before the result is known', async () => {
    vi.useFakeTimers()
    let resolveResult: (value: unknown) => void = () => undefined
    const { instance, editMessage, sendMessage, cancelTask, adapter } = reader({
      runTimeoutMs: 50,
      getTaskResult: () =>
        new Promise(resolve => {
          resolveResult = resolve
        }),
    })
    const handle = progressHandle(instance)

    await handle.handleMessageWithProgress(slackMessage('answer later'), adapter)
    const processingId = await sendMessage.mock.results[0]!.value
    const terminal = streamCalls.at(-1)!.onTerminal({ taskId: 'task-long', status: 'completed' })
    await vi.advanceTimersByTimeAsync(80)

    resolveResult({ success: true, status: 'completed', response: 'late answer' })
    await terminal
    await vi.advanceTimersByTimeAsync(50)

    const edits = editMessage.mock.calls
      .filter(call => call[1] === processingId)
      .map(call => String(call[2]))
    expect(edits.at(-1)).toBe('late answer')
    expect(edits.some(text => text.includes("couldn't finish"))).toBe(false)
    expect(cancelTask).not.toHaveBeenCalled()
  })

  it('cancels when a follow-up post returns no ts and keeps the first chunk', async () => {
    vi.useFakeTimers()
    const text = `${'review '.repeat(900)}end`
    const sendMessage = vi.fn(async (_channelId: string, content: string) => {
      if (content.includes('Processing') || content.includes("couldn't finish")) return 'status-1'
      return undefined
    })
    const { instance, editMessage, cancelTask, adapter } = reader({
      response: text,
      send: sendMessage,
    })
    const handle = progressHandle(instance)

    await handle.handleMessageWithProgress(slackMessage('Write a long answer'), adapter)
    await vi.advanceTimersByTimeAsync(2_000)

    const processingId = await sendMessage.mock.results[0]!.value
    const edits = editMessage.mock.calls
      .filter(call => call[1] === processingId)
      .map(call => String(call[2]))
    expect(edits.at(-1)?.length).toBeLessThanOrEqual(4_000)
    expect(edits.at(-1)).not.toContain("couldn't finish")
    expect(
      sendMessage.mock.calls
        .map(call => String(call[1]))
        .some(value => value.includes("couldn't finish"))
    ).toBe(true)
    expect(cancelTask).toHaveBeenCalledWith(
      'task-long',
      expect.objectContaining({ channelType: 'slack' })
    )
  })
})
