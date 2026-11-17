import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RPCClient } from '../src/rpcClient'
import type { ChannelAdapter, CommunicationChannelCRD, Message, ProgressStep } from '../src/types'

// A tool approval at the channel's limit arrives as one message: the card,
// whole, with the channel's controls. mcp-host refuses a delete whose card
// does not fit one message of its channel, so these tests drive approvals at
// that limit through the real channel adapters with faked provider clients.

interface StreamCall {
  taskId: string
  fireSuspended: (data: unknown) => Promise<void>
  fireTerminal: (data: unknown) => Promise<void>
}
const streamCalls: StreamCall[] = []

vi.mock('../src/progressClient', () => ({
  createProgressStream: (options: import('../src/progressClient').ProgressStreamOptions) => {
    streamCalls.push({
      taskId: options.taskId,
      fireSuspended: options.onSuspended as never,
      fireTerminal: options.onTerminal as never,
    })
    const steps: ProgressStep[] = []
    return {
      close: () => undefined,
      get steps() {
        return steps
      },
    }
  },
}))

let ChannelReader: typeof import('../src/main').ChannelReader
let SlackAdapter: typeof import('../src/channels/slack').SlackAdapter
let TelegramAdapter: typeof import('../src/channels/telegram').TelegramAdapter
let TeamsAdapter: typeof import('../src/channels/teams').TeamsAdapter

beforeAll(async () => {
  process.env.CLERUM_DEV_MODE = 'true'
  ;({ ChannelReader } = await import('../src/main'))
  ;({ SlackAdapter } = await import('../src/channels/slack'))
  ;({ TelegramAdapter } = await import('../src/channels/telegram'))
  ;({ TeamsAdapter } = await import('../src/channels/teams'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const TELEGRAM_LIMIT = 4096
const SLACK_SECTION_LIMIT = 3000

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

function channelsFor(channelType: ChannelKind): CommunicationChannelCRD[] {
  if (channelType !== 'telegram') return []
  return [
    {
      name: 'chatllm-telegram',
      namespace: 'channels',
      spec: {
        hostRef: 'chatllm',
        telegram: [{ channelId: CHANNEL_ID.telegram, userIds: [SENDER.telegram] }],
      },
    },
  ]
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

function rpcClientFor(taskId: string, userId: string, notification: string) {
  const approval = { taskId, requestId: `approval-${taskId}`, userId, notification }
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
      approval,
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
  return { rpc, approval }
}

function unexpectedRpcCall(name: string) {
  return async (): Promise<never> => {
    throw new Error(`unexpected RPC call in this test: ${name}`)
  }
}

interface SlackCall {
  text: string
  blocks?: Array<{ type: string; text?: { text: string } }>
}

/**
 * The real Slack adapter over a faked Web API client. The client refuses what
 * Slack refuses: a section over 3000 chars (invalid_blocks) and a text over
 * 4000 (msg_too_long).
 */
function realSlack() {
  const posts: SlackCall[] = []
  const updates: SlackCall[] = []
  const rejected: string[] = []
  const check = (args: SlackCall) => {
    const section = args.blocks?.find(block => block.type === 'section')?.text?.text
    if (section !== undefined && section.length > SLACK_SECTION_LIMIT) {
      rejected.push(`invalid_blocks section=${section.length}`)
      throw new Error('An API error occurred: invalid_blocks')
    }
    if (args.text.length > 4000) {
      rejected.push(`msg_too_long text=${args.text.length}`)
      throw new Error('An API error occurred: msg_too_long')
    }
  }
  const adapter = new SlackAdapter()
  ;(adapter as unknown as { client: unknown }).client = {
    chat: {
      postMessage: vi.fn(async (args: SlackCall) => {
        check(args)
        posts.push(args)
        return { ok: true, ts: `1710000000.${String(posts.length).padStart(6, '0')}` }
      }),
      update: vi.fn(async (args: SlackCall) => {
        check(args)
        updates.push(args)
        return { ok: true }
      }),
    },
  }
  return { adapter: adapter as ChannelAdapter, posts, updates, rejected }
}

interface TelegramCall {
  text: string
  keyboard: unknown[]
}

/** The real Telegram adapter over a faked Bot API. */
function realTelegram() {
  const sent: TelegramCall[] = []
  const edited: TelegramCall[] = []
  const adapter = new TelegramAdapter()
  ;(adapter as unknown as { bot: unknown }).bot = {
    api: {
      sendMessage: vi.fn(
        async (
          _chat: unknown,
          text: string,
          options?: { reply_markup?: { inline_keyboard: unknown[] } }
        ) => {
          sent.push({ text, keyboard: options?.reply_markup?.inline_keyboard ?? [] })
          return { message_id: sent.length }
        }
      ),
      editMessageText: vi.fn(
        async (
          _chat: unknown,
          _id: unknown,
          text: string,
          options?: { reply_markup?: { inline_keyboard: unknown[] } }
        ) => {
          edited.push({ text, keyboard: options?.reply_markup?.inline_keyboard ?? [] })
          return true
        }
      ),
    },
  }
  return { adapter: adapter as ChannelAdapter, sent, edited }
}

function readerFor(
  channelType: ChannelKind,
  adapter: ChannelAdapter,
  rpc: ReturnType<typeof rpcClientFor>['rpc']
) {
  return new ChannelReader({
    rpcClient: rpc,
    adapters: new Map([[channelType, adapter]]),
    channels: channelsFor(channelType),
    sleep: async () => undefined,
  })
}

/** Runs a task on the progress flow up to its approval: the card edits the status bubble. */
async function offerAsync(
  channelType: ChannelKind,
  adapter: ChannelAdapter,
  notification: string,
  taskId: string
) {
  streamCalls.length = 0
  const { rpc } = rpcClientFor(taskId, SENDER[channelType], notification)
  const reader = readerFor(channelType, adapter, rpc)
  await reader.handleMessages([messageFor(channelType, 'clean up my files')])
  expect(streamCalls).toHaveLength(1)
  await streamCalls[0]!.fireSuspended({
    taskId,
    requestId: `approval-${taskId}`,
    displayName: 'Delete kept files',
    reason: 'approval_required',
  })
  await settle()
  return {
    rpc,
    send: (content: string) => reader.handleMessages([messageFor(channelType, content)]),
  }
}

/** mcp-host answers the send synchronously with the approval: no task id, no status bubble. */
async function offerSync(
  channelType: ChannelKind,
  adapter: ChannelAdapter,
  notification: string,
  taskId: string
) {
  const { rpc, approval } = rpcClientFor(taskId, SENDER[channelType], notification)
  rpc.sendMessage.mockResolvedValueOnce({
    success: true,
    status: 'waiting_approval' as const,
    approval,
  })
  const reader = readerFor(channelType, adapter, rpc)
  await reader.handleMessages([messageFor(channelType, 'clean up my files')])
  await settle()
  return {
    rpc,
    send: (content: string) => reader.handleMessages([messageFor(channelType, content)]),
  }
}

/** The approval is registered: a typed /approve reaches mcp-host for its request. */
async function expectRegistered(
  offered: {
    rpc: ReturnType<typeof rpcClientFor>['rpc']
    send: (content: string) => Promise<void>
  },
  taskId: string
) {
  await offered.send('/approve')
  expect(offered.rpc.sendApproval).toHaveBeenCalledTimes(1)
  expect(offered.rpc.sendApproval.mock.calls[0]).toContain(`approval-${taskId}`)
}

function sectionText(call: SlackCall | undefined): string | undefined {
  return call?.blocks?.find(block => block.type === 'section')?.text?.text
}

function hasSlackActions(call: SlackCall | undefined): boolean {
  return call?.blocks?.some(block => block.type === 'actions') ?? false
}

// Delete cards at the limit, in the format mcp-host sends: the header, one
// line per file with its kind, whole name, size and creation date, the total
// and the instruction. The Telegram card is 4096 chars; the Slack card is 3000
// chars once `&`, `<` and `>` are escaped.
const TELEGRAM_CARD = [
  'Delete these files permanently:',
  'generated: "quarterly-board-report-00-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 1.2 MB (1,234,567 bytes), created 2026-11-10 09:12:45 UTC',
  'upload: "quarterly-board-report-01-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 865.6 KB (865,598 bytes), created 2026-10-02 17:40:03 UTC',
  'upload: "quarterly-board-report-02-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 12.9 GB (12,884,901,888 bytes), created 2026-11-14 23:59:59 UTC',
  'upload: "quarterly-board-report-03-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 3.7 TB (3,738,339,534,848 bytes), created 2026-11-10 09:12:45 UTC',
  'generated: "quarterly-board-report-04-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 512 B (512 bytes), created 2026-10-02 17:40:03 UTC',
  'upload: "quarterly-board-report-05-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 1.2 MB (1,234,567 bytes), created 2026-11-14 23:59:59 UTC',
  'upload: "quarterly-board-report-06-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 865.6 KB (865,598 bytes), created 2026-11-10 09:12:45 UTC',
  'upload: "quarterly-board-report-07-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 12.9 GB (12,884,901,888 bytes), created 2026-10-02 17:40:03 UTC',
  'generated: "quarterly-board-report-08-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 3.7 TB (3,738,339,534,848 bytes), created 2026-11-14 23:59:59 UTC',
  'upload: "quarterly-board-report-09-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 512 B (512 bytes), created 2026-11-10 09:12:45 UTC',
  'upload: "quarterly-board-report-10-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 1.2 MB (1,234,567 bytes), created 2026-10-02 17:40:03 UTC',
  'upload: "quarterly-board-report-11-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 865.6 KB (865,598 bytes), created 2026-11-14 23:59:59 UTC',
  'generated: "quarterly-board-report-12-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 12.9 GB (12,884,901,888 bytes), created 2026-11-10 09:12:45 UTC',
  'upload: "quarterly-board-report-13-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 3.7 TB (3,738,339,534,848 bytes), created 2026-10-02 17:40:03 UTC',
  'upload: "quarterly-board-report-14-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 512 B (512 bytes), created 2026-11-14 23:59:59 UTC',
  'upload: "quarterly-board-report-15-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 1.2 MB (1,234,567 bytes), created 2026-11-10 09:12:45 UTC',
  'generated: "quarterly-board-report-16-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 865.6 KB (865,598 bytes), created 2026-10-02 17:40:03 UTC',
  'upload: "quarterly-board-report-17-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 12.9 GB (12,884,901,888 bytes), created 2026-11-14 23:59:59 UTC',
  'upload: "quarterly-board-report-18-final-reviewed-by-finance-and-legal-with-appendix-tables-signed-copy-for-the-audit-committee-archive.pdf" — 3.7 TB (3,738,339,534,848 bytes), created 2026-11-10 09:12:45 UTC',
  'upload: "board-minutes-of-the-steering-committee-meeting-held-in-the-main-office-.md" — 512 B (512 bytes), created 2026-10-02 17:40:03 UTC',
  'Total files: 20',
  'Reply /approve or /deny to this message.',
].join('\n')

const SLACK_CARD = [
  'Delete these files permanently:',
  'generated: "R&D <draft> q00 supplier-contracts & renewals (v2).xlsx" — 1.2 MB (1,234,567 bytes), created 2026-11-10 09:12:45 UTC',
  'upload: "R&D <draft> q01 supplier-contracts & renewals (v2).xlsx" — 865.6 KB (865,598 bytes), created 2026-10-02 17:40:03 UTC',
  'upload: "R&D <draft> q02 supplier-contracts & renewals (v2).xlsx" — 12.9 GB (12,884,901,888 bytes), created 2026-11-14 23:59:59 UTC',
  'upload: "R&D <draft> q03 supplier-contracts & renewals (v2).xlsx" — 3.7 TB (3,738,339,534,848 bytes), created 2026-11-10 09:12:45 UTC',
  'generated: "R&D <draft> q04 supplier-contracts & renewals (v2).xlsx" — 512 B (512 bytes), created 2026-10-02 17:40:03 UTC',
  'upload: "R&D <draft> q05 supplier-contracts & renewals (v2).xlsx" — 1.2 MB (1,234,567 bytes), created 2026-11-14 23:59:59 UTC',
  'upload: "R&D <draft> q06 supplier-contracts & renewals (v2).xlsx" — 865.6 KB (865,598 bytes), created 2026-11-10 09:12:45 UTC',
  'upload: "R&D <draft> q07 supplier-contracts & renewals (v2).xlsx" — 12.9 GB (12,884,901,888 bytes), created 2026-10-02 17:40:03 UTC',
  'generated: "R&D <draft> q08 supplier-contracts & renewals (v2).xlsx" — 3.7 TB (3,738,339,534,848 bytes), created 2026-11-14 23:59:59 UTC',
  'upload: "R&D <draft> q09 supplier-contracts & renewals (v2).xlsx" — 512 B (512 bytes), created 2026-11-10 09:12:45 UTC',
  'upload: "R&D <draft> q10 supplier-contracts & renewals (v2).xlsx" — 1.2 MB (1,234,567 bytes), created 2026-10-02 17:40:03 UTC',
  'upload: "R&D <draft> q11 supplier-contracts & renewals (v2).xlsx" — 865.6 KB (865,598 bytes), created 2026-11-14 23:59:59 UTC',
  'generated: "R&D <draft> q12 supplier-contracts & renewals (v2).xlsx" — 12.9 GB (12,884,901,888 bytes), created 2026-11-10 09:12:45 UTC',
  'upload: "R&D <draft> q13 supplier-contracts & renewals (v2).xlsx" — 3.7 TB (3,738,339,534,848 bytes), created 2026-10-02 17:40:03 UTC',
  'upload: "R&D <draft> q14 supplier-contracts & renewals (v2).xlsx" — 512 B (512 bytes), created 2026-11-14 23:59:59 UTC',
  'upload: "R&D <draft> q15 supplier-contracts & renewals (v2).xlsx" — 1.2 MB (1,234,567 bytes), created 2026-11-10 09:12:45 UTC',
  'generated: "R&D <draft> q16 supplier-contracts & renewals (v2).xlsx" — 865.6 KB (865,598 bytes), created 2026-10-02 17:40:03 UTC',
  'upload: "R&D <draft> q17 supplier-contracts & renewals (v2).xlsx" — 12.9 GB (12,884,901,888 bytes), created 2026-11-14 23:59:59 UTC',
  'upload: "R&D <draft> q18 supplier-contracts & renewals (v2).xlsx" — 3.7 TB (3,738,339,534,848 bytes), created 2026-11-10 09:12:45 UTC',
  'upload: "notes & minutes-of-the-steering-committee-meeting-held-in-the-main-office-with-every-regional-lead-present-minutes-of-the-.txt" — 512 B (512 bytes), created 2026-10-02 17:40:03 UTC',
  'Total files: 20',
  'Use the approval controls to continue or cancel.',
].join('\n')

// Contract vector shared with mcp-host's size functions: Slack escaping and
// Teams JSON bytes both grow it, by different amounts.
const VECTOR = 'a&&b<c>d"e\\f—g…hé\ni'

describe('a tool approval is one message at the channel maximum', () => {
  it('K1 edits an approval at the limit into the bubble unmodified, with its controls, and registers it', async () => {
    // Telegram: 4096 chars arrive whole; the same adapter cuts 4097 to 4093 + "...".
    const telegram = realTelegram()
    const atLimit = 'x'.repeat(TELEGRAM_LIMIT)
    const tg = await offerAsync('telegram', telegram.adapter, atLimit, 'task-k1-telegram')
    // Witness: only the status bubble was sent; the card is an edit of it.
    expect(telegram.sent.map(item => item.text)).toEqual(['⏳ Processing your request...'])
    const tgCards = telegram.edited.filter(item => item.keyboard.length > 0)
    expect(tgCards).toHaveLength(1)
    expect(tgCards[0]!.text).toBe(atLimit)
    await expectRegistered(tg, 'task-k1-telegram')

    const over = realTelegram()
    await offerAsync('telegram', over.adapter, 'x'.repeat(TELEGRAM_LIMIT + 1), 'task-k1-over')
    const overCards = over.edited.filter(item => item.keyboard.length > 0)
    expect(overCards).toHaveLength(1)
    expect(overCards[0]!.text).toBe(`${'x'.repeat(TELEGRAM_LIMIT - 3)}...`)

    // Slack: 3000 chars once escaped, in the text and in the section block.
    const slack = realSlack()
    const notification = `${'<'.repeat(10)}${'&'.repeat(10)}${'y'.repeat(2910)}`
    const escaped = escapeSlack(notification)
    expect(escaped).toHaveLength(SLACK_SECTION_LIMIT)
    const sl = await offerAsync('slack', slack.adapter, notification, 'task-k1-slack')
    expect(slack.rejected).toEqual([])
    expect(slack.posts).toHaveLength(1)
    expect(slack.updates).toHaveLength(1)
    expect(slack.updates[0]!.text).toBe(escaped)
    expect(sectionText(slack.updates[0])).toBe(escaped)
    expect(hasSlackActions(slack.updates[0])).toBe(true)
    await expectRegistered(sl, 'task-k1-slack')
  })

  it('K2 sends a synchronous approval at the limit as one message with its controls and registers it', async () => {
    expect(TELEGRAM_CARD).toHaveLength(TELEGRAM_LIMIT)
    const telegram = realTelegram()
    const tg = await offerSync('telegram', telegram.adapter, TELEGRAM_CARD, 'task-k2-telegram')
    expect(telegram.sent).toHaveLength(1)
    expect(telegram.sent[0]!.text).toBe(TELEGRAM_CARD)
    expect(telegram.sent[0]!.keyboard.length).toBeGreaterThan(0)
    expect(telegram.edited).toEqual([])
    await expectRegistered(tg, 'task-k2-telegram')

    const escaped = escapeSlack(SLACK_CARD)
    expect(escaped).toHaveLength(SLACK_SECTION_LIMIT)
    const slack = realSlack()
    const sl = await offerSync('slack', slack.adapter, SLACK_CARD, 'task-k2-slack')
    expect(slack.rejected).toEqual([])
    expect(slack.posts).toHaveLength(1)
    expect(slack.posts[0]!.text).toBe(escaped)
    expect(sectionText(slack.posts[0])).toBe(escaped)
    expect(hasSlackActions(slack.posts[0])).toBe(true)
    await expectRegistered(sl, 'task-k2-slack')
  })

  it('K6 carries every line of a delete card at the limit in one provider call', async () => {
    // Witnesses: the cards are at each channel's limit, and the Slack one is escaped.
    expect(TELEGRAM_CARD).toHaveLength(TELEGRAM_LIMIT)
    expect(TELEGRAM_CARD.split('\n')).toHaveLength(23)
    expect(escapeSlack(SLACK_CARD)).toHaveLength(SLACK_SECTION_LIMIT)
    expect(escapeSlack(SLACK_CARD)).not.toBe(SLACK_CARD)

    const telegram = realTelegram()
    await offerAsync('telegram', telegram.adapter, TELEGRAM_CARD, 'task-k6-telegram')
    expect(telegram.sent).toHaveLength(1)
    const tgCards = telegram.edited.filter(item => item.text.includes('Total files: 20'))
    expect(tgCards).toHaveLength(1)
    expect(tgCards[0]!.text).toBe(TELEGRAM_CARD)
    expect(tgCards[0]!.keyboard.length).toBeGreaterThan(0)

    const slack = realSlack()
    await offerAsync('slack', slack.adapter, SLACK_CARD, 'task-k6-slack')
    expect(slack.rejected).toEqual([])
    expect(slack.posts).toHaveLength(1)
    const slCards = slack.updates.filter(call => call.text.includes('Total files: 20'))
    expect(slCards).toHaveLength(1)
    expect(slCards[0]!.text).toBe(escapeSlack(SLACK_CARD))
    expect(sectionText(slCards[0])).toBe(escapeSlack(SLACK_CARD))
    expect(hasSlackActions(slCards[0])).toBe(true)
  })
})

describe('the size contract with mcp-host', () => {
  it('K5 escapes the contract vector for Slack to the length mcp-host measures', async () => {
    expect(VECTOR).toHaveLength(19)
    const slack = realSlack()
    await offerAsync('slack', slack.adapter, VECTOR, 'task-k5')
    expect(slack.rejected).toEqual([])
    expect(slack.updates).toHaveLength(1)
    const section = sectionText(slack.updates[0])
    expect(section).toBe('a&amp;&amp;b&lt;c&gt;d"e\\f—g…hé\ni')
    expect(section).toHaveLength(33)
    expect(slack.updates[0]!.text).toBe(section)
  })

  it('K7 sends the contract vector to Teams in the summary and the card text, at the bytes mcp-host measures', async () => {
    expect(VECTOR).toHaveLength(19)
    const encoded = JSON.stringify(VECTOR)
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(29)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
      )
      .mockImplementation(
        async () => new Response(JSON.stringify({ id: 'activity-1' }), { status: 200 })
      )
    vi.stubGlobal('fetch', fetchMock)
    const teams = new TeamsAdapter()
    await teams.connect({
      teamsAppId: 'app-1',
      teamsTenantId: 'tenant-1',
      teamsAppPassword: 'secret',
    })
    teams.rememberConversation('19:channel-1@thread.tacv2', 'https://smba.trafficmanager.net/amer/')

    await offerSync('teams', teams, VECTOR, 'task-k7')

    const posts = fetchMock.mock.calls
      .filter(call => String(call[0]).includes('/v3/conversations/'))
      .map(call => String((call[1] as RequestInit).body))
    // Witness: the approval was posted once, as a card.
    expect(posts).toHaveLength(1)
    const raw = posts[0]!
    const activity = JSON.parse(raw) as {
      summary?: string
      attachments: Array<{ content: { body: Array<{ text: string }>; actions: unknown[] } }>
    }
    expect(activity.summary).toBe(VECTOR)
    expect(activity.attachments).toHaveLength(1)
    expect(activity.attachments[0]!.content.body[0]!.text).toBe(VECTOR)
    expect(activity.attachments[0]!.content.actions.length).toBeGreaterThan(0)
    expect(raw.split(encoded.slice(1, -1))).toHaveLength(3)
  })
})
