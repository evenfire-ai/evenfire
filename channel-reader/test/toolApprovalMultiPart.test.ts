import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChannelAdapter, CommunicationChannelCRD, Message } from '../src/types'

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
 * counting sendMessage calls from 1; a hook replaces the n-th call.
 */
function recordingAdapter(channelType: ChannelKind) {
  const events: AdapterEvent[] = []
  const hooks = new Map<number, SendHook>()
  const editFailures = new Set<string>()
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
  return { adapter, sendMessage, editMessage, events, hooks, editFailures }
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

describe('tool approval in a synchronous response, not shown whole', () => {
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
