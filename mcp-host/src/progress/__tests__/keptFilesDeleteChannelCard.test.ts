import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AgentStateMachine } from '../../agent/stateMachine'
import { BasicSafety } from '../../core/safety/safety'
import type { PendingApproval } from '../../core/types'
import {
  APPROVAL_INPUT_PREVIEW_BYTES,
  APPROVAL_REQUEST_ID_SAMPLE,
  KEPT_FILES_DELETE_APPROVAL_TOOL,
  approvalCardBudget,
  keptFilesDeleteInstruction,
  keptFilesDeleteNotification,
  projectApprovalInputPreview,
} from '../approvalInputPreview'

// The delete card as a channel receives it, and whether it fits one message
// there. Channel limits and counting rules are written out here, as
// channel-reader sends the text, not imported from production.
const RULES = {
  // One Telegram message, in UTF-16 code units.
  telegram: { max: 4096, size: (text: string) => text.length },
  // One Slack section block, after the reader escapes `& < >`.
  slack: {
    max: 3000,
    size: (text: string) =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').length,
  },
  // A Teams activity, which carries the text twice: its JSON bytes.
  teams: { max: 12_000, size: (text: string) => Buffer.byteLength(JSON.stringify(text), 'utf8') },
} as const
type Channel = keyof typeof RULES

const REQUEST_ID = '123e4567-e89b-12d3-a456-426614174000'
const REPLY = 'Reply /approve or /deny to this message.'
const CONTROLS = 'Use the approval controls to continue or cancel.'
const CLI_FOR = (requestId: string) =>
  `Request ID: ${requestId}. Please approve via CLI: POST /v1/runtime/approvals/approve`
const CLI = CLI_FOR(REQUEST_ID)
const CUT_LINE = (files: number) =>
  `The list above is cut: it is too long to show whole. Total files: ${files}.`

/** A protected value with no 4-character window found elsewhere on a card. */
const SECRET_ENTRY = { name: 'P', value: 'Qz7vXk9pWm3tLr8J' }

type CardFile = { kind: string; name: string; createdAt?: string; sizeBytes?: number }
type Entry = { name: string; value: string }

const withValues = (files: CardFile[]) =>
  files.map((file, n) => ({
    createdAt: '2026-11-10T09:12:45.123Z',
    sizeBytes: 1_234_567,
    ...file,
    id: String(n).padStart(12, '0'),
  }))

const redactWith = (entries: Entry[]) => {
  const safety = new BasicSafety(() => entries)
  return (text: string) => safety.sanitizeOutput(KEPT_FILES_DELETE_APPROVAL_TOOL, text).content
}

/** The shared predicate on a list of files. */
function card(files: CardFile[], channelType: string | undefined, instruction: string) {
  return keptFilesDeleteNotification(
    { files: withValues(files) },
    redactWith([SECRET_ENTRY]),
    instruction,
    channelType
  )
}

/** The approval text through the state machine, as a channel receives it. */
function notification(
  parameters: Record<string, unknown>,
  channelType: string | undefined,
  defaultPolicy: 'channel_users' | 'cli_only'
): string {
  const proto = AgentStateMachine.prototype as unknown as {
    buildApprovalNotification(a: PendingApproval, u: string, c?: string): string
  }
  return proto.buildApprovalNotification.call(
    {
      approvalConfig: { defaultPolicy, channels: {}, tools: {} },
      secretEntriesProvider: () => [SECRET_ENTRY],
    },
    {
      request_id: REQUEST_ID,
      tool_name: KEPT_FILES_DELETE_APPROVAL_TOOL,
      parameters,
      description: 'delete',
      tool_call_id: 'c',
      context_snapshot: [],
    },
    'user-1',
    channelType
  )
}

/** The Desktop preview of the same call. */
function desktop(files: CardFile[]) {
  return projectApprovalInputPreview(
    KEPT_FILES_DELETE_APPROVAL_TOOL,
    { files: withValues(files) },
    redactWith([SECRET_ENTRY])
  )!
}

function instructionOf(channel: string | undefined, policy: 'channel_users' | 'cli_only') {
  if (policy === 'cli_only') return CLI
  return channel === 'slack' ? CONTROLS : REPLY
}

/**
 * 20 schema-valid files whose card plus `instruction` measures exactly
 * `target` by the channel's written-out rule. Names grow by `n` (one unit in
 * every rule) and, for Teams, by `€` (one UTF-16 unit, three UTF-8 bytes).
 */
function filesMeasuring(channel: Channel, target: number, instruction: string): CardFile[] {
  const files = Array.from({ length: 20 }, (_, n) => ({
    kind: 'upload',
    name: `-${String(n).padStart(2, '0')}`,
  }))
  const size = () => RULES[channel].size(`${desktop(files).text}\n${instruction}`)
  let deficit = target - size()
  for (const file of files) {
    if (deficit <= 0) break
    const room = 255 - file.name.length
    const wide = channel === 'teams' ? Math.min(Math.floor(deficit / 3), room) : 0
    const narrow = Math.min(deficit - wide * 3, room - wide)
    file.name = `${'€'.repeat(wide)}${'n'.repeat(narrow)}${file.name}`
    deficit -= wide * 3 + narrow
  }
  expect(size()).toBe(target)
  return files
}

const ALL_CHANNELS = ['telegram', 'slack', 'teams', 'email', 'rpc', undefined] as const

describe('the kept-files delete card as a channel receives it', () => {
  it.each(ALL_CHANNELS)(
    'U1 gives a small list on %s as the Desktop text and the instruction, and it fits',
    channel => {
      const files = [
        { kind: 'generated', name: 'report.md' },
        { kind: 'upload', name: 'contract.pdf' },
      ]
      for (const policy of ['channel_users', 'cli_only'] as const) {
        const instruction = instructionOf(channel, policy)
        const shared = card(files, channel, instruction)!
        expect(shared.text).toBe(`${desktop(files).text}\n${instruction}`)
        expect(shared.fits).toBe(true)
        if (channel === 'telegram' || channel === 'slack' || channel === 'teams') {
          expect(shared.max).toBe(RULES[channel].max)
          expect(shared.size).toBe(RULES[channel].size(shared.text))
        } else {
          expect(shared.size).toBeUndefined()
          expect(shared.max).toBeUndefined()
        }
        // The state machine sends the same text.
        expect(notification({ files: withValues(files) }, channel, policy)).toBe(shared.text)
      }
    }
  )

  it.each(['telegram', 'slack', 'teams'] as const)(
    'U1 gives the head card on %s for an empty list and for entries that are not files',
    channel => {
      for (const files of [[], [42, null, { kind: 'upload', name: 7 }]]) {
        const parameters = { files }
        const preview = projectApprovalInputPreview(
          KEPT_FILES_DELETE_APPROVAL_TOOL,
          parameters,
          redactWith([SECRET_ENTRY])
        )!
        const text = notification(parameters, channel, 'channel_users')
        expect(text).toBe(`${preview.text}\n${instructionOf(channel, 'channel_users')}`)
        expect(text.split('\n')).toContain(`Total files: ${files.length}`)
      }
    }
  )

  it('U1 has no card for a call without a file list', () => {
    expect(keptFilesDeleteNotification({}, redactWith([]), REPLY, 'telegram')).toBeUndefined()
    expect(
      keptFilesDeleteNotification({ files: 'x' }, redactWith([]), REPLY, 'slack')
    ).toBeUndefined()
  })

  it.each([
    ['telegram', REPLY],
    ['slack', CONTROLS],
    ['teams', REPLY],
  ] as const)(
    'U2 fits a %s card exactly at the limit, and not one a unit longer, which stays whole',
    (channel, instruction) => {
      const max = RULES[channel].max
      const atLimit = filesMeasuring(channel, max, instruction)
      expect(card(atLimit, channel, instruction)).toEqual({
        text: `${desktop(atLimit).text}\n${instruction}`,
        fits: true,
        size: max,
        max,
      })
      const over = filesMeasuring(channel, max + 1, instruction)
      const shared = card(over, channel, instruction)!
      expect(shared).toEqual({
        text: `${desktop(over).text}\n${instruction}`,
        fits: false,
        size: max + 1,
        max,
      })
      for (const file of over) expect(shared.text).toContain(`upload: "${file.name}" — `)
      expect(shared.text.split('\n')).toContain('Total files: 20')
      expect(shared.text.endsWith(`\n${instruction}`)).toBe(true)
      expect(shared.text).not.toContain('…')
    }
  )

  it('U3 measures Slack text after the reader escapes it', () => {
    const files = Array.from({ length: 20 }, (_, n) => ({
      kind: 'upload',
      name: `${'&'.repeat(60)}${String(n).padStart(2, '0')}`,
    }))
    const shared = card(files, 'slack', CONTROLS)!
    expect(shared.text).toBe(`${desktop(files).text}\n${CONTROLS}`)
    // Witness: the raw card fits, the escaped one does not.
    expect(shared.text.length).toBeLessThanOrEqual(3000)
    expect(RULES.slack.size(shared.text)).toBeGreaterThan(3000)
    expect(shared.size).toBe(RULES.slack.size(shared.text))
    expect(shared.fits).toBe(false)
    // The same text fits Telegram, which does not escape it.
    expect(card(files, 'telegram', CONTROLS)!.fits).toBe(true)
  })

  it('U3 measures Teams text in JSON bytes', () => {
    const files = Array.from({ length: 20 }, () => ({ kind: 'upload', name: '"\\é'.repeat(85) }))
    const shared = card(files, 'teams', REPLY)!
    expect(shared.text).toBe(`${desktop(files).text}\n${REPLY}`)
    // Witness: the card is under 12,000 characters but over 12,000 JSON bytes.
    expect(shared.text.length).toBeLessThanOrEqual(12_000)
    expect(RULES.teams.size(shared.text)).toBeGreaterThan(12_000)
    expect(shared.size).toBe(RULES.teams.size(shared.text))
    expect(shared.fits).toBe(false)
  })

  it('U4 measures the instruction: a Slack list that fits under the controls does not under the CLI', () => {
    const files = filesMeasuring('slack', 3000, CONTROLS)
    const controls = card(files, 'slack', CONTROLS)!
    expect(controls.fits).toBe(true)
    expect(controls.size).toBe(3000)
    const cli = card(files, 'slack', CLI)!
    expect(cli.fits).toBe(false)
    expect(cli.size).toBe(3000 + CLI.length - CONTROLS.length)
    expect(cli.text).toBe(`${desktop(files).text}\n${CLI}`)
  })

  it.each([
    [undefined, 'channel_users'],
    ['rpc', 'channel_users'],
    ['email', 'cli_only'],
  ] as const)(
    'U5 keeps the Desktop card cut at 64 KiB with its cut line for channel %s (%s), and it fits',
    (channel, policy) => {
      const instruction = instructionOf(channel, policy)
      const files = Array.from({ length: 300 }, () => ({ kind: 'upload', name: 'x'.repeat(255) }))
      const preview = desktop(files)
      // Witness: the Desktop card is cut.
      expect(preview.truncated).toBe(true)
      expect(Buffer.byteLength(preview.text, 'utf8')).toBeLessThanOrEqual(
        APPROVAL_INPUT_PREVIEW_BYTES
      )
      expect(card(files, channel, instruction)).toEqual({
        text: `${preview.text}\n${CUT_LINE(300)}\n${instruction}`,
        fits: true,
      })
      expect(notification({ files: withValues(files) }, channel, policy)).toBe(
        `${preview.text}\n${CUT_LINE(300)}\n${instruction}`
      )
    }
  )

  it('U6 measures the instruction with a request id sample the size of every real one', () => {
    expect(APPROVAL_REQUEST_ID_SAMPLE).toBe('00000000-0000-0000-0000-000000000000')
    for (const channelType of ['telegram', 'slack', 'teams', 'email', 'rpc', undefined]) {
      expect(
        keptFilesDeleteInstruction({ approveInChannel: false, channelType, requestId: REQUEST_ID })
      ).toBe(CLI)
    }
    expect(
      keptFilesDeleteInstruction({
        approveInChannel: true,
        channelType: 'slack',
        requestId: REQUEST_ID,
      })
    ).toBe('Use the approval controls to continue or cancel.')
    for (const channelType of ['telegram', 'teams', 'email', 'rpc', undefined]) {
      expect(
        keptFilesDeleteInstruction({ approveInChannel: true, channelType, requestId: REQUEST_ID })
      ).toBe('Reply /approve or /deny to this message.')
    }
    const sample = keptFilesDeleteInstruction({
      approveInChannel: false,
      channelType: 'slack',
      requestId: APPROVAL_REQUEST_ID_SAMPLE,
    })
    expect(sample).toBe(
      'Request ID: 00000000-0000-0000-0000-000000000000. Please approve via CLI: POST /v1/runtime/approvals/approve'
    )
    for (let n = 0; n < 20; n += 1) {
      const real = CLI_FOR(randomUUID())
      for (const channel of ['telegram', 'slack', 'teams'] as const) {
        expect(RULES[channel].size(real)).toBe(RULES[channel].size(sample))
      }
    }
  })

  it('P11 counts the shared contract vector as channel-reader does', () => {
    const vector = 'a&&b<c>d"e\\f—g…hé\ni'
    expect(vector.length).toBe(19)
    expect(approvalCardBudget('slack')!.size(vector)).toBe(33)
    expect(approvalCardBudget('teams')!.size(vector)).toBe(29)
    expect(approvalCardBudget('telegram')!.size(vector)).toBe(19)
    expect(RULES.slack.size(vector)).toBe(33)
    expect(RULES.teams.size(vector)).toBe(29)
    expect([4096, 3000, 12_000]).toEqual(
      (['telegram', 'slack', 'teams'] as const).map(channel => approvalCardBudget(channel)!.max)
    )
    for (const none of [undefined, 'rpc', 'email', 'internal']) {
      expect(approvalCardBudget(none)).toBeUndefined()
    }
  })
})
