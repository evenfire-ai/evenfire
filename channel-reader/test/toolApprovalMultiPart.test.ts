import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatProgressUpdate } from '../src/progressFormatter'
import type { ChannelAdapter, CommunicationChannelCRD, Message, ProgressStep } from '../src/types'

// Tool approvals longer than one message of the channel: sent as several
// messages, the controls on the last, registered only after the last was sent.
// Limits and user-facing texts are written out here so that this file also
// loads against code without the splitter.

interface StreamCall {
  taskId: string
  fireSuspended: (data: unknown) => Promise<void>
  fireTerminal: (data: unknown) => Promise<void>
  fireError: (msg: string) => Promise<void>
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
let SlackAdapter: typeof import('../src/channels/slack').SlackAdapter
let TelegramAdapter: typeof import('../src/channels/telegram').TelegramAdapter

beforeAll(async () => {
  process.env.CLERUM_DEV_MODE = 'true'
  ;({ ChannelReader } = await import('../src/main'))
  ;({ SlackAdapter } = await import('../src/channels/slack'))
  ;({ TelegramAdapter } = await import('../src/channels/telegram'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const DENIED =
  'This approval request could not be shown here in full, so it was not offered for approval and the action was denied. Nothing was changed.'
const STILL_WAITING =
  'This approval request could not be shown here in full, so it cannot be approved here. It is still waiting on the Host; ask an operator to deny it.'
const NO_PENDING =
  'No pending approval found. Send a message first that triggers a tool requiring approval.'
const POINTER = 'Approval needed. The request is in the messages below.'
const INSTRUCTION = 'Reply /approve or /deny to this message.'
const TELEGRAM_LIMIT = 4096
const SLACK_LIMIT = 3000
const TEAMS_LIMIT_BYTES = 12_000

type ChannelKind = 'telegram' | 'slack' | 'teams'
const SENDER: Record<ChannelKind, string> = {
  telegram: '516801777',
  slack: 'U123',
  teams: 'teams-user-1',
}
const CHANNEL_ID: Record<ChannelKind, string> = {
  telegram: 'tg-chat-1',
  slack: 'C123',
  teams: '19:channel-1@thread.tacv2;messageid=root-post-1',
}

let eventSeq = 0
function messageFor(channelType: ChannelKind, content: string): Message {
  eventSeq += 1
  const timestamp = new Date('2026-11-14T12:00:00.000Z')
  if (channelType === 'telegram') {
    return {
      channelType,
      channelId: CHANNEL_ID.telegram,
      sender: SENDER.telegram,
      content,
      timestamp,
      messageId: `tg-msg-${eventSeq}`,
    }
  }
  if (channelType === 'slack') {
    return {
      channelType,
      channelId: CHANNEL_ID.slack,
      sender: SENDER.slack,
      content,
      timestamp,
      messageId: `1710000000.${String(eventSeq).padStart(6, '0')}`,
      providerIdentity: {
        medium: 'slack',
        providerUserId: SENDER.slack,
        providerWorkspaceId: 'T123',
        providerChannelId: CHANNEL_ID.slack,
        providerEventId: `slack:T123:C123:${eventSeq}`,
      },
    }
  }
  return {
    channelType,
    channelId: CHANNEL_ID.teams,
    sender: SENDER.teams,
    content,
    timestamp,
    messageId: `activity-${eventSeq}`,
    threadId: 'root-post-1',
    providerIdentity: {
      medium: 'teams',
      providerUserId: SENDER.teams,
      providerWorkspaceId: 'tenant-1',
      providerChannelId: '19:channel-1@thread.tacv2',
      providerChannelType: 'channel',
      providerEventId: `teams:tenant-1:conversation-1:activity-${eventSeq}`,
    },
  }
}

function telegramChannel(): CommunicationChannelCRD {
  return {
    name: 'chatllm-telegram',
    namespace: 'channels',
    spec: {
      hostRef: 'chatllm',
      telegram: [{ channelId: CHANNEL_ID.telegram, userIds: [SENDER.telegram] }],
    },
  }
}

/** One line of a kept-files delete card, in the shape mcp-host renders it. */
function fileLine(name: string): string {
  return `upload: "${name}" — 9.0 PB (9,007,199,254,740,991 bytes), created 2026-11-10 09:12:45 UTC`
}

function deleteCard(names: string[]): string {
  return [
    'Delete these files permanently:',
    ...names.map(fileLine),
    `Total files: ${names.length}`,
    INSTRUCTION,
  ].join('\n')
}

/** Distinct ASCII names of `length` characters. */
function asciiNames(count: number, length: number, prefix = 'f'): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${prefix}${String(i).padStart(2, '0')}-${'n'.repeat(length - prefix.length - 3)}`
  )
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function teamsBytes(part: string): number {
  return Buffer.byteLength(JSON.stringify(part), 'utf8')
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

interface AdapterEvent {
  kind: 'send' | 'edit'
  call?: number
  messageId?: string
  content: string
}

/**
 * An adapter that records every call. Message ids are `<channel>-msg-<n>`, n
 * counting sendMessage calls from 1; a hook replaces the n-th call. An edit
 * hold delays the first editMessage call with that content until its gate
 * opens, and calls `entered` when that call starts.
 */
function recordingAdapter(channelType: ChannelKind) {
  const events: AdapterEvent[] = []
  const hooks = new Map<number, SendHook>()
  const editFailures = new Set<string>()
  const editHolds = new Map<string, { gate: Promise<void>; entered: () => void }>()
  let calls = 0
  const sendMessage = vi.fn<ChannelAdapter['sendMessage']>(async (_channelId, content) => {
    calls += 1
    const call = calls
    events.push({ kind: 'send', call, content })
    const hook = hooks.get(call)
    if (hook) return hook(content)
    return `${channelType}-msg-${call}`
  })
  const editMessage = vi.fn<ChannelAdapter['editMessage']>(
    async (_channelId, messageId, content) => {
      events.push({ kind: 'edit', messageId, content })
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
    channelType,
    connect: vi.fn(),
    disconnect: vi.fn(),
    fetchMessages: vi.fn(async () => []),
    sendMessage,
    editMessage,
  }
  return { adapter, sendMessage, editMessage, events, hooks, editFailures, editHolds }
}

function rpcClientFor(taskId: string, userId: string, notification: string) {
  const current = { requestId: `approval-${taskId}`, notification }
  const rpc = {
    healthCheck: vi.fn(async () => true),
    sendMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      success: true,
      status: 'pending' as const,
      taskId,
    })),
    getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
    getTaskResult: vi.fn(async () => ({
      success: true,
      status: 'waiting_approval' as const,
      approval: {
        taskId,
        requestId: current.requestId,
        userId,
        notification: current.notification,
      },
    })),
    sendApproval: vi.fn(async () => ({ success: true })),
    sendDenial: vi.fn(async () => ({ success: true })),
    sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true })),
    getCronResults: vi.fn(async () => []),
    acknowledgeCronResult: vi.fn(),
  }
  return { rpc, current }
}

/** Starts a task on the progress flow; the approval is offered on `suspend()`. */
async function startAsync(channelType: ChannelKind, notification: string, taskId: string) {
  streamCalls.length = 0
  const rec = recordingAdapter(channelType)
  const { rpc, current } = rpcClientFor(taskId, SENDER[channelType], notification)
  const reader = new ChannelReader({
    rpcClient: rpc,
    adapters: new Map([[channelType, rec.adapter]]),
    channels: channelType === 'telegram' ? [telegramChannel()] : [],
    sleep: async () => undefined,
  })
  await reader.handleMessages([messageFor(channelType, 'clean up my files')])
  expect(streamCalls).toHaveLength(1)
  const stream = streamCalls[0]!
  // Witness that the adapter is live: the status bubble was sent.
  expect(rec.sendMessage.mock.calls[0]?.[1]).toBe('⏳ Processing your request...')
  return {
    reader,
    rec,
    rpc,
    current,
    stream,
    suspend: (requestId = current.requestId) =>
      stream.fireSuspended({
        taskId,
        requestId,
        displayName: 'Delete kept files',
        reason: 'approval_required',
      }),
    send: (content: string) => reader.handleMessages([messageFor(channelType, content)]),
    end: async () => {
      await stream.fireTerminal({ taskId, status: 'cancelled' })
    },
  }
}

/** The approval parts: every sendMessage after the status bubble, as [content, options]. */
function partCalls(rec: ReturnType<typeof recordingAdapter>) {
  return rec.sendMessage.mock.calls.slice(1)
}

function sentContents(rec: ReturnType<typeof recordingAdapter>): string[] {
  return rec.sendMessage.mock.calls.map(call => call[1])
}

function errorLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(args =>
    args.map(arg => (arg instanceof Error ? arg.message : String(arg))).join(' ')
  )
}

function expectErrorWithIdsOnly(
  spy: { mock: { calls: unknown[][] } },
  requestId: string,
  names: string[]
) {
  const lines = errorLines(spy)
  expect(lines.some(line => line.includes(requestId))).toBe(true)
  for (const line of lines) {
    expect(line).not.toContain('upload: "')
    for (const name of names) expect(line).not.toContain(name)
  }
}

function silenceErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined)
}

function lastCallId(rec: ReturnType<typeof recordingAdapter>, channelType: ChannelKind): string {
  return `${channelType}-msg-${rec.sendMessage.mock.calls.length}`
}

function clearEditsOf(rec: ReturnType<typeof recordingAdapter>, messageId: string) {
  return rec.editMessage.mock.calls.filter(call => call[1] === messageId)
}

// Telegram: two parts. Slack: three parts. Teams: one card.
const NAMES_255 = asciiNames(20, 255)
const CARD_255 = deleteCard(NAMES_255)
// Telegram: four parts (names longer than the schema allows).
const NAMES_600 = asciiNames(20, 600, 'g')
const CARD_600 = deleteCard(NAMES_600)
// Teams: five parts. mcp-host renders U+E0001 as the escape `\u{E0001}`.
const TAG_NAME = String.raw`\u{E0001}`.repeat(255)
const CARD_TAG = deleteCard(Array.from({ length: 20 }, () => TAG_NAME))

describe('tool approval over one message, sent as several', () => {
  it('A1 sends a long Telegram approval as parts, the keyboard on the last only', async () => {
    const h = await startAsync('telegram', CARD_255, 'task-a1')
    await h.suspend()
    await settle()

    const parts = partCalls(h.rec)
    expect(parts.length).toBe(2)
    expect(parts.map(call => call[1]).join('\n')).toBe(CARD_255)
    for (const name of NAMES_255) {
      expect(parts.some(call => call[1].includes(fileLine(name)))).toBe(true)
    }
    expect(parts[parts.length - 1]![1]).toContain(`Total files: 20\n${INSTRUCTION}`)
    for (const call of parts) expect(call[1].length).toBeLessThanOrEqual(TELEGRAM_LIMIT)
    const withKeyboard = h.rec.sendMessage.mock.calls.filter(
      call => call[4]?.telegramInlineKeyboard
    )
    expect(withKeyboard).toEqual([parts[parts.length - 1]])
    expect(h.rec.editMessage.mock.calls.filter(call => call[2] === POINTER)).toHaveLength(1)
    expect(h.rec.editMessage.mock.calls.some(call => call[3]?.telegramInlineKeyboard)).toBe(false)
    await h.end()
  })

  it('A2 sends the next part only after the previous one was delivered', async () => {
    const h = await startAsync('telegram', CARD_255, 'task-a2')
    const held = gate()
    h.rec.hooks.set(2, async () => {
      await held.promise
      return 'telegram-msg-2'
    })
    void h.suspend()
    await settle()
    expect(h.rec.sendMessage).toHaveBeenCalledTimes(2)

    held.release()
    await settle()
    expect(h.rec.sendMessage).toHaveBeenCalledTimes(3)
    expect(
      partCalls(h.rec)
        .map(call => call[1])
        .join('\n')
    ).toBe(CARD_255)
    await h.end()
  })

  it('A3 does not accept a typed /approve before the last part was sent', async () => {
    const h = await startAsync('telegram', CARD_255, 'task-a3')
    const held = gate()
    h.rec.hooks.set(3, async () => {
      await held.promise
      return 'telegram-msg-3'
    })
    void h.suspend()
    await settle()
    await h.send('/approve')
    expect(sentContents(h.rec)).toContain(NO_PENDING)
    expect(h.rpc.sendApproval).not.toHaveBeenCalled()

    held.release()
    await settle()
    await h.send('/approve')
    // Witness: the same command works once the last part was sent.
    expect(h.rpc.sendApproval).toHaveBeenCalledTimes(1)
    expect(h.rpc.sendApproval).toHaveBeenCalledWith(
      SENDER.telegram,
      'approval-task-a3',
      false,
      'telegram',
      CHANNEL_ID.telegram
    )
    await h.end()
  })

  it('A4 splits a Slack approval after the escape, the actions block on the last part', async () => {
    const card = deleteCard(Array.from({ length: 20 }, () => '&'.repeat(60)))
    const escaped = escapeSlack(card)
    const h = await startAsync('slack', card, 'task-a4')
    await h.suspend()
    await settle()

    const parts = partCalls(h.rec)
    expect(parts.length).toBe(3)
    expect(parts.map(call => call[1]).join('\n')).toBe(escaped)
    for (const call of parts) expect(call[1].length).toBeLessThanOrEqual(SLACK_LIMIT)
    const last = parts[parts.length - 1]!
    const blocks = last[4]!.slackBlocks!
    expect(blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: last[1] } })
    expect(blocks[1]).toMatchObject({ type: 'actions' })
    for (const call of parts.slice(0, -1)) expect(call[4]).toBeUndefined()
    await h.end()
  })

  it('A5 counts Teams parts in JSON bytes, and keeps one card when it fits', async () => {
    const h = await startAsync('teams', CARD_TAG, 'task-a5')
    await h.suspend()
    await settle()
    const parts = partCalls(h.rec)
    expect(parts.length).toBe(5)
    expect(parts.map(call => call[1]).join('\n')).toBe(CARD_TAG)
    for (const call of parts) expect(teamsBytes(call[1])).toBeLessThanOrEqual(TEAMS_LIMIT_BYTES)
    const withActions = h.rec.sendMessage.mock.calls.filter(call => call[4]?.teamsActions)
    expect(withActions).toEqual([parts[parts.length - 1]])
    await h.end()

    // The single-card row: 20 names of 255 ASCII letters are one edited card.
    expect(teamsBytes(CARD_255)).toBeLessThanOrEqual(TEAMS_LIMIT_BYTES)
    const one = await startAsync('teams', CARD_255, 'task-a5-one')
    await one.suspend()
    await settle()
    expect(one.rec.sendMessage).toHaveBeenCalledTimes(1)
    const cardEdits = one.rec.editMessage.mock.calls.filter(call => call[3]?.teamsActions)
    expect(cardEdits).toHaveLength(1)
    expect(cardEdits[0]![2]).toBe(CARD_255)
    await one.end()
  })

  it('A6 denies and tells the user when a middle part fails', async () => {
    const errors = silenceErrors()
    const h = await startAsync('telegram', CARD_600, 'task-a6')
    h.rec.hooks.set(3, async () => {
      throw new Error('provider refused the message')
    })
    await h.suspend()
    await settle()

    // Witness: part 1 was sent, without controls.
    const first = h.rec.sendMessage.mock.calls[1]!
    expect(CARD_600.startsWith(`${first[1]}\n`)).toBe(true)
    expect(first[4]).toBeUndefined()
    expect(h.rec.sendMessage.mock.calls.some(call => call[4]?.telegramInlineKeyboard)).toBe(false)
    expect(sentContents(h.rec)).toHaveLength(4)
    expect(h.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(h.rpc.sendDenial).toHaveBeenCalledWith(
      SENDER.telegram,
      'approval-task-a6',
      'telegram',
      CHANNEL_ID.telegram
    )
    expect(sentContents(h.rec).at(-1)).toBe(DENIED)
    await h.send('/approve')
    expect(sentContents(h.rec).at(-1)).toBe(NO_PENDING)
    expect(h.rpc.sendApproval).not.toHaveBeenCalled()
    expectErrorWithIdsOnly(errors, 'approval-task-a6', NAMES_600)
    await h.end()
  })

  it('A7 denies and tells the user when the last part fails', async () => {
    const errors = silenceErrors()
    const h = await startAsync('telegram', CARD_255, 'task-a7')
    h.rec.hooks.set(3, async () => {
      throw new Error('provider refused the message')
    })
    await h.suspend()
    await settle()

    const withKeyboard = h.rec.sendMessage.mock.calls.filter(
      call => call[4]?.telegramInlineKeyboard
    )
    // The only call with controls is the one the provider refused.
    expect(withKeyboard).toEqual([h.rec.sendMessage.mock.calls[2]])
    expect(h.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(h.rpc.sendDenial).toHaveBeenCalledWith(
      SENDER.telegram,
      'approval-task-a7',
      'telegram',
      CHANNEL_ID.telegram
    )
    expect(sentContents(h.rec).at(-1)).toBe(DENIED)
    await h.send('/approve')
    expect(sentContents(h.rec).at(-1)).toBe(NO_PENDING)
    expect(h.rpc.sendApproval).not.toHaveBeenCalled()
    expectErrorWithIdsOnly(errors, 'approval-task-a7', NAMES_255)
    await h.end()
  })

  it('A8 treats a part with no message id as not delivered', async () => {
    const errors = silenceErrors()
    const h = await startAsync('telegram', CARD_255, 'task-a8')
    h.rec.hooks.set(2, async () => undefined)
    await h.suspend()
    await settle()

    // Status, part 1 (no id), the notice: part 2 is never sent.
    expect(sentContents(h.rec)).toHaveLength(3)
    expect(h.rec.sendMessage.mock.calls.some(call => call[4]?.telegramInlineKeyboard)).toBe(false)
    expect(h.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(sentContents(h.rec).at(-1)).toBe(DENIED)
    await h.send('/approve')
    expect(sentContents(h.rec).at(-1)).toBe(NO_PENDING)
    expect(h.rpc.sendApproval).not.toHaveBeenCalled()
    expectErrorWithIdsOnly(errors, 'approval-task-a8', NAMES_255)
    await h.end()
  })

  it('A9 denies an approval with a line longer than a Telegram or a Slack message', async () => {
    const overhead = fileLine('').length
    const name = 'r'.repeat(4375 - overhead)
    expect(fileLine(name).length).toBe(4375)
    const card = deleteCard([name])
    for (const channelType of ['telegram', 'slack'] as const) {
      const errors = silenceErrors()
      const h = await startAsync(channelType, card, `task-a9-${channelType}`)
      await h.suspend()
      await settle()

      // Status bubble, then the notice: no part was sent.
      expect(sentContents(h.rec)).toEqual(['⏳ Processing your request...', DENIED])
      expect(h.rpc.sendDenial).toHaveBeenCalledTimes(1)
      expect(h.rpc.sendDenial).toHaveBeenCalledWith(
        SENDER[channelType],
        `approval-task-a9-${channelType}`,
        channelType,
        CHANNEL_ID[channelType]
      )
      expect(h.rec.editMessage.mock.calls.some(call => call[2].includes(name))).toBe(false)
      expectErrorWithIdsOnly(errors, `approval-task-a9-${channelType}`, [name])
      await h.end()
      errors.mockRestore()
    }
  })

  it('A10 says the request is still waiting when mcp-host refuses the denial', async () => {
    silenceErrors()
    const card = deleteCard(['r'.repeat(5000)])
    const h = await startAsync('telegram', card, 'task-a10')
    h.rpc.sendDenial.mockResolvedValueOnce({ success: false })
    await h.suspend()
    await settle()

    expect(h.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(sentContents(h.rec).at(-1)).toBe(STILL_WAITING)
    expect(sentContents(h.rec)).not.toContain(DENIED)
    await h.end()
  })

  it('A11 does not send the parts again when the Slack result poll asks during delivery', async () => {
    vi.useFakeTimers()
    const card = deleteCard(Array.from({ length: 20 }, () => '&'.repeat(60)))
    const escaped = escapeSlack(card)
    const h = await startAsync('slack', card, 'task-a11')
    const held = gate()
    h.rec.hooks.set(2, async () => {
      await held.promise
      return 'slack-msg-2'
    })
    void h.suspend()
    await vi.advanceTimersByTimeAsync(0)
    const before = h.rpc.getTaskResult.mock.calls.length
    await vi.advanceTimersByTimeAsync(6_000)
    // Witness: the poll asked again while the first part was held.
    expect(h.rpc.getTaskResult.mock.calls.length).toBeGreaterThan(before)

    held.release()
    await vi.advanceTimersByTimeAsync(4_000)
    const parts = partCalls(h.rec)
    expect(parts.map(call => call[1]).join('\n')).toBe(escaped)
    expect(parts.filter(call => call[1].startsWith('Delete these files'))).toHaveLength(1)
    await h.end()
    await vi.advanceTimersByTimeAsync(4_000)
  })

  it('A12 sends parts in the synchronous fallback after the progress flow failed', async () => {
    const rec = recordingAdapter('telegram')
    const { rpc } = rpcClientFor('task-a12', SENDER.telegram, CARD_255)
    rpc.sendMessage.mockRejectedValueOnce(new Error('async submit failed')).mockResolvedValueOnce({
      success: true,
      status: 'waiting_approval' as const,
      approval: {
        taskId: 'task-a12',
        requestId: 'approval-task-a12',
        userId: SENDER.telegram,
        notification: CARD_255,
      },
    })
    const reader = new ChannelReader({
      rpcClient: rpc,
      adapters: new Map([['telegram', rec.adapter]]),
      channels: [telegramChannel()],
      sleep: async () => undefined,
    })
    const held = gate()
    rec.hooks.set(2, async () => {
      await held.promise
      return 'telegram-msg-2'
    })
    const first = reader.handleMessages([messageFor('telegram', 'clean up my files')])
    await settle()
    expect(rpc.sendMessage).toHaveBeenCalledTimes(2)
    expect(rpc.sendMessage.mock.calls[0]?.[1]).toMatchObject({ async: true })
    await reader.handleMessages([messageFor('telegram', '/approve')])
    expect(rpc.sendApproval).not.toHaveBeenCalled()
    expect(sentContents(rec)).toContain(NO_PENDING)

    held.release()
    await first
    const parts = rec.sendMessage.mock.calls.slice(0, 2)
    expect(parts.map(call => call[1]).join('\n')).toBe(CARD_255)
    expect(parts[0]![4]).toBeUndefined()
    expect(parts[1]![4]?.telegramInlineKeyboard).toBeDefined()
    await reader.handleMessages([messageFor('telegram', '/approve')])
    expect(rpc.sendApproval).toHaveBeenCalledTimes(1)
  })

  it('A13 sends parts when the async send returned no task id', async () => {
    const rec = recordingAdapter('telegram')
    const { rpc } = rpcClientFor('task-a13', SENDER.telegram, CARD_255)
    rpc.sendMessage.mockResolvedValueOnce({
      success: true,
      status: 'waiting_approval' as const,
      approval: {
        taskId: 'task-a13',
        requestId: 'approval-task-a13',
        userId: SENDER.telegram,
        notification: CARD_255,
      },
    })
    const reader = new ChannelReader({
      rpcClient: rpc,
      adapters: new Map([['telegram', rec.adapter]]),
      channels: [telegramChannel()],
      sleep: async () => undefined,
    })
    const held = gate()
    rec.hooks.set(2, async () => {
      await held.promise
      return 'telegram-msg-2'
    })
    const first = reader.handleMessages([messageFor('telegram', 'clean up my files')])
    await settle()
    expect(rpc.sendMessage).toHaveBeenCalledTimes(1)
    await reader.handleMessages([messageFor('telegram', '/approve')])
    expect(rpc.sendApproval).not.toHaveBeenCalled()
    expect(sentContents(rec)).toContain(NO_PENDING)

    held.release()
    await first
    const parts = rec.sendMessage.mock.calls.slice(0, 2)
    expect(parts.map(call => call[1]).join('\n')).toBe(CARD_255)
    expect(parts[0]![4]).toBeUndefined()
    expect(parts[1]![4]?.telegramInlineKeyboard).toBeDefined()
    await reader.handleMessages([messageFor('telegram', '/approve')])
    expect(rpc.sendApproval).toHaveBeenCalledTimes(1)
  })

  it('A14 removes the controls from the last part after the decision', async () => {
    const h = await startAsync('telegram', CARD_255, 'task-a14')
    await h.suspend()
    await settle()
    const lastId = lastCallId(h.rec, 'telegram')
    const lastText = h.rec.sendMessage.mock.calls.at(-1)![1]
    expect(clearEditsOf(h.rec, lastId)).toHaveLength(0)

    await h.send('/approve')
    const clears = clearEditsOf(h.rec, lastId)
    expect(clears).toHaveLength(1)
    expect(clears[0]!.slice(0, 3)).toEqual([CHANNEL_ID.telegram, lastId, lastText])
    expect(clears[0]![3]).toBeUndefined()
    expect(h.rec.editMessage).toHaveBeenCalledWith(
      CHANNEL_ID.telegram,
      'telegram-msg-1',
      'Approved. Processing...',
      undefined
    )
    await h.end()
  })

  it('A15 keeps one edited message for an approval exactly at the limit', async () => {
    const rows: Array<{ channelType: ChannelKind; notification: string; option: string }> = [
      {
        channelType: 'telegram',
        notification: 'x'.repeat(TELEGRAM_LIMIT),
        option: 'telegramInlineKeyboard',
      },
      { channelType: 'slack', notification: 'y'.repeat(SLACK_LIMIT), option: 'slackBlocks' },
      {
        channelType: 'teams',
        notification: 'z'.repeat(TEAMS_LIMIT_BYTES - 2),
        option: 'teamsActions',
      },
    ]
    expect(teamsBytes(rows[2]!.notification)).toBe(TEAMS_LIMIT_BYTES)
    for (const row of rows) {
      const h = await startAsync(row.channelType, row.notification, `task-a15-${row.channelType}`)
      await h.suspend()
      await settle()
      expect(h.rec.sendMessage).toHaveBeenCalledTimes(1)
      const cardEdits = h.rec.editMessage.mock.calls.filter(
        call => (call[3] as Record<string, unknown> | undefined)?.[row.option]
      )
      expect(cardEdits).toHaveLength(1)
      expect(cardEdits[0]![2]).toBe(row.notification)
      await h.end()
    }
  })

  it('A16 delivers every line through the real Slack and Telegram adapters', async () => {
    for (const count of [9, 20]) {
      streamCalls.length = 0
      const card = deleteCard(asciiNames(count, 255))
      const posts: Array<{
        text: string
        blocks?: Array<{ type: string; text?: { text: string } }>
      }> = []
      const rejected: string[] = []
      const check = (args: {
        text: string
        blocks?: Array<{ type: string; text?: { text: string } }>
      }) => {
        const section = args.blocks?.find(block => block.type === 'section')?.text?.text
        if (section !== undefined && section.length > 3000) {
          rejected.push(`invalid_blocks section=${section.length}`)
          throw new Error('An API error occurred: invalid_blocks')
        }
        if (args.text.length > 4000) {
          rejected.push(`msg_too_long text=${args.text.length}`)
          throw new Error('An API error occurred: msg_too_long')
        }
      }
      const client = {
        chat: {
          postMessage: vi.fn(async (args: { text: string; blocks?: never }) => {
            check(args)
            posts.push(args)
            return { ok: true, ts: `1710000000.${String(posts.length).padStart(6, '0')}` }
          }),
          update: vi.fn(async (args: { text: string; blocks?: never }) => {
            check(args)
            return { ok: true }
          }),
        },
      }
      const adapter = new SlackAdapter()
      ;(adapter as unknown as { client: unknown }).client = client
      const { rpc } = rpcClientFor(`task-a16-slack-${count}`, SENDER.slack, card)
      const reader = new ChannelReader({
        rpcClient: rpc,
        adapters: new Map([['slack', adapter]]),
        channels: [],
        sleep: async () => undefined,
      })
      await reader.handleMessages([messageFor('slack', 'clean up my files')])
      await streamCalls[0]!.fireSuspended({
        taskId: `task-a16-slack-${count}`,
        requestId: `approval-task-a16-slack-${count}`,
        displayName: 'Delete kept files',
        reason: 'approval_required',
      })
      await settle()

      expect(rejected).toEqual([])
      const approvalPosts = posts.slice(1)
      expect(approvalPosts.length).toBeGreaterThan(1)
      expect(approvalPosts.map(post => post.text).join('\n')).toBe(escapeSlack(card))
      const withActions = posts.filter(post => post.blocks?.some(block => block.type === 'actions'))
      expect(withActions).toEqual([approvalPosts[approvalPosts.length - 1]])
      await streamCalls[0]!.fireTerminal({
        taskId: `task-a16-slack-${count}`,
        status: 'cancelled',
      })
    }

    // Telegram: the 20-name card is two messages (the 9-name card fits in one).
    streamCalls.length = 0
    const card = deleteCard(asciiNames(20, 255))
    const sent: Array<{
      text: string
      options: { reply_markup?: { inline_keyboard: unknown[] } }
    }> = []
    const edited: string[] = []
    const adapter = new TelegramAdapter()
    ;(adapter as unknown as { bot: unknown }).bot = {
      api: {
        sendMessage: vi.fn(async (_chat: unknown, text: string, options: never) => {
          sent.push({ text, options })
          return { message_id: sent.length }
        }),
        editMessageText: vi.fn(async (_chat: unknown, _id: unknown, text: string) => {
          edited.push(text)
          return true
        }),
      },
    }
    const { rpc } = rpcClientFor('task-a16-telegram', SENDER.telegram, card)
    const reader = new ChannelReader({
      rpcClient: rpc,
      adapters: new Map([['telegram', adapter]]),
      channels: [telegramChannel()],
      sleep: async () => undefined,
    })
    await reader.handleMessages([messageFor('telegram', 'clean up my files')])
    await streamCalls[0]!.fireSuspended({
      taskId: 'task-a16-telegram',
      requestId: 'approval-task-a16-telegram',
      displayName: 'Delete kept files',
      reason: 'approval_required',
    })
    await settle()

    const approvalSends = sent.slice(1)
    expect(approvalSends.length).toBe(2)
    expect(approvalSends.map(item => item.text).join('\n')).toBe(card)
    for (const item of sent) expect(item.text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT)
    const withKeyboard = sent.filter(
      item => (item.options.reply_markup?.inline_keyboard.length ?? 0) > 0
    )
    expect(withKeyboard).toEqual([approvalSends[approvalSends.length - 1]])
    expect(edited).toContain(POINTER)
    expect(edited.some(text => text.includes('upload: "') || text.includes('Total files'))).toBe(
      false
    )
    await streamCalls[0]!.fireTerminal({ taskId: 'task-a16-telegram', status: 'cancelled' })
  })

  it('A17 denies a Slack approval that needs more than 24 parts', async () => {
    silenceErrors()
    // mcp-host cuts this card at 64 KiB (96 parts measured); uncut it needs more.
    const card = deleteCard(asciiNames(300, 255).map(name => '&'.repeat(name.length)))
    const h = await startAsync('slack', card, 'task-a17')
    await h.suspend()
    await settle()

    expect(sentContents(h.rec)).toEqual(['⏳ Processing your request...', DENIED])
    expect(h.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(h.rpc.sendDenial).toHaveBeenCalledWith(
      SENDER.slack,
      'approval-task-a17',
      'slack',
      CHANNEL_ID.slack
    )
    await h.end()
  })

  it('A18 answers the decision before removing the controls, and survives a failed removal', async () => {
    for (const command of ['/approve', '/deny'] as const) {
      const errors = silenceErrors()
      const taskId = `task-a18-${command.slice(1)}`
      const h = await startAsync('teams', CARD_TAG, taskId)
      await h.suspend()
      await settle()
      const lastId = lastCallId(h.rec, 'teams')
      expect(h.rec.sendMessage.mock.calls.at(-1)![4]?.teamsActions).toBeDefined()
      h.rec.editFailures.add(lastId)

      await expect(h.send(command)).resolves.toBeUndefined()
      const decision = command === '/approve' ? h.rpc.sendApproval : h.rpc.sendDenial
      expect(decision).toHaveBeenCalledTimes(1)
      const acknowledgement =
        command === '/approve'
          ? 'Approved. Processing...'
          : 'Denied. The tool will not be executed.'
      const ackIndex = h.rec.events.findIndex(
        event => event.kind === 'send' && event.content === acknowledgement
      )
      const clearIndex = h.rec.events.findIndex(
        event => event.kind === 'edit' && event.messageId === lastId
      )
      expect(ackIndex).toBeGreaterThanOrEqual(0)
      expect(clearIndex).toBeGreaterThan(ackIndex)
      expectErrorWithIdsOnly(errors, `approval-${taskId}`, [TAG_NAME])
      await h.end()
      errors.mockRestore()
    }
  })

  it('A19 stops sending parts when the task is cancelled during the delivery', async () => {
    const h = await startAsync('telegram', CARD_600, 'task-a19')
    const held = gate()
    h.rec.hooks.set(3, async () => {
      await held.promise
      return 'telegram-msg-3'
    })
    void h.suspend()
    await settle()
    await h.end()
    held.release()
    await settle()

    // Status, part 1, part 2: the parts after it (and the controls) are never sent.
    expect(h.rec.sendMessage).toHaveBeenCalledTimes(3)
    expect(CARD_600.includes(`\n${h.rec.sendMessage.mock.calls[2]![1]}\n`)).toBe(true)
    expect(h.rec.sendMessage.mock.calls.some(call => call[4]?.telegramInlineKeyboard)).toBe(false)
    expect(h.rec.editMessage).toHaveBeenCalledWith(
      CHANNEL_ID.telegram,
      'telegram-msg-1',
      'Request cancelled.',
      undefined
    )
    expect(h.rec.editMessage.mock.calls.some(call => call[1] !== 'telegram-msg-1')).toBe(false)
    expect(h.rpc.sendDenial).not.toHaveBeenCalled()
    expect(sentContents(h.rec)).not.toContain(DENIED)
    expect(sentContents(h.rec)).not.toContain(STILL_WAITING)
    await h.send('/approve')
    expect(sentContents(h.rec).at(-1)).toBe(NO_PENDING)
    expect(h.rpc.sendApproval).not.toHaveBeenCalled()
  })

  it('A19b removes the controls of a last part sent after the task was cancelled', async () => {
    const h = await startAsync('telegram', CARD_255, 'task-a19b')
    const held = gate()
    h.rec.hooks.set(3, async () => {
      await held.promise
      return 'telegram-msg-3'
    })
    void h.suspend()
    await settle()
    await h.end()
    held.release()
    await settle()

    const lastText = h.rec.sendMessage.mock.calls[2]![1]
    const clears = clearEditsOf(h.rec, 'telegram-msg-3')
    expect(clears).toHaveLength(1)
    expect(clears[0]!.slice(0, 3)).toEqual([CHANNEL_ID.telegram, 'telegram-msg-3', lastText])
    expect(clears[0]![3]).toBeUndefined()
    expect(h.rec.editMessage).toHaveBeenCalledWith(
      CHANNEL_ID.telegram,
      'telegram-msg-1',
      'Request cancelled.',
      undefined
    )
    expect(h.rpc.sendDenial).not.toHaveBeenCalled()
    expect(sentContents(h.rec)).not.toContain(DENIED)
    await h.send('/approve')
    expect(sentContents(h.rec).at(-1)).toBe(NO_PENDING)
    expect(h.rpc.sendApproval).not.toHaveBeenCalled()
  })

  it('A20 removes the controls when the task is cancelled or fails after the approval was offered', async () => {
    for (const terminal of [
      { status: 'cancelled' as const },
      {
        status: 'failed' as const,
        error: { code: 'E', message: 'boom', retryable: false, provider: 'test' },
      },
    ]) {
      const taskId = `task-a20-${terminal.status}`
      const h = await startAsync('telegram', CARD_255, taskId)
      await h.suspend()
      await settle()
      const lastId = lastCallId(h.rec, 'telegram')
      const lastText = h.rec.sendMessage.mock.calls.at(-1)![1]

      await h.stream.fireTerminal({ taskId, ...terminal })
      await settle()
      const clears = clearEditsOf(h.rec, lastId)
      expect(clears).toHaveLength(1)
      expect(clears[0]!.slice(0, 3)).toEqual([CHANNEL_ID.telegram, lastId, lastText])
      expect(clears[0]![3]).toBeUndefined()
      await h.send('/approve')
      expect(sentContents(h.rec).at(-1)).toBe(NO_PENDING)
      expect(h.rpc.sendApproval).not.toHaveBeenCalled()
    }
  })

  it('A21 removes the controls when the entry expires', async () => {
    const h = await startAsync('telegram', CARD_255, 'task-a21')
    await h.suspend()
    await settle()
    const lastId = lastCallId(h.rec, 'telegram')
    const lastText = h.rec.sendMessage.mock.calls.at(-1)![1]
    const pending = (h.reader as unknown as { pendingApprovals: Map<string, unknown> })
      .pendingApprovals
    const sweep = () =>
      (h.reader as unknown as { cleanupStaleApprovals(): void }).cleanupStaleApprovals()

    // Witness: before the lifetime ends the sweep keeps the entry and edits nothing.
    sweep()
    await settle()
    expect(pending.size).toBe(1)
    expect(clearEditsOf(h.rec, lastId)).toHaveLength(0)

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000)
    sweep()
    await settle()
    expect(pending.size).toBe(0)
    const clears = clearEditsOf(h.rec, lastId)
    expect(clears).toHaveLength(1)
    expect(clears[0]!.slice(0, 3)).toEqual([CHANNEL_ID.telegram, lastId, lastText])
    expect(clears[0]![3]).toBeUndefined()
    vi.mocked(Date.now).mockRestore()
    await h.end()
  })

  it('A22 sends a second multi-part approval of the same task with its own token', async () => {
    const h = await startAsync('telegram', CARD_255, 'task-a22')
    const tokenOf = (call: Parameters<ChannelAdapter['sendMessage']>) =>
      call[4]!.telegramInlineKeyboard![0]![0]!.callbackData.split(':')[2]!
    await h.suspend()
    await settle()
    const firstLast = h.rec.sendMessage.mock.calls.at(-1)!
    const firstLastId = lastCallId(h.rec, 'telegram')
    const firstToken = tokenOf(firstLast)
    await h.send('/approve')
    expect(h.rpc.sendApproval).toHaveBeenLastCalledWith(
      SENDER.telegram,
      'approval-task-a22',
      false,
      'telegram',
      CHANNEL_ID.telegram
    )
    expect(clearEditsOf(h.rec, firstLastId)).toHaveLength(1)

    const secondNames = asciiNames(20, 255, 's')
    const secondCard = deleteCard(secondNames)
    h.current.requestId = 'approval-task-a22-second'
    h.current.notification = secondCard
    const before = h.rec.sendMessage.mock.calls.length
    await h.suspend('approval-task-a22-second')
    await settle()
    const secondParts = h.rec.sendMessage.mock.calls.slice(before)
    expect(secondParts.map(call => call[1]).join('\n')).toBe(secondCard)
    const secondLast = secondParts.at(-1)!
    const secondLastId = lastCallId(h.rec, 'telegram')
    const secondToken = tokenOf(secondLast)
    expect(secondToken).not.toBe(firstToken)
    // Each request's parts were sent once.
    expect(
      h.rec.sendMessage.mock.calls.filter(call => call[1].startsWith('Delete these files'))
    ).toHaveLength(2)

    await h.send(`tool:a:${firstToken}`)
    expect(sentContents(h.rec).at(-1)).toBe(NO_PENDING)
    expect(h.rpc.sendApproval).toHaveBeenCalledTimes(1)

    await h.send(`tool:a:${secondToken}`)
    expect(h.rpc.sendApproval).toHaveBeenCalledTimes(2)
    expect(h.rpc.sendApproval).toHaveBeenLastCalledWith(
      SENDER.telegram,
      'approval-task-a22-second',
      false,
      'telegram',
      CHANNEL_ID.telegram
    )
    expect(clearEditsOf(h.rec, secondLastId)).toHaveLength(1)
    await h.end()
  })

  it('A23 does not write "Still processing" over the pointer when the stream expires during delivery', async () => {
    silenceErrors()
    const h = await startAsync('telegram', CARD_255, 'task-a23')
    const held = gate()
    h.rec.hooks.set(3, async () => {
      await held.promise
      return 'telegram-msg-3'
    })
    void h.suspend()
    await settle()
    const before = h.rpc.getTaskResult.mock.calls.length
    await h.stream.fireError('task_not_found_or_expired')
    await settle()
    // Witness: the error branch ran and asked for the result once more.
    expect(h.rpc.getTaskResult.mock.calls.length).toBe(before + 1)
    const bubble = h.rec.editMessage.mock.calls
      .filter(call => call[1] === 'telegram-msg-1')
      .map(call => call[2])
    expect(bubble).toContain(POINTER)
    expect(bubble.some(text => text.startsWith('Still processing'))).toBe(false)

    held.release()
    await settle()
    await h.send('/approve')
    expect(h.rpc.sendApproval).toHaveBeenCalledTimes(1)
    await h.end()
  })

  it('A24 denies when the last part was shown but its call failed', async () => {
    silenceErrors()
    const shown: string[] = []
    const h = await startAsync('telegram', CARD_255, 'task-a24')
    h.rec.hooks.set(3, async content => {
      shown.push(content)
      throw new Error('request timed out')
    })
    await h.suspend()
    await settle()

    expect(shown).toHaveLength(1)
    expect(h.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(sentContents(h.rec).at(-1)).toBe(DENIED)
    // No id came back for that message, so no edit of it is attempted.
    expect(h.rec.editMessage.mock.calls.some(call => call[1] !== 'telegram-msg-1')).toBe(false)
    await h.send('/approve')
    expect(sentContents(h.rec).at(-1)).toBe(NO_PENDING)
    expect(h.rpc.sendApproval).not.toHaveBeenCalled()
    await h.end()
  })

  it('A25 neither denies nor notifies when a part fails after the task was cancelled', async () => {
    const errors = silenceErrors()
    const h = await startAsync('telegram', CARD_255, 'task-a25')
    const held = gate()
    h.rec.hooks.set(3, async () => {
      await held.promise
      throw new Error('provider refused the message')
    })
    void h.suspend()
    await settle()
    await h.end()
    held.release()
    await settle()

    // Witnesses: the bubble shows the cancellation and the refused call was made.
    expect(h.rec.editMessage).toHaveBeenCalledWith(
      CHANNEL_ID.telegram,
      'telegram-msg-1',
      'Request cancelled.',
      undefined
    )
    expect(h.rec.sendMessage).toHaveBeenCalledTimes(3)
    expect(h.rpc.sendDenial).not.toHaveBeenCalled()
    expect(sentContents(h.rec).some(content => content.includes('could not be shown'))).toBe(false)
    expectErrorWithIdsOnly(errors, 'approval-task-a25', NAMES_255)
  })
})

/** A reader whose first message gets a synchronous `waiting_approval` answer. */
function syncReader(channelType: ChannelKind, card: string, taskId: string) {
  const rec = recordingAdapter(channelType)
  const { rpc } = rpcClientFor(taskId, SENDER[channelType], card)
  rpc.sendMessage.mockResolvedValueOnce({
    success: true,
    status: 'waiting_approval' as const,
    approval: {
      taskId,
      requestId: `approval-${taskId}`,
      userId: `host-user-${taskId}`,
      notification: card,
    },
  })
  const reader = new ChannelReader({
    rpcClient: rpc,
    adapters: new Map([[channelType, rec.adapter]]),
    channels: channelType === 'telegram' ? [telegramChannel()] : [],
    sleep: async () => undefined,
  })
  return { rec, rpc, reader }
}

describe('tool approval in a synchronous response, not shown whole', () => {
  it('A37 denies a sync approval with a line longer than a Telegram message', async () => {
    const errors = silenceErrors()
    const name = 'r'.repeat(5000)
    const card = deleteCard([name])
    const s = syncReader('telegram', card, 'task-a37')
    await s.reader.handleMessages([messageFor('telegram', 'clean up my files')])
    // Witness: the sync answer was read and the adapter is live.
    expect(s.rpc.sendMessage).toHaveBeenCalledTimes(1)
    expect(sentContents(s.rec)).toEqual([DENIED])
    expect(s.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(s.rpc.sendDenial).toHaveBeenCalledWith(
      'host-user-task-a37',
      'approval-task-a37',
      'telegram',
      CHANNEL_ID.telegram
    )
    expect(s.rec.sendMessage.mock.calls.some(call => call[4]?.telegramInlineKeyboard)).toBe(false)
    await s.reader.handleMessages([messageFor('telegram', '/approve')])
    expect(sentContents(s.rec).at(-1)).toBe(NO_PENDING)
    expect(s.rpc.sendApproval).not.toHaveBeenCalled()
    expectErrorWithIdsOnly(errors, 'approval-task-a37', [name])
  })

  it('A38 says a sync request still waits when mcp-host refuses the denial', async () => {
    silenceErrors()
    const s = syncReader('telegram', deleteCard(['r'.repeat(5000)]), 'task-a38')
    s.rpc.sendDenial.mockResolvedValueOnce({ success: false })
    await s.reader.handleMessages([messageFor('telegram', 'clean up my files')])
    expect(s.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(sentContents(s.rec)).toEqual([STILL_WAITING])
    await s.reader.handleMessages([messageFor('telegram', '/approve')])
    expect(sentContents(s.rec).at(-1)).toBe(NO_PENDING)
    expect(s.rpc.sendApproval).not.toHaveBeenCalled()
  })

  it('A39 denies a sync approval when a part is not delivered', async () => {
    const errors = silenceErrors()
    const s = syncReader('telegram', CARD_600, 'task-a39')
    s.rec.hooks.set(2, async () => {
      throw new Error('provider refused the message')
    })
    await s.reader.handleMessages([messageFor('telegram', 'clean up my files')])
    // Witness: part 1 was sent, without controls, and the refused call was made.
    expect(s.rec.sendMessage).toHaveBeenCalledTimes(3)
    expect(CARD_600.startsWith(`${s.rec.sendMessage.mock.calls[0]![1]}\n`)).toBe(true)
    expect(s.rec.sendMessage.mock.calls.some(call => call[4]?.telegramInlineKeyboard)).toBe(false)
    expect(s.rpc.sendDenial).toHaveBeenCalledTimes(1)
    expect(s.rpc.sendDenial).toHaveBeenCalledWith(
      'host-user-task-a39',
      'approval-task-a39',
      'telegram',
      CHANNEL_ID.telegram
    )
    expect(sentContents(s.rec).at(-1)).toBe(DENIED)
    await s.reader.handleMessages([messageFor('telegram', '/approve')])
    expect(sentContents(s.rec).at(-1)).toBe(NO_PENDING)
    expect(s.rpc.sendApproval).not.toHaveBeenCalled()
    expectErrorWithIdsOnly(errors, 'approval-task-a39', NAMES_600)
  })

  it('A40 escapes a Slack sync approval before it is split', async () => {
    const card = deleteCard(Array.from({ length: 20 }, () => '&'.repeat(60)))
    // Witness: the split depends on the escape. As written the card fits one
    // Slack message; escaped it does not.
    expect(card.length).toBeLessThanOrEqual(SLACK_LIMIT)
    expect(escapeSlack(card).length).toBeGreaterThan(SLACK_LIMIT)
    const s = syncReader('slack', card, 'task-a40')
    await s.reader.handleMessages([messageFor('slack', 'clean up my files')])
    const parts = s.rec.sendMessage.mock.calls
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.map(call => call[1]).join('\n')).toBe(escapeSlack(card))
    for (const call of parts) expect(call[1].length).toBeLessThanOrEqual(SLACK_LIMIT)
    const withBlocks = parts.filter(call => call[4]?.slackBlocks)
    expect(withBlocks).toEqual([parts[parts.length - 1]])
    expect(s.rpc.sendDenial).not.toHaveBeenCalled()
  })
})

describe('the status bubble when a multi-part approval is not shown', () => {
  const PROCESSING = '⏳ Processing your request...'

  function bubbleEdits(rec: ReturnType<typeof recordingAdapter>): string[] {
    return rec.editMessage.mock.calls
      .filter(call => call[1] === 'telegram-msg-1')
      .map(call => call[2])
  }

  /** Settles until `done` holds, at most `rounds` times. */
  async function settleUntil(done: () => boolean, rounds = 25): Promise<void> {
    for (let i = 0; i < rounds && !done(); i++) await settle()
  }

  it('A42 writes no pointer when the task was cancelled before the approval was fetched', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const h = await startAsync('telegram', CARD_255, 'task-a42')
    const held = gate()
    h.rpc.getTaskResult.mockImplementationOnce(async () => {
      await held.promise
      return {
        success: true,
        status: 'waiting_approval' as const,
        approval: {
          taskId: 'task-a42',
          requestId: 'approval-task-a42',
          userId: SENDER.telegram,
          notification: CARD_255,
        },
      }
    })
    void h.suspend()
    await settle()
    await h.end()
    held.release()
    await settle()

    // Witnesses: the cancel reached the bubble, and the multi-part branch ran after it.
    expect(bubbleEdits(h.rec)).toContain('Request cancelled.')
    expect(
      logs.mock.calls.some(call =>
        String(call[0]).includes(
          'Tool approval needed (task: task-a42, request: approval-task-a42)'
        )
      )
    ).toBe(true)
    expect(bubbleEdits(h.rec).at(-1)).toBe('Request cancelled.')
    expect(bubbleEdits(h.rec)).not.toContain(POINTER)
    expect(h.rec.sendMessage).toHaveBeenCalledTimes(1)
    expect(h.rpc.sendDenial).not.toHaveBeenCalled()
    await h.send('/approve')
    expect(sentContents(h.rec).at(-1)).toBe(NO_PENDING)
    expect(h.rpc.sendApproval).not.toHaveBeenCalled()
  })

  it('A43 shows the progress again before the denial when a part is not delivered', async () => {
    silenceErrors()
    const failPart2 = (h: Awaited<ReturnType<typeof startAsync>>) =>
      h.rec.hooks.set(3, async () => {
        throw new Error('provider refused the message')
      })

    // (i) denial accepted: the bubble is restored before the denial is sent.
    const i = await startAsync('telegram', CARD_600, 'task-a43-i')
    failPart2(i)
    await i.suspend()
    await settle()
    expect.soft(bubbleEdits(i.rec), 'A43(i) bubble edits').toEqual([POINTER, PROCESSING])
    expect.soft(sentContents(i.rec).at(-1), 'A43(i) notice').toBe(DENIED)
    const restoreCall = i.rec.editMessage.mock.calls.findIndex(
      call => call[1] === 'telegram-msg-1' && call[2] === PROCESSING
    )
    const restoreOrder =
      restoreCall >= 0 ? i.rec.editMessage.mock.invocationCallOrder[restoreCall]! : Infinity
    expect.soft(i.rpc.sendDenial, 'A43(i) denial sent').toHaveBeenCalledTimes(1)
    expect
      .soft(restoreOrder, 'A43(i) the progress edit comes before the denial')
      .toBeLessThan(i.rpc.sendDenial.mock.invocationCallOrder[0] ?? -Infinity)
    await i.end()

    // (ii) denial rejected.
    const ii = await startAsync('telegram', CARD_600, 'task-a43-ii')
    failPart2(ii)
    ii.rpc.sendDenial.mockResolvedValueOnce({ success: false })
    await ii.suspend()
    await settle()
    expect.soft(bubbleEdits(ii.rec), 'A43(ii) bubble edits').toEqual([POINTER, PROCESSING])
    expect.soft(sentContents(ii.rec).at(-1), 'A43(ii) notice').toBe(STILL_WAITING)
    await ii.end()

    // (iii) a line over the limit: no pointer was written, so nothing is restored.
    const iii = await startAsync('telegram', deleteCard(['r'.repeat(5000)]), 'task-a43-iii')
    await iii.suspend()
    await settle()
    // Witness: the refusal ran to its notice.
    expect.soft(sentContents(iii.rec).at(-1), 'A43(iii) notice').toBe(DENIED)
    expect.soft(bubbleEdits(iii.rec), 'A43(iii) bubble edits').toEqual([])
    await iii.end()

    // (iv) the task is cancelled while the failing part is held.
    const iv = await startAsync('telegram', CARD_600, 'task-a43-iv')
    const heldIv = gate()
    iv.rec.hooks.set(3, async () => {
      await heldIv.promise
      throw new Error('provider refused the message')
    })
    void iv.suspend()
    await settle()
    await iv.end()
    heldIv.release()
    await settle()
    // Witness: the refused call was made.
    expect.soft(iv.rec.sendMessage, 'A43(iv) refused call made').toHaveBeenCalledTimes(3)
    const ivEdits = bubbleEdits(iv.rec)
    expect.soft(ivEdits.at(-1), 'A43(iv) last bubble edit').toBe('Request cancelled.')
    expect
      .soft(
        ivEdits.slice(ivEdits.indexOf(POINTER) + 1).some(text => text.startsWith(PROCESSING)),
        'A43(iv) no progress text after the pointer'
      )
      .toBe(false)

    // (v) as (i), with one completed step: the restore shows the progress list.
    const v = await startAsync('telegram', CARD_600, 'task-a43-v')
    failPart2(v)
    const step: ProgressStep = {
      toolCallId: 'call-a43-v',
      toolName: 'kept_files_list',
      displayName: 'List kept files',
      intentSummary: 'List the kept files',
      iteration: 1,
      stepIndex: 1,
      totalSteps: 1,
      state: 'completed',
      durationMs: 120,
    }
    v.stream.steps.push(step)
    await v.suspend()
    await settle()
    expect
      .soft(bubbleEdits(v.rec), 'A43(v) bubble edits')
      .toEqual([POINTER, formatProgressUpdate([step])])
    await v.end()

    // (vi) the accepted denial completes the task at the Host: its final text
    // is written while the denial's answer is handled, and stays last.
    const vi6 = await startAsync('telegram', CARD_600, 'task-a43-vi')
    failPart2(vi6)
    const finalText = 'Tool `kept_files_delete` was denied by the user.'
    const finalEdit = gate()
    const finalEntered = gate()
    vi6.rec.editHolds.set(finalText, { gate: finalEdit.promise, entered: finalEntered.release })
    vi6.rpc.sendDenial.mockImplementationOnce(async () => {
      vi6.rpc.getTaskResult.mockResolvedValue({
        success: true,
        status: 'completed' as const,
        response: finalText,
      } as never)
      void vi6.stream.fireTerminal({ taskId: 'task-a43-vi', status: 'completed' })
      // The Host answers after the task completed; the final edit is in flight.
      await finalEntered.promise
      return { success: true }
    })
    void vi6.suspend()
    await settleUntil(() => sentContents(vi6.rec).includes(DENIED))
    // Witnesses: the notice was sent while the final edit was held, then it is released.
    expect.soft(sentContents(vi6.rec), 'A43(vi) notice sent').toContain(DENIED)
    finalEdit.release()
    await settle()
    expect.soft(bubbleEdits(vi6.rec), 'A43(vi) final edit made').toContain(finalText)
    expect.soft(bubbleEdits(vi6.rec).at(-1), 'A43(vi) last bubble edit').toBe(finalText)
  })
})

describe('tool approval not shown while the task ends', () => {
  function bubbleEdits(rec: ReturnType<typeof recordingAdapter>): string[] {
    return rec.editMessage.mock.calls
      .filter(call => call[1] === 'telegram-msg-1')
      .map(call => call[2])
  }

  it('A44 sends no notice when the task is cancelled while the refusal is denied', async () => {
    silenceErrors()
    for (const answer of [
      { row: 'accepted', result: { success: true } },
      { row: 'rejected', result: { success: false } },
    ]) {
      const taskId = `task-a44-${answer.row}`
      const h = await startAsync('telegram', CARD_255, taskId)
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
      expect
        .soft(
          sentContents(h.rec).some(content => content.includes('could not be shown')),
          `A44(${answer.row}) no notice`
        )
        .toBe(false)
      expect
        .soft(h.rec.sendMessage, `A44(${answer.row}) only the bubble sent`)
        .toHaveBeenCalledTimes(1)
    }
  })

  it('A45 sends no notice when the task is cancelled while a failed delivery is denied', async () => {
    silenceErrors()
    const h = await startAsync('telegram', CARD_600, 'task-a45')
    h.rec.hooks.set(3, async () => {
      throw new Error('provider refused the message')
    })
    const held = gate()
    h.rpc.sendDenial.mockImplementationOnce(async () => {
      await held.promise
      return { success: false }
    })
    void h.suspend()
    await settle()
    // Witness: the failed delivery sent its denial before the cancel.
    expect(h.rpc.sendDenial).toHaveBeenCalledTimes(1)
    await h.end()
    held.release()
    await settle()

    expect(bubbleEdits(h.rec)).toContain('Request cancelled.')
    expect(sentContents(h.rec).some(content => content.includes('could not be shown'))).toBe(false)
    expect(bubbleEdits(h.rec).at(-1)).toBe('Request cancelled.')
  })
})

describe('a pending approval that another one replaces', () => {
  const NAMES_Y = asciiNames(20, 255, 's')
  const CARD_Y = deleteCard(NAMES_Y)
  const SHORT_Y = `Delete these files permanently:\n${fileLine('notes.txt')}\nTotal files: 1\n${INSTRUCTION}`

  const tokenOf = (call: Parameters<ChannelAdapter['sendMessage']>) =>
    call[4]!.telegramInlineKeyboard![0]![0]!.callbackData.split(':')[2]!

  it('A46 removes the controls of a multi-part approval replaced at each registration site', async () => {
    const rows = [
      { row: 'sync-multi', path: 'sync', card: CARD_Y },
      { row: 'sync-one', path: 'sync', card: SHORT_Y },
      { row: 'async-multi', path: 'async', card: CARD_Y },
      { row: 'async-one', path: 'async', card: SHORT_Y },
    ] as const
    for (const { row, path, card } of rows) {
      const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const xTask = `task-a46-${row}-x`
      const yTask = `task-a46-${row}-y`
      const xRequest = `approval-${xTask}`
      const yRequest = `approval-${yTask}`
      // Approval X: a synchronous multi-part approval, the keyboard on message 2.
      const s = syncReader('telegram', CARD_255, xTask)
      await s.reader.handleMessages([messageFor('telegram', 'clean up my files')])
      const xLast = s.rec.sendMessage.mock.calls[1]!
      // Witness: X's last part was sent with a keyboard.
      expect.soft(xLast[4]?.telegramInlineKeyboard, `A46(${row}) X keyboard`).toBeDefined()
      const xToken = tokenOf(xLast)

      // Approval Y, for the same sender and chat, through this row's site.
      const streamsBefore = streamCalls.length
      if (path === 'sync') {
        s.rpc.sendMessage.mockResolvedValueOnce({
          success: true,
          status: 'waiting_approval' as const,
          approval: {
            taskId: yTask,
            requestId: yRequest,
            userId: `host-user-${yTask}`,
            notification: card,
          },
        })
        await s.reader.handleMessages([messageFor('telegram', 'clean up more files')])
      } else {
        s.rpc.sendMessage.mockResolvedValueOnce({
          success: true,
          status: 'pending' as const,
          taskId: yTask,
        })
        s.rpc.getTaskResult.mockResolvedValueOnce({
          success: true,
          status: 'waiting_approval' as const,
          approval: {
            taskId: yTask,
            requestId: yRequest,
            userId: `host-user-${yTask}`,
            notification: card,
          },
        })
        await s.reader.handleMessages([messageFor('telegram', 'clean up more files')])
        await streamCalls[streamsBefore]!.fireSuspended({
          taskId: yTask,
          requestId: yRequest,
          displayName: 'Delete kept files',
          reason: 'approval_required',
        })
      }
      await settle()
      // The message that holds Y's controls: the last one sent with a keyboard,
      // or, for the one-message card on the progress flow, the edited status bubble.
      const ySends = s.rec.sendMessage.mock.calls
        .map((call, index) => ({ call, id: `telegram-msg-${index + 1}` }))
        .filter(entry => entry.id !== 'telegram-msg-2' && entry.call[4]?.telegramInlineKeyboard)
      const yControls =
        ySends.at(-1)?.id ??
        s.rec.editMessage.mock.calls.find(call => call[3]?.telegramInlineKeyboard)?.[1]
      expect.soft(yControls, `A46(${row}) Y shown with controls`).toBeDefined()

      const xClears = clearEditsOf(s.rec, 'telegram-msg-2')
      expect.soft(xClears, `A46(${row}) X cleared once`).toHaveLength(1)
      expect.soft(xClears[0]?.[2], `A46(${row}) X clear text`).toBe(xLast[1])
      expect.soft(xClears[0]?.[3], `A46(${row}) X clear options`).toBeUndefined()
      expect
        .soft(
          clearEditsOf(s.rec, yControls ?? 'none').filter(call => call[3] === undefined),
          `A46(${row}) no clear of Y`
        )
        .toEqual([])
      const warnLines = errorLines(warns)
      expect
        .soft(
          warnLines.some(line => line.includes(xRequest) && line.includes(yRequest)),
          `A46(${row}) warn names both requests`
        )
        .toBe(true)
      for (const line of warnLines) {
        expect.soft(line, `A46(${row}) warn without file names`).not.toContain('upload: "')
      }

      await s.reader.handleMessages([messageFor('telegram', `tool:a:${xToken}`)])
      expect.soft(sentContents(s.rec).at(-1), `A46(${row}) X token`).toBe(NO_PENDING)
      await s.reader.handleMessages([messageFor('telegram', '/approve')])
      expect.soft(s.rpc.sendApproval, `A46(${row}) one decision`).toHaveBeenCalledTimes(1)
      expect.soft(s.rpc.sendApproval, `A46(${row}) Y decided`).toHaveBeenCalledWith(
        // The sync answer names the Host user; the progress flow uses the sender.
        path === 'sync' ? `host-user-${yTask}` : SENDER.telegram,
        yRequest,
        false,
        'telegram',
        CHANNEL_ID.telegram
      )
      if (path === 'async') {
        await streamCalls[streamsBefore]!.fireTerminal({ taskId: yTask, status: 'cancelled' })
      }
      warns.mockRestore()
    }
  })

  it('A47 clears every keyboard once when two streams follow one task', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const h = await startAsync('telegram', CARD_255, 'task-a47')
    await h.suspend()
    await settle()
    const firstLastId = lastCallId(h.rec, 'telegram')
    expect(h.rec.sendMessage.mock.calls.at(-1)![4]?.telegramInlineKeyboard).toBeDefined()

    // The same message delivered again: the Host answers with the task in flight.
    await h.send('clean up my files')
    expect(streamCalls).toHaveLength(2)
    const second = streamCalls[1]!
    await second.fireSuspended({
      taskId: 'task-a47',
      requestId: 'approval-task-a47',
      displayName: 'Delete kept files',
      reason: 'approval_required',
    })
    await settle()
    // Witness: the second stream sent the card again, its controls on a new message.
    const keyboardIds = h.rec.sendMessage.mock.calls
      .map((call, index) => ({ call, id: `telegram-msg-${index + 1}` }))
      .filter(entry => entry.call[4]?.telegramInlineKeyboard)
      .map(entry => entry.id)
    expect(keyboardIds).toHaveLength(2)
    expect(clearEditsOf(h.rec, firstLastId)).toHaveLength(1)

    await h.end()
    await second.fireTerminal({ taskId: 'task-a47', status: 'cancelled' })
    await settle()
    for (const id of keyboardIds) expect(clearEditsOf(h.rec, id)).toHaveLength(1)
  })
})
