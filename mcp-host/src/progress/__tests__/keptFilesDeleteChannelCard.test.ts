import { describe, expect, it } from 'vitest'
import { AgentStateMachine } from '../../agent/stateMachine'
import { BasicSafety } from '../../core/safety/safety'
import type { PendingApproval } from '../../core/types'
import {
  APPROVAL_INPUT_PREVIEW_BYTES,
  KEPT_FILES_DELETE_APPROVAL_TOOL,
  approvalCardBudget,
  keptFilesDeleteChannelNotification,
  projectApprovalInputPreview,
} from '../approvalInputPreview'

// The delete card in Telegram, Slack and Teams: one message per approval.
// Channel limits and counting rules are written out here, as channel-reader
// sends the text, not imported from production.
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
const CLI = `Request ID: ${REQUEST_ID}. Please approve via CLI: POST /v1/runtime/approvals/approve`
const HEADER = 'Delete these files permanently:'
const NOTICE = 'Some names are shortened: "…" between two quoted parts marks the missing middle.'
const VALUES = ' — 1.2 MB (1,234,567 bytes), created 2026-11-10 09:12:45 UTC'
const WIDEST_VALUES = ' — 9007.2 TB (9,007,199,254,740,991 bytes), created 2026-11-10 09:12:45 UTC'
const CUT_LINE = (files: number) =>
  `The list above is cut: it is too long to show whole. Total files: ${files}.`
const PLURAL_NOTE = (named: number, total: number) =>
  `Only ${named} of ${total} files are listed by name here: the list is too long for one message. Approving covers all ${total} files in the request. To see every name, deny and ask to delete fewer files at a time.`
const ONE_FILE_NOTE =
  'This file is not listed by name here: its line is too long for one message. Approving covers it.'
const PLACEHOLDER = `File not shown by kind and name (too long for one message)${VALUES}`

/** A protected value with no 4-character window found elsewhere on a card. */
const SECRET = 'Qz7vXk9pWm3tLr8J'
const SECRET_ENTRY = { name: 'P', value: SECRET }
/** A short protected value whose marker is 68 characters: redaction lengthens it. */
const GROWING_ENTRY = {
  name: 'A_VERY_LONG_OPERATOR_SECRET_ENTRY_NAME_FOR_THE_PROBE_0001',
  value: 'q7Zx',
}

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

/** The approval text through the state machine, as a channel receives it. */
function notification(
  files: CardFile[] | unknown[],
  channelType: string | undefined,
  defaultPolicy: 'channel_users' | 'cli_only' = 'channel_users',
  entries: Entry[] = [SECRET_ENTRY]
): string {
  const proto = AgentStateMachine.prototype as unknown as {
    buildApprovalNotification(a: PendingApproval, u: string, c?: string): string
  }
  return proto.buildApprovalNotification.call(
    {
      approvalConfig: { defaultPolicy, channels: {}, tools: {} },
      secretEntriesProvider: () => entries,
    },
    {
      request_id: REQUEST_ID,
      tool_name: KEPT_FILES_DELETE_APPROVAL_TOOL,
      parameters: {
        files: (files as unknown[]).every(file => typeof file === 'object' && file !== null)
          ? withValues(files as CardFile[])
          : files,
      },
      description: 'delete',
      tool_call_id: 'c',
      context_snapshot: [],
    },
    'user-1',
    channelType
  )
}

/** The Desktop preview of the same call. */
function desktop(files: CardFile[], entries: Entry[] = [SECRET_ENTRY]) {
  return projectApprovalInputPreview(
    KEPT_FILES_DELETE_APPROVAL_TOOL,
    { files: withValues(files) },
    redactWith(entries)
  )!
}

function trailerOf(channel: string, policy: 'channel_users' | 'cli_only'): string {
  if (policy === 'cli_only') return CLI
  return channel === 'slack' ? CONTROLS : REPLY
}

type Piece = { raw: string; value: string }

/** One quoted piece at `at`, decoded by the inverse of the card escape. */
function quotedPiece(line: string, at: number): Piece & { end: number } {
  if (line[at] !== '"') throw new Error(`no opening quote at ${at}: ${line}`)
  let value = ''
  let index = at + 1
  while (index < line.length) {
    const character = line[index]!
    if (character === '"') return { raw: line.slice(at + 1, index), value, end: index + 1 }
    if (character !== '\\') {
      value += character
      index += 1
      continue
    }
    const next = line[index + 1]
    if (next === '\\' || next === '"') {
      value += next
      index += 2
      continue
    }
    const hex = /^u\{([0-9A-F]+)\}/.exec(line.slice(index + 1))
    if (!hex) throw new Error(`unknown escape: ${line.slice(index, index + 12)}`)
    value += String.fromCodePoint(Number.parseInt(hex[1]!, 16))
    index += 1 + hex[0].length
  }
  throw new Error(`a quoted piece is never closed: ${line}`)
}

/**
 * A file line: `kind: "name" — values` or `kind: "head"…"tail" — values`.
 * Throws on any other shape.
 */
function fileLine(line: string): { kind: string; head: Piece; tail?: Piece; values: string } {
  const colon = line.indexOf(': "')
  if (colon < 0) throw new Error(`not a file line: ${line}`)
  const head = quotedPiece(line, colon + 2)
  let end = head.end
  let tail: (Piece & { end: number }) | undefined
  if (line.startsWith('…"', end)) {
    tail = quotedPiece(line, end + 1)
    end = tail.end
  }
  if (!line.startsWith(' — ', end)) throw new Error(`no values after the name: ${line}`)
  return { kind: line.slice(0, colon), head, tail, values: line.slice(end) }
}

/** The file lines of a card: every line between the header and the first fixed line. */
function fileLines(text: string): string[] {
  const lines = text.split('\n')
  expect(lines[0]).toBe(HEADER)
  const end = lines.findIndex(
    (line, n) =>
      n > 0 &&
      (line === NOTICE ||
        line.startsWith('Total files: ') ||
        line.startsWith('Only ') ||
        line === ONE_FILE_NOTE)
  )
  expect(end).toBeGreaterThan(0)
  return lines.slice(1, end)
}

/** The notice is on the card exactly when a shown name is shortened, once. */
function expectNoticeIffShortened(text: string): void {
  const shortened = fileLines(text).some(
    line => !line.startsWith('File not shown') && fileLine(line).tail !== undefined
  )
  expect(text.split('\n').filter(line => line === NOTICE)).toHaveLength(shortened ? 1 : 0)
}

/** A card with ASCII names (no escape, no `& < >`) at `cap`, rendered by the written-out rule. */
function renderAscii(
  files: CardFile[],
  cap: number,
  trailer: string,
  size: (text: string) => number
): string {
  let shortened = false
  const lines = files.map(file => {
    const whole = `"${file.name}"`
    let shown = whole
    if (file.name.length > cap) {
      const dot = file.name.lastIndexOf('.')
      const extension = file.name.length - dot
      const ext = dot > 0 && extension >= 2 && extension <= 12 ? extension : 0
      const tail = Math.min(cap - 1, Math.max(ext, Math.floor(cap / 3)))
      const short = `"${file.name.slice(0, cap - tail)}"…"${file.name.slice(file.name.length - tail)}"`
      if (size(short) < size(whole)) {
        shown = short
        shortened = true
      }
    }
    return `${file.kind}: ${shown}${VALUES}`
  })
  return [
    HEADER,
    ...lines,
    ...(shortened ? [NOTICE] : []),
    `Total files: ${files.length}`,
    trailer,
  ].join('\n')
}

/** Every 4-character window of `value`. */
function windows(value: string): string[] {
  return Array.from({ length: value.length - 3 }, (_, n) => value.slice(n, n + 4))
}

const pad = (n: number) => String(n).padStart(5, '0')
const COLUMNS = [
  ['telegram', 'channel_users'],
  ['telegram', 'cli_only'],
  ['slack', 'channel_users'],
  ['slack', 'cli_only'],
  ['teams', 'channel_users'],
  ['teams', 'cli_only'],
] as const

describe('the kept-files delete card in a channel with a one-message limit', () => {
  // S1
  const ROWS = {
    ascii: {
      files: Array.from({ length: 20 }, (_, n) => ({
        kind: 'upload',
        name: `${'x'.repeat(250)}${pad(n)}`,
      })),
      values: VALUES,
    },
    ampersands: {
      files: Array.from({ length: 20 }, (_, n) => ({
        kind: 'upload',
        name: `${'&'.repeat(250)}${pad(n)}`,
      })),
      values: VALUES,
    },
    // The widest schema-valid name: each character escapes to `\u{E0001}`.
    widest: {
      files: Array.from({ length: 20 }, () => ({
        kind: 'generated',
        name: '\u{E0001}'.repeat(255),
        sizeBytes: Number.MAX_SAFE_INTEGER,
      })),
      values: WIDEST_VALUES,
    },
  }
  const WHOLE = new Set(['teams ascii', 'teams ampersands'])

  it.each(
    COLUMNS.flatMap(([channel, policy]) =>
      (Object.keys(ROWS) as Array<keyof typeof ROWS>).map(row => [channel, policy, row] as const)
    )
  )('lists all 20 files of 255 units on one %s message (%s, %s names)', (channel, policy, row) => {
    const { files, values } = ROWS[row]
    const rule = RULES[channel]
    const trailer = trailerOf(channel, policy)
    const text = notification(files, channel, policy)
    const head = `${desktop(files).text}\n${trailer}`
    expect(rule.size(text)).toBeLessThanOrEqual(rule.max)
    const lines = fileLines(text)
    expect(lines).toHaveLength(20)
    lines.forEach((line, n) => {
      const shown = fileLine(line)
      expect(shown.kind).toBe(files[n]!.kind)
      expect(shown.values).toBe(values)
      expect(files[n]!.name.startsWith(shown.head.value)).toBe(true)
      if (shown.tail) expect(files[n]!.name.endsWith(shown.tail.value)).toBe(true)
      else expect(shown.head.value).toBe(files[n]!.name)
    })
    expect(text).not.toContain('listed by name here')
    expectNoticeIffShortened(text)
    if (WHOLE.has(`${channel} ${row}`)) {
      // Teams carries these names whole: nothing is shortened.
      expect(rule.size(head)).toBeLessThanOrEqual(rule.max)
      expect(text).toBe(head)
    } else {
      // Witness: the whole card is over the limit.
      expect(rule.size(head)).toBeGreaterThan(rule.max)
      expect(text.split('\n').slice(21)).toEqual([NOTICE, 'Total files: 20', trailer])
      expect(lines.every(line => fileLine(line).tail !== undefined)).toBe(true)
    }
  })

  // S2
  /**
   * One file with an ASCII name on a Telegram-counted message whose room fits
   * exactly `cap` shortened units.
   */
  function capped(name: string, cap: number): string {
    const fixed = [HEADER, `upload: ${VALUES}`, NOTICE, 'Total files: 1', REPLY].join('\n').length
    // `"head"…"tail"` is cap + 5 characters.
    const max = fixed + cap + 5
    return keptFilesDeleteChannelNotification(
      { files: withValues([{ kind: 'upload', name }]) },
      text => text,
      REPLY,
      { max, size: text => text.length }
    )!
  }

  it.each([
    ['.docx', `${'a'.repeat(250)}.docx`, 10, 'aaaaa', '.docx'],
    ['the last extension of .tar.gz', `${'a'.repeat(248)}.tar.gz`, 10, 'aaaaaaa', '.gz'],
    [
      '.tar.gz once a third of the cap covers it',
      `${'a'.repeat(248)}.tar.gz`,
      21,
      'a'.repeat(14),
      '.tar.gz',
    ],
    ['a 12-unit extension', `${'a'.repeat(243)}.abcdefghijk`, 24, 'a'.repeat(12), '.abcdefghijk'],
    [
      'no extension past 12 units',
      `${'a'.repeat(242)}.abcdefghijkl`,
      24,
      'a'.repeat(16),
      'fghijkl'.padStart(8, 'e'),
    ],
    ['no dot', `${'a'.repeat(240)}bcdefghijklmnop`, 10, 'aaaaaaa', 'nop'],
  ])('keeps the extension whole after the marker: %s', (_, name, cap, head, tail) => {
    const lines = fileLines(capped(name, cap))
    expect(lines).toEqual([`upload: "${head}"…"${tail}"${VALUES}`])
  })

  it('keeps the extension of every shortened name in Slack', () => {
    const files = Array.from({ length: 20 }, (_, n) => ({
      kind: 'upload',
      name: `${'r'.repeat(245)}${pad(n)}.docx`,
    }))
    const lines = fileLines(notification(files, 'slack'))
    expect(lines).toHaveLength(20)
    lines.forEach((line, n) => {
      const shown = fileLine(line)
      expect(shown.tail!.value.endsWith(`${pad(n)}.docx`)).toBe(true)
    })
  })

  // S3
  /** Every redaction marker in a piece is whole: no `[` or `]` is left once whole markers are removed. */
  function expectWholeMarkers(text: string): void {
    for (const line of fileLines(text)) {
      if (line.startsWith('File not shown')) continue
      const shown = fileLine(line)
      for (const piece of [shown.head, ...(shown.tail ? [shown.tail] : [])]) {
        expect(
          piece.raw.replace(/\[REDACTED(?::[-._A-Za-z0-9]+)?\]|\[filtered\]/g, '')
        ).not.toMatch(/[[\]]/)
      }
    }
  }

  it('keeps or drops a redaction marker whole at the cut', () => {
    const redact = redactWith([SECRET_ENTRY])
    const fixed = [HEADER, `upload: ${VALUES}`, NOTICE, 'Total files: 1', REPLY].join('\n').length
    const card = (name: string, shownName: string) =>
      keptFilesDeleteChannelNotification(
        { files: withValues([{ kind: 'upload', name }]) },
        redact,
        REPLY,
        { max: fixed + shownName.length, size: text => text.length }
      )!
    // Cap 10: 7 head and 3 tail units, a marker being one unit.
    const atHead = `ab${SECRET}${'c'.repeat(237)}`
    const headShown = '"ab[REDACTED:P]cccc"…"ccc"'
    expect(fileLines(card(atHead, headShown))).toEqual([`upload: ${headShown}${VALUES}`])
    const atTail = `${'c'.repeat(237)}${SECRET}yz`
    const tailShown = '"ccccccc"…"[REDACTED:P]yz"'
    expect(fileLines(card(atTail, tailShown))).toEqual([`upload: ${tailShown}${VALUES}`])
    for (const text of [card(atHead, headShown), card(atTail, tailShown)]) {
      expectWholeMarkers(text)
      expect(text).not.toContain(SECRET)
    }
  })

  it('keeps every marker whole in Slack, wherever it sits around the cut', () => {
    // The marker moves one unit per file across the head boundary.
    const files = Array.from({ length: 20 }, (_, n) => ({
      kind: 'upload',
      name: `${'c'.repeat(30 + n)}${SECRET}${'d'.repeat(209 - n)}`,
    }))
    const text = notification(files, 'slack')
    const lines = fileLines(text)
    expect(lines).toHaveLength(20)
    // Witness: markers are shown, and some files keep theirs in the head.
    expect(text).toContain('[REDACTED:P]')
    expectWholeMarkers(text)
    expect(text).not.toContain(SECRET)
  })

  // S3b
  it('redacts before shortening, so no fragment of a protected value crosses the cut', () => {
    // In Slack the head keeps about 45 units: the value starts on both sides of the cut.
    const files = Array.from({ length: 20 }, (_, n) => ({
      kind: 'upload',
      name: `${'e'.repeat(30 + n)}${SECRET}${'f'.repeat(209 - n)}`,
    }))
    for (const channel of ['slack', 'telegram'] as const) {
      const text = notification(files, channel)
      for (const window of windows(SECRET)) expect(text).not.toContain(window)
      // Witness: the marker is shown where the value was, and every line parses.
      expect(text).toContain('[REDACTED:P]')
      expect(fileLines(text).map(fileLine)).toHaveLength(20)
    }
  })

  // S4
  it('never splits an escape or a surrogate pair, and each piece decodes to part of the name', () => {
    const name = `😀"\\\u{E0001}é`.repeat(51)
    const files = Array.from({ length: 20 }, () => ({ kind: 'upload', name }))
    for (const channel of ['telegram', 'slack', 'teams'] as const) {
      const text = notification(files, channel)
      expect(text.isWellFormed()).toBe(true)
      expect(RULES[channel].size(text)).toBeLessThanOrEqual(RULES[channel].max)
      const lines = fileLines(text)
      expect(lines).toHaveLength(20)
      for (const line of lines) {
        const shown = fileLine(line)
        expect(shown.tail).toBeDefined()
        expect(name.startsWith(shown.head.value)).toBe(true)
        expect(name.endsWith(shown.tail!.value)).toBe(true)
        // Whole code points only.
        expect(shown.head.value.isWellFormed()).toBe(true)
        expect(shown.tail!.value.isWellFormed()).toBe(true)
      }
    }
  })

  it('shows a name with a literal … or quote whole and decodable, and shortens it the same way', () => {
    const short = [
      { kind: 'upload', name: 'a…b"c.md' },
      { kind: 'upload', name: '"…"' },
    ]
    for (const channel of ['telegram', 'slack', 'teams'] as const) {
      const text = notification(short, channel)
      expect(text).toBe(`${desktop(short).text}\n${trailerOf(channel, 'channel_users')}`)
      expect(fileLines(text).map(line => fileLine(line).head.value)).toEqual(['a…b"c.md', '"…"'])
    }
    const long = Array.from({ length: 20 }, () => ({ kind: 'upload', name: '…"x'.repeat(85) }))
    const text = notification(long, 'slack')
    for (const line of fileLines(text)) {
      const shown = fileLine(line)
      expect('…"x'.repeat(85).startsWith(shown.head.value)).toBe(true)
      expect('…"x'.repeat(85).endsWith(shown.tail!.value)).toBe(true)
    }
  })

  // S5
  it.each([
    ['telegram', 'channel_users'],
    ['slack', 'channel_users'],
    ['slack', 'cli_only'],
  ] as const)('shortens to the largest cap that fits on %s (%s)', (channel, policy) => {
    const files = Array.from({ length: 20 }, (_, n) => ({
      kind: 'upload',
      name: `${'y'.repeat(60 + 9 * n)}${String(n).padStart(2, '0')}`,
    }))
    const rule = RULES[channel]
    const trailer = trailerOf(channel, policy)
    const text = notification(files, channel, policy)
    const caps = fileLines(text)
      .map(fileLine)
      .filter(shown => shown.tail)
      .map(shown => shown.head.value.length + shown.tail!.value.length)
    expect(caps.length).toBeGreaterThan(0)
    const cap = Math.max(...caps)
    // The written-out rule renders the same card at that cap, and the next cap does not fit.
    expect(renderAscii(files, cap, trailer, rule.size)).toBe(text)
    expect(rule.size(text)).toBeLessThanOrEqual(rule.max)
    expect(rule.size(renderAscii(files, cap + 1, trailer, rule.size))).toBeGreaterThan(rule.max)
  })

  it('shows three names of 255 units whole in Slack, with no notice', () => {
    const files = Array.from({ length: 3 }, (_, n) => ({
      kind: 'upload',
      name: `${'z'.repeat(250)}${pad(n)}`,
    }))
    const text = notification(files, 'slack')
    expect(text).toBe(`${desktop(files).text}\n${CONTROLS}`)
    expect(text).not.toContain(NOTICE)
    // Witness: twenty such names are shortened, with the notice.
    const twenty = Array.from({ length: 20 }, (_, n) => ({
      kind: 'upload',
      name: `${'z'.repeat(250)}${pad(n)}`,
    }))
    expect(notification(twenty, 'slack')).toContain(NOTICE)
  })

  // S5b
  it('shows a name only one or two units over the cap whole', () => {
    const files = [
      { kind: 'upload', name: 'a'.repeat(255) },
      { kind: 'upload', name: 'b'.repeat(31) },
      { kind: 'upload', name: 'c'.repeat(32) },
    ]
    const size = (text: string) => text.length
    // Room for exactly cap 30: the 255-unit name is shortened, the other two are shorter whole.
    const expected = renderAscii(files, 30, REPLY, size)
    const text = keptFilesDeleteChannelNotification(
      { files: withValues(files) },
      value => value,
      REPLY,
      { max: expected.length, size }
    )!
    expect(text).toBe(expected)
    expect(fileLines(text)).toEqual([
      `upload: "${'a'.repeat(20)}"…"${'a'.repeat(10)}"${VALUES}`,
      `upload: "${'b'.repeat(31)}"${VALUES}`,
      `upload: "${'c'.repeat(32)}"${VALUES}`,
    ])
    for (const line of fileLines(text)) {
      const shown = fileLine(line)
      if (shown.tail)
        expect(line.length).toBeLessThan(`upload: "${'a'.repeat(255)}"${VALUES}`.length)
    }
    expectNoticeIffShortened(text)
  })

  // S7
  it('takes the last resort only when no cap fits: names that redaction lengthened', () => {
    const files = Array.from({ length: 20 }, (_, n) => ({
      kind: n % 2 ? 'upload' : 'generated',
      name: `${GROWING_ENTRY.value.repeat(63)}abc`,
    }))
    for (const channel of ['telegram', 'slack'] as const) {
      const text = notification(files, channel, 'channel_users', [GROWING_ENTRY])
      expect(RULES[channel].size(text)).toBeLessThanOrEqual(RULES[channel].max)
      const named = fileLines(text).filter(line => !line.startsWith('File not shown'))
      expect(named.length).toBeGreaterThan(0)
      expect(named.length).toBeLessThan(20)
      expect(text.split('\n').slice(-2)).toEqual([PLURAL_NOTE(named.length, 20), REPLY_OR(channel)])
      expect(text).not.toContain(GROWING_ENTRY.value)
      expect(text).toContain(`[REDACTED:${GROWING_ENTRY.name}]`)
      // Witness: the same names with nothing to protect are all listed, shortened.
      const plain = notification(files, channel, 'channel_users', [])
      expect(fileLines(plain)).toHaveLength(20)
      expect(plain.split('\n').slice(-3)).toEqual([NOTICE, 'Total files: 20', REPLY_OR(channel)])
    }
  })

  it('takes the last resort when the kept units are wide markers, though redaction shortened the names', () => {
    const value = 'Wv3Lq8Zr'.repeat(10)
    const entry = { name: `K${'0'.repeat(59)}`, value }
    const files = Array.from({ length: 20 }, () => ({
      kind: 'upload',
      name: `${value.repeat(3)}${'x'.repeat(15)}`,
    }))
    // Witness: redaction makes the name shorter (3 × 72 + 15 < 255).
    expect(redactWith([entry])(files[0]!.name).length).toBeLessThan(files[0]!.name.length)
    for (const channel of ['telegram', 'slack'] as const) {
      const text = notification(files, channel, 'channel_users', [entry])
      expect(RULES[channel].size(text)).toBeLessThanOrEqual(RULES[channel].max)
      expect(text).toContain('files are listed by name here')
      for (const window of windows(value)) expect(text).not.toContain(window)
      expect(text).toContain(`[REDACTED:${entry.name}]`)
    }
  })

  it('names the first files of a list the tool refuses, 16 head and 8 tail units each', () => {
    const files = Array.from({ length: 300 }, () => ({ kind: 'upload', name: 'x'.repeat(255) }))
    const text = notification(files, 'slack')
    expect(RULES.slack.size(text)).toBeLessThanOrEqual(RULES.slack.max)
    const lines = fileLines(text)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toBe(`upload: "${'x'.repeat(16)}"…"${'x'.repeat(8)}"${VALUES}`)
    }
    expect(text.split('\n').slice(-3)).toEqual([NOTICE, PLURAL_NOTE(lines.length, 300), CONTROLS])
  })

  it('goes straight to the last resort when no name is longer than the minimum', () => {
    const files = Array.from({ length: 300 }, () => ({ kind: 'upload', name: 'x' }))
    const text = notification(files, 'slack')
    expect(RULES.slack.size(text)).toBeLessThanOrEqual(RULES.slack.max)
    const lines = fileLines(text)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toBe(`upload: "x"${VALUES}`)
    expect(text.split('\n').slice(-2)).toEqual([PLURAL_NOTE(lines.length, 300), CONTROLS])
    expect(text).not.toContain(NOTICE)
  })

  // S8
  it('shows a placeholder for a kind too long for one message, with the one-file note', () => {
    const files = [{ kind: 'k'.repeat(5000), name: 'a.md' }]
    expect(notification(files, 'telegram')).toBe(
      [HEADER, PLACEHOLDER, ONE_FILE_NOTE, REPLY].join('\n')
    )
  })

  it('counts only the files listed by name in the note', () => {
    const files = [
      { kind: 'k'.repeat(5000), name: 'a.md' },
      { kind: 'upload', name: 'b.md' },
      { kind: 'generated', name: 'c.md' },
    ]
    expect(notification(files, 'telegram')).toBe(
      [
        HEADER,
        PLACEHOLDER,
        `upload: "b.md"${VALUES}`,
        `generated: "c.md"${VALUES}`,
        PLURAL_NOTE(2, 3),
        REPLY,
      ].join('\n')
    )
  })

  it('shows a placeholder for a name too long for one message even at the last-resort cap', () => {
    // A marker of 251 characters: 24 kept units cannot fit in one message.
    const entry = { name: `M${'1'.repeat(239)}`, value: 'Zq9w' }
    const files = Array.from({ length: 20 }, () => ({
      kind: 'upload',
      name: `${entry.value.repeat(63)}abc`,
    }))
    const text = notification(files, 'telegram', 'channel_users', [entry])
    const lines = fileLines(text)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toBe(PLACEHOLDER)
    expect(text.split('\n').slice(-2)).toEqual([PLURAL_NOTE(0, 20), REPLY])
    expect(text).not.toContain(NOTICE)
    expect(text).not.toContain(entry.value)
    expect(RULES.telegram.size(text)).toBeLessThanOrEqual(RULES.telegram.max)
  })

  // P2
  /** 20 files whose whole card plus `trailer` measures `target` on Telegram. */
  function filesMeasuring(target: number, trailer: string): CardFile[] {
    const files = Array.from({ length: 20 }, (_, n) => ({
      kind: 'upload',
      name: `${'n'.repeat(120)}-${String(n).padStart(2, '0')}`,
    }))
    const base = `${desktop(files).text}\n${trailer}`.length
    files[19]!.name = `${'m'.repeat(target - base)}${files[19]!.name}`
    expect(`${desktop(files).text}\n${trailer}`.length).toBe(target)
    return files
  }

  it('returns a card exactly at the limit whole, and shortens one a character longer', () => {
    const atLimit = filesMeasuring(4096, REPLY)
    const text = notification(atLimit, 'telegram')
    expect(text).toBe(`${desktop(atLimit).text}\n${REPLY}`)
    expect(text).not.toContain(NOTICE)
    const over = filesMeasuring(4097, REPLY)
    const shortened = notification(over, 'telegram')
    expect(shortened).toContain(NOTICE)
    expect(fileLines(shortened)).toHaveLength(20)
    expect(RULES.telegram.size(shortened)).toBeLessThanOrEqual(4096)
  })

  // P3
  it('measures Slack text after the reader escapes it', () => {
    const files = Array.from({ length: 20 }, (_, n) => ({
      kind: 'upload',
      name: `${'&'.repeat(60)}${String(n).padStart(2, '0')}`,
    }))
    const whole = `${desktop(files).text}\n${CONTROLS}`
    // Witness: the raw card fits, the escaped one does not.
    expect(whole.length).toBeLessThanOrEqual(3000)
    expect(RULES.slack.size(whole)).toBeGreaterThan(3000)
    const text = notification(files, 'slack')
    expect(text).toContain(NOTICE)
    expect(RULES.slack.size(text)).toBeLessThanOrEqual(3000)
    expect(fileLines(text)).toHaveLength(20)
  })

  // P4
  it('measures Teams text in JSON bytes', () => {
    const files = Array.from({ length: 20 }, () => ({ kind: 'upload', name: '"\\é'.repeat(85) }))
    const whole = `${desktop(files).text}\n${REPLY}`
    // Witness: the whole card is under 12,000 characters but over 12,000 JSON bytes.
    expect(whole.length).toBeLessThanOrEqual(12_000)
    expect(RULES.teams.size(whole)).toBeGreaterThan(12_000)
    const text = notification(files, 'teams')
    expect(text).toContain(NOTICE)
    expect(RULES.teams.size(text)).toBeLessThanOrEqual(12_000)
    expect(fileLines(text)).toHaveLength(20)
  })

  // P5
  it('measures the CLI trailer like any other', () => {
    const files = filesMeasuring(4096, REPLY)
    expect(notification(files, 'telegram')).toBe(`${desktop(files).text}\n${REPLY}`)
    const cli = notification(files, 'telegram', 'cli_only')
    expect(cli).toContain(NOTICE)
    expect(cli.endsWith(`\nTotal files: 20\n${CLI}`)).toBe(true)
    expect(RULES.telegram.size(cli)).toBeLessThanOrEqual(4096)
  })

  // P6
  it('fits a card that redaction lengthened near the limit', () => {
    const files = Array.from({ length: 20 }, (_, n) => ({
      kind: 'upload',
      name: `${GROWING_ENTRY.value}${'n'.repeat(120)}${String(n).padStart(2, '0')}`,
    }))
    // Witness: unredacted, the card fits; redacted, it does not.
    expect(`${desktop(files, []).text}\n${REPLY}`.length).toBeLessThanOrEqual(4096)
    expect(`${desktop(files, [GROWING_ENTRY]).text}\n${REPLY}`.length).toBeGreaterThan(4096)
    const text = notification(files, 'telegram', 'channel_users', [GROWING_ENTRY])
    expect(RULES.telegram.size(text)).toBeLessThanOrEqual(4096)
    expect(text).toContain(`[REDACTED:${GROWING_ENTRY.name}]`)
    expect(text).not.toContain(GROWING_ENTRY.value)
    expect(fileLines(text)).toHaveLength(20)
  })

  // P9
  it.each([
    [undefined, 'channel_users', REPLY],
    ['rpc', 'channel_users', REPLY],
    ['email', 'cli_only', CLI],
  ] as const)(
    'keeps the Desktop card cut at 64 KiB with its cut line for channel %s (%s)',
    (channel, policy, trailer) => {
      const files = Array.from({ length: 300 }, () => ({ kind: 'upload', name: 'x'.repeat(255) }))
      const preview = desktop(files)
      // Witness: the Desktop card is cut.
      expect(preview.truncated).toBe(true)
      expect(Buffer.byteLength(preview.text, 'utf8')).toBeLessThanOrEqual(
        APPROVAL_INPUT_PREVIEW_BYTES
      )
      expect(notification(files, channel, policy)).toBe(
        `${preview.text}\n${CUT_LINE(300)}\n${trailer}`
      )
      const small = [{ kind: 'upload', name: 'x'.repeat(255) }]
      expect(notification(small, channel, policy)).toBe(`${desktop(small).text}\n${trailer}`)
    }
  )

  // P10
  it.each(COLUMNS)(
    'gives a small card on %s (%s) as the Desktop text and the trailer',
    (channel, policy) => {
      const files = [
        { kind: 'generated', name: 'report.md' },
        { kind: 'upload', name: 'contract.pdf' },
      ]
      const text = notification(files, channel, policy)
      expect(text).toBe(`${desktop(files).text}\n${trailerOf(channel, policy)}`)
      expect(text).not.toContain(NOTICE)
      expect(text).not.toContain('…')
    }
  )

  it.each(['telegram', 'slack', 'teams'] as const)(
    'gives the head card on %s for an empty list and for entries that are not files',
    channel => {
      for (const files of [[], [42, null, { kind: 'upload', name: 7 }]]) {
        const parameters = { files }
        const preview = projectApprovalInputPreview(
          KEPT_FILES_DELETE_APPROVAL_TOOL,
          parameters,
          redactWith([SECRET_ENTRY])
        )!
        const proto = AgentStateMachine.prototype as unknown as {
          buildApprovalNotification(a: PendingApproval, u: string, c?: string): string
        }
        const text = proto.buildApprovalNotification.call(
          {
            approvalConfig: { defaultPolicy: 'channel_users', channels: {}, tools: {} },
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
          channel
        )
        expect(text).toBe(`${preview.text}\n${trailerOf(channel, 'channel_users')}`)
        expect(text.split('\n')).toContain(`Total files: ${files.length}`)
      }
    }
  )

  // P11
  it('counts the shared contract vector as channel-reader does', () => {
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

function REPLY_OR(channel: Channel): string {
  return channel === 'slack' ? CONTROLS : REPLY
}
