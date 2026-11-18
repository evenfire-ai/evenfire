import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RPCClient } from '../src/rpcClient'
import type { ChannelAdapter, CommunicationChannelCRD, Message, ProgressStep } from '../src/types'

// A task that ends while its tool approval is delivered, or while an approval
// whose text could not be read is denied. The user-facing texts are written
// out here so that a change to them fails these tests.

interface StreamCall {
  taskId: string
  fireSuspended: (data: unknown) => Promise<void>
  fireTerminal: (data: unknown) => Promise<void>
  fireError: (msg: string) => Promise<void>
  fireProgress: (steps: ProgressStep[]) => void
  closed: boolean
  /** What the stream reports as its steps; a test may push to it. */
  steps: ProgressStep[]
}
const streamCalls: StreamCall[] = []

vi.mock('../src/progressClient', () => ({
  createProgressStream: (options: import('../src/progressClient').ProgressStreamOptions) => {
    const entry: StreamCall = {
      taskId: options.taskId,
      fireSuspended: options.onSuspended as never,
      fireTerminal: options.onTerminal as never,
      fireError: options.onError as never,
      fireProgress: options.onProgress as never,
      closed: false,
      steps: [],
    }
    streamCalls.push(entry)
    return {
      close: () => {
        entry.closed = true
      },
      get steps() {
        return entry.steps
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
  vi.restoreAllMocks()
})

const DENIED =
  'This approval request could not be shown here, so it was not offered for approval and the action was denied. Nothing was changed.'
const NO_PENDING =
  'No pending approval found. Send a message first that triggers a tool requiring approval.'
const INSTRUCTION = 'Reply /approve or /deny to this message.'
const SENDER = '516801777'
const CHANNEL_ID = 'tg-chat-1'

/** A one-message delete card, in the shape mcp-host renders it. */
const SHORT = [
  'Delete these files permanently:',
  'upload: "notes.txt" — 1.2 KB (1,234 bytes), created 2026-11-10 09:12:45 UTC',
  'Total files: 1',
  INSTRUCTION,
].join('\n')

let eventSeq = 0
function messageFor(content: string): Message {
  eventSeq += 1
  return {
    channelType: 'telegram',
    channelId: CHANNEL_ID,
    sender: SENDER,
    content,
    timestamp: new Date('2026-11-14T12:00:00.000Z'),
    messageId: `tg-msg-${eventSeq}`,
  }
}

function telegramChannel(): CommunicationChannelCRD {
  return {
    name: 'chatllm-telegram',
    namespace: 'channels',
    spec: {
      hostRef: 'chatllm',
      telegram: [{ channelId: CHANNEL_ID, userIds: [SENDER] }],
    },
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}

type SendHook = (content: string) => Promise<string | undefined>

/**
 * A Telegram adapter that records every call. Message ids are
 * `telegram-msg-<n>`, n counting sendMessage calls from 1; a hook replaces the
 * n-th call. An edit hold delays the first editMessage call with that content
 * until its gate opens, and calls `entered` when that call starts.
 */
function recordingAdapter() {
  const hooks = new Map<number, SendHook>()
  const editFailures = new Set<string>()
  const editHolds = new Map<string, { gate: Promise<void>; entered: () => void }>()
  let calls = 0
  const sendMessage = vi.fn<ChannelAdapter['sendMessage']>(async (_channelId, content) => {
    calls += 1
    const hook = hooks.get(calls)
    if (hook) return hook(content)
    return `telegram-msg-${calls}`
  })
  const editMessage = vi.fn<ChannelAdapter['editMessage']>(
    async (_channelId, messageId, content) => {
      const hold = editHolds.get(content)
      if (hold) {
        editHolds.delete(content)
        hold.entered()
        await hold.gate
      }
      if (editFailures.has(messageId)) throw new Error('provider refused the edit')
    }
  )
  const adapter: ChannelAdapter = {
    channelType: 'telegram',
    connect: vi.fn(),
    disconnect: vi.fn(),
    fetchMessages: vi.fn(async () => []),
    sendMessage,
    editMessage,
  }
  return { adapter, sendMessage, editMessage, hooks, editFailures, editHolds }
}

function rpcClientFor(taskId: string, notification: string) {
  const rpc = {
    healthCheck: vi.fn<RPCClient['healthCheck']>(async () => true),
    sendMessage: vi.fn<RPCClient['sendMessage']>(async () => ({
      success: true,
      status: 'pending' as const,
      taskId,
    })),
    getBaseUrl: vi.fn<RPCClient['getBaseUrl']>(() => 'http://mcp-host.test'),
    getTaskResult: vi.fn<RPCClient['getTaskResult']>(async () => ({
      success: true,
      status: 'waiting_approval' as const,
      approval: { taskId, requestId: `approval-${taskId}`, userId: SENDER, notification },
    })),
    sendApproval: vi.fn<RPCClient['sendApproval']>(async () => ({ success: true })),
    sendDenial: vi.fn<RPCClient['sendDenial']>(async () => ({ success: true })),
    sendWorkflowApprovalDecision: vi.fn<RPCClient['sendWorkflowApprovalDecision']>(async () => ({
      success: true,
    })),
    getCronResults: vi.fn<RPCClient['getCronResults']>(async () => []),
    acknowledgeCronResult: vi.fn<RPCClient['acknowledgeCronResult']>(async () => undefined),
    // Not reached by these flows; a call fails the test that made it.
    resolveWorkflowApproval: vi.fn<RPCClient['resolveWorkflowApproval']>(
      unexpectedRpcCall('resolveWorkflowApproval')
    ),
    fetchDeliveries: vi.fn<RPCClient['fetchDeliveries']>(unexpectedRpcCall('fetchDeliveries')),
    acknowledge: vi.fn<RPCClient['acknowledge']>(unexpectedRpcCall('acknowledge')),
    fail: vi.fn<RPCClient['fail']>(unexpectedRpcCall('fail')),
    confirmTelegramChallenge: vi.fn<RPCClient['confirmTelegramChallenge']>(
      unexpectedRpcCall('confirmTelegramChallenge')
    ),
  }
  return rpc
}

function unexpectedRpcCall(name: string) {
  return async (): Promise<never> => {
    throw new Error(`unexpected RPC call in this test: ${name}`)
  }
}

/** Starts a Telegram task on the progress flow; the approval is offered on `suspend()`. */
async function startAsync(notification: string, taskId: string) {
  streamCalls.length = 0
  const rec = recordingAdapter()
  const rpc = rpcClientFor(taskId, notification)
  const reader = new ChannelReader({
    rpcClient: rpc,
    adapters: new Map([['telegram', rec.adapter]]),
    channels: [telegramChannel()],
    sleep: async () => undefined,
  })
  await reader.handleMessages([messageFor('clean up my files')])
  expect(streamCalls).toHaveLength(1)
  const stream = streamCalls[0]!
  // Witness that the adapter is live: the status bubble was sent.
  expect(rec.sendMessage.mock.calls[0]?.[1]).toBe('⏳ Processing your request...')
  return {
    reader,
    rec,
    rpc,
    stream,
    suspend: () =>
      stream.fireSuspended({
        taskId,
        requestId: `approval-${taskId}`,
        displayName: 'Delete kept files',
        reason: 'approval_required',
      }),
    send: (content: string) => reader.handleMessages([messageFor(content)]),
    end: async () => {
      await stream.fireTerminal({ taskId, status: 'cancelled' })
    },
  }
}

type Started = Awaited<ReturnType<typeof startAsync>>
type Recorder = ReturnType<typeof recordingAdapter>

function sentContents(rec: Recorder): string[] {
  return rec.sendMessage.mock.calls.map(call => call[1])
}

function errorLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(args =>
    args.map(arg => (arg instanceof Error ? arg.message : String(arg))).join(' ')
  )
}

function silenceErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined)
}

/** The edits of the status bubble, the first message sent. */
function bubbleEdits(rec: Recorder): string[] {
  return rec.editMessage.mock.calls
    .filter(call => call[1] === 'telegram-msg-1')
    .map(call => call[2])
}

/** Settles until `done` holds, at most `rounds` times. */
async function settleUntil(done: () => boolean, rounds = 25): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) await settle()
}

/** Holds the first bubble edit with `content`; `entered` resolves when it starts. */
function holdEdit(h: Started, content: string) {
  const held = gate()
  const entered = gate()
  h.rec.editHolds.set(content, { gate: held.promise, entered: entered.release })
  return { release: held.release, entered: entered.promise }
}

/** The approval fetch of `onSuspended` answers with `notification` once released. */
function holdFetch(h: Started, taskId: string, notification: string) {
  const held = gate()
  h.rpc.getTaskResult.mockImplementationOnce(async () => {
    await held.promise
    return {
      success: true,
      status: 'waiting_approval' as const,
      approval: { taskId, requestId: `approval-${taskId}`, userId: SENDER, notification },
    }
  })
  return held
}

/** The Host's stored result from now on: the task completed with `response`. */
function completeWith(h: Started, response?: string) {
  h.rpc.getTaskResult.mockResolvedValue({
    success: true,
    status: 'completed' as const,
    ...(response === undefined ? {} : { response }),
  } as never)
}

function logged(spy: { mock: { calls: unknown[][] } }, text: string): boolean {
  return spy.mock.calls.some(call => String(call[0]).includes(text))
}

function noticeSent(rec: Recorder): boolean {
  return sentContents(rec).some(content => content.includes('could not be shown'))
}

describe('a denial of an approval whose text could not be read, while the task ends', () => {
  it('A44 sends no notice when the task is cancelled while the refusal is denied', async () => {
    silenceErrors()
    for (const answer of [
      { row: 'accepted', result: { success: true } },
      { row: 'rejected', result: { success: false } },
    ]) {
      const taskId = `task-a44-${answer.row}`
      const h = await startAsync(SHORT, taskId)
      h.rpc.getTaskResult.mockRejectedValueOnce(new Error('approval fetch failed'))
      const held = gate()
      h.rpc.sendDenial.mockImplementationOnce(async () => {
        await held.promise
        return answer.result
      })
      void h.suspend()
      await settle()
      // Witness: the refusal sent its denial before the cancel.
      expect.soft(h.rpc.sendDenial, `A44(${answer.row}) denial sent`).toHaveBeenCalledTimes(1)
      await h.end()
      held.release()
      await settle()

      expect
        .soft(bubbleEdits(h.rec), `A44(${answer.row}) cancel shown`)
        .toContain('Request cancelled.')
      expect.soft(noticeSent(h.rec), `A44(${answer.row}) no notice`).toBe(false)
      expect
        .soft(h.rec.sendMessage, `A44(${answer.row}) only the bubble sent`)
        .toHaveBeenCalledTimes(1)
    }
  })

  it('A54 tells the user when the accepted denial of an unread approval completes the task first', async () => {
    silenceErrors()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const h = await startAsync(SHORT, 'task-a54')
    h.rpc.getTaskResult.mockRejectedValueOnce(new Error('approval fetch failed'))
    const finalText = 'Tool kept_files_delete was denied by the user.'
    h.rpc.sendDenial.mockImplementationOnce(async () => {
      // The Host completes the task, and its final text is written, before the deny call answers.
      completeWith(h, finalText)
      await h.stream.fireTerminal({ taskId: 'task-a54', status: 'completed' })
      return { success: true }
    })
    void h.suspend()
    await settleUntil(() => sentContents(h.rec).includes(DENIED))

    expect(h.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(sentContents(h.rec).filter(content => content === DENIED)).toHaveLength(1)
    expect(bubbleEdits(h.rec).at(-1)).toBe(finalText)
  })

  it('A55 sends no notice when the denial is rejected after the task completed', async () => {
    silenceErrors()
    const h = await startAsync(SHORT, 'task-a55')
    h.rpc.getTaskResult.mockRejectedValueOnce(new Error('approval fetch failed'))
    const finalText = 'Finished without the approval.'
    h.rpc.sendDenial.mockImplementationOnce(async () => {
      completeWith(h, finalText)
      await h.stream.fireTerminal({ taskId: 'task-a55', status: 'completed' })
      return { success: false }
    })
    void h.suspend()
    await settleUntil(() => bubbleEdits(h.rec).includes(finalText))
    await settle()

    // Witnesses: the denial was sent and the final text was written.
    expect(h.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(bubbleEdits(h.rec).at(-1)).toBe(finalText)
    expect(noticeSent(h.rec)).toBe(false)
  })

  it('A55b sends no notice when the denial is rejected while the final result is written', async () => {
    silenceErrors()
    const h = await startAsync(SHORT, 'task-a55b')
    h.rpc.getTaskResult.mockRejectedValueOnce(new Error('approval fetch failed'))
    const finalText = 'Finished without the approval.'
    const finalEdit = holdEdit(h, finalText)
    h.rpc.sendDenial.mockImplementationOnce(async () => {
      completeWith(h, finalText)
      void h.stream.fireTerminal({ taskId: 'task-a55b', status: 'completed' })
      // The Host answers while the final edit is in flight.
      await finalEdit.entered
      return { success: false }
    })
    void h.suspend()
    await settleUntil(() => h.rpc.sendDenial.mock.calls.length > 0)
    await settle()
    await settle()
    finalEdit.release()
    await settle()
    await settle()

    // Witnesses: the denial was sent and the final text was written after the release.
    expect(h.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(bubbleEdits(h.rec).at(-1)).toBe(finalText)
    expect(noticeSent(h.rec)).toBe(false)
  })

  it('A55c sends no denial when the approval fetch fails while the final result is written', async () => {
    const errors = silenceErrors()
    const h = await startAsync(SHORT, 'task-a55c')
    const fetchHeld = gate()
    h.rpc.getTaskResult.mockImplementationOnce(async () => {
      await fetchHeld.promise
      throw new Error('approval fetch failed')
    })
    void h.suspend()
    await settle()
    const finalText = 'Finished without the approval.'
    completeWith(h, finalText)
    const finalEdit = holdEdit(h, finalText)
    void h.stream.fireTerminal({ taskId: 'task-a55c', status: 'completed' })
    await finalEdit.entered
    fetchHeld.release()
    await settle()
    await settle()
    finalEdit.release()
    await settle()
    await settle()

    // Witnesses: the failed fetch was logged and the final text was written.
    expect(
      errorLines(errors).some(line =>
        line.includes('Failed to fetch approval notification for task task-a55c')
      )
    ).toBe(true)
    expect(bubbleEdits(h.rec).at(-1)).toBe(finalText)
    expect(h.rpc.sendDenial).not.toHaveBeenCalled()
    expect(noticeSent(h.rec)).toBe(false)
  })

  it('A56 sends no notice when an accepted denial is followed by an error result', async () => {
    // A pin: the Host completes an accepted denial with a success result.
    silenceErrors()
    const h = await startAsync(SHORT, 'task-a56')
    h.rpc.getTaskResult.mockRejectedValueOnce(new Error('approval fetch failed'))
    h.rpc.sendDenial.mockImplementationOnce(async () => {
      h.rpc.getTaskResult.mockResolvedValue({
        success: false,
        status: 'completed' as const,
        error: {
          code: 'tool_failed',
          message: 'the tool failed',
          retryable: false,
          provider: 'host',
        },
      } as never)
      await h.stream.fireTerminal({ taskId: 'task-a56', status: 'completed' })
      return { success: true }
    })
    void h.suspend()
    await settleUntil(() => bubbleEdits(h.rec).includes('Error: the tool failed'))
    await settle()

    // Witnesses: the error is on the bubble and the denial was sent.
    expect(bubbleEdits(h.rec).at(-1)).toBe('Error: the tool failed')
    expect(h.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(noticeSent(h.rec)).toBe(false)
  })
})

describe('a one-message approval of a task that already ended', () => {
  it('A52b treats a task whose final delivery failed as ended while the result is retried', async () => {
    silenceErrors()
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const h = await startAsync(SHORT, 'task-a52b')
    const fetchHeld = holdFetch(h, 'task-a52b', SHORT)
    void h.suspend()
    await settle()
    const finalText = 'Finished without the approval.'
    completeWith(h, finalText)
    // The final edit and its fallback send (call 2) both throw.
    h.rec.editFailures.add('telegram-msg-1')
    h.rec.hooks.set(2, async () => {
      throw new Error('provider refused the message')
    })
    await h.stream.fireTerminal({ taskId: 'task-a52b', status: 'completed' })
    // Witnesses: the final edit and the fallback send were attempted.
    expect(bubbleEdits(h.rec)).toContain(finalText)
    expect(h.rec.sendMessage.mock.calls[1]?.[1]).toBe(finalText)
    fetchHeld.release()
    await settle()

    // Witness: the one-message branch ran after the task ended.
    expect(
      logged(logs, 'Tool approval needed (task: task-a52b, request: approval-task-a52b)')
    ).toBe(true)
    expect(h.rec.editMessage.mock.calls.some(call => call[2] === SHORT)).toBe(false)
    expect(h.rec.sendMessage).toHaveBeenCalledTimes(2)
    await h.send('/approve')
    expect(sentContents(h.rec).at(-1)).toBe(NO_PENDING)
    expect(h.rpc.sendApproval).not.toHaveBeenCalled()

    // End the result poll the failure started: the retry delivers the final text.
    h.rec.editFailures.delete('telegram-msg-1')
    await h.stream.fireTerminal({ taskId: 'task-a52b', status: 'completed' })
    expect(bubbleEdits(h.rec).at(-1)).toBe(finalText)
  })

  it('A65 writes no one-message card when the task completed while the approval was fetched', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    silenceErrors()
    const h = await startAsync(SHORT, 'task-a65')
    const fetchHeld = holdFetch(h, 'task-a65', SHORT)
    void h.suspend()
    await settle()
    const finalText = 'Finished without the approval.'
    completeWith(h, finalText)
    const finalEdit = holdEdit(h, finalText)
    void h.stream.fireTerminal({ taskId: 'task-a65', status: 'completed' })
    await finalEdit.entered
    fetchHeld.release()
    await settle()
    finalEdit.release()
    await settle()
    await settle()

    // Witnesses: the one-message branch ran, and the final text was written.
    expect(logged(logs, 'Tool approval needed (task: task-a65, request: approval-task-a65)')).toBe(
      true
    )
    expect(bubbleEdits(h.rec)).toContain(finalText)
    expect(bubbleEdits(h.rec)).toEqual([finalText])
    await h.send('/approve')
    expect(sentContents(h.rec).at(-1)).toBe(NO_PENDING)
    expect(h.rpc.sendApproval).not.toHaveBeenCalled()
  })

  it('A66 writes no one-message card and registers nothing when the task was cancelled first', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    silenceErrors()
    const h = await startAsync(SHORT, 'task-a66')
    const fetchHeld = holdFetch(h, 'task-a66', SHORT)
    void h.suspend()
    await settle()
    await h.end()
    fetchHeld.release()
    await settle()
    await settle()

    // Witnesses: the one-message branch ran after the cancel reached the bubble.
    expect(logged(logs, 'Tool approval needed (task: task-a66, request: approval-task-a66)')).toBe(
      true
    )
    expect(bubbleEdits(h.rec)).toContain('Request cancelled.')
    expect(bubbleEdits(h.rec).at(-1)).toBe('Request cancelled.')
    expect(h.rec.editMessage.mock.calls.some(call => call[2] === SHORT)).toBe(false)
    await h.send('/approve')
    expect(sentContents(h.rec).at(-1)).toBe(NO_PENDING)
    expect(h.rpc.sendApproval).not.toHaveBeenCalled()
  })
})
