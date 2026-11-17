import type { ApprovalInputPreview } from './types'

// Shell commands and kept-file delete calls have no input byte cap when the
// approval is shown. Bound only the approval text: the Desktop preview and the
// delete card of a channel with no message limit are cut at this many bytes,
// and in Telegram, Slack and Teams the delete card is fitted to one message
// (keptFilesDeleteChannelNotification). Approval parameters, their identity
// and the resumed call remain untouched.
export const APPROVAL_INPUT_PREVIEW_BYTES = 64 * 1024

/** The tool whose approval shows the name, size and date of every file it deletes. */
export const KEPT_FILES_DELETE_APPROVAL_TOOL = 'clerum__kept_files_delete'

/**
 * Characters a card value never shows as written: the backslash and the quote
 * (the escape character and the name's boundary), control (Cc) and format (Cf)
 * characters, line and paragraph separators (Zl, Zp), default-ignorable code
 * points, and lone surrogates (Cs; with the `u` flag only an unpaired
 * surrogate matches, as in `llm/wellFormedRequestText.ts`).
 */
const UNSAFE_CARD_CHARACTER =
  /[\\"\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Cs}]/gu

/**
 * A value as one visible, well-formed piece of card text, in one pass: `\` is
 * shown as `\\`, `"` as `\"` and every other unsafe character as
 * `\u{HEX}`. Each value therefore has one rendering, a quoted name always
 * ends at its closing quote, and a value cannot start a new line or hide
 * part of itself. It does not stop right-to-left letters from reordering the
 * neutral characters around them.
 */
function cardValue(value: string): string {
  return value.replace(UNSAFE_CARD_CHARACTER, character =>
    character === '\\'
      ? '\\\\'
      : character === '"'
        ? '\\"'
        : `\\u{${character.codePointAt(0)!.toString(16).toUpperCase()}}`
  )
}

/**
 * Text cut to {@link APPROVAL_INPUT_PREVIEW_BYTES} UTF-8 bytes, without a
 * trailing replacement character left by a cut inside a character.
 */
function boundPreviewText(text: string): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= APPROVAL_INPUT_PREVIEW_BYTES) return { text, cut: false }
  return {
    text: bytes
      .subarray(0, APPROVAL_INPUT_PREVIEW_BYTES)
      .toString('utf8')
      .replace(/\uFFFD$/u, ''),
    cut: true,
  }
}

/** A size in a unit and in exact bytes, `1.2 MB (1,234,567 bytes)`; `invalid` when not a size. */
function shownSize(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'invalid'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unit = 0
  let scaled = value
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000
    unit += 1
  }
  const amount = unit === 0 ? String(value) : scaled.toFixed(1)
  return `${amount} ${units[unit]} (${value.toLocaleString('en-US')} bytes)`
}

/** A creation time in UTC to the second, `2026-11-10 09:12:45 UTC`; `invalid` when not a date. */
function shownDate(value: unknown): string {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(at)) return 'invalid'
  return `${new Date(at).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

const DELETE_CARD_HEADER = 'Delete these files permanently:'

/** One file of a delete call, as its card line shows it. */
interface DeleteCardFile {
  /** The kind, redacted and escaped by {@link cardValue}. */
  kind: string
  /** The name, redacted, not yet escaped. */
  name: string
  /** `size, created date`, the end of every line of this file. */
  values: string
}

/**
 * The files of a delete call, each kind and name redacted once. `redacted`
 * says redaction changed a kind or a name. Undefined when the call carries no
 * file list.
 */
function keptFilesDeleteFiles(
  parameters: Record<string, unknown>,
  redact: (text: string) => string
): { files: DeleteCardFile[]; redacted: boolean } | undefined {
  const files = parameters.files
  if (!Array.isArray(files)) return undefined
  let redacted = false
  const shown = files.map(file => {
    const entry = (typeof file === 'object' && file !== null ? file : {}) as Record<string, unknown>
    const kind = typeof entry.kind === 'string' ? entry.kind : 'file'
    const safeKind = redact(kind)
    if (safeKind !== kind) redacted = true
    const raw = typeof entry.name === 'string' ? entry.name : ''
    const safe = redact(raw)
    if (safe !== raw) redacted = true
    return {
      kind: cardValue(safeKind),
      name: safe,
      values: `${shownSize(entry.sizeBytes)}, created ${shownDate(entry.createdAt)}`,
    }
  })
  return { files: shown, redacted }
}

/** A file line, with the name as shown: quoted whole, or shortened by {@link shownName}. */
function deleteCardLine(file: DeleteCardFile, shownName: string): string {
  return `${file.kind}: ${shownName} — ${file.values}`
}

/** A name quoted whole. */
function wholeName(name: string): string {
  return `"${cardValue(name)}"`
}

/**
 * The lines a delete approval shows: a fixed first line, one line per file
 * with its kind and its whole name (each redacted, then escaped by
 * {@link cardValue}; the name quoted), its size and its creation date, and the
 * total. A channel card may shorten the names
 * ({@link keptFilesDeleteChannelNotification}). The delete verifies the size
 * and the date against the file before deleting anything, so the card shows
 * the file the call deletes. No id is shown. `files` is the length of the
 * call's file list. Undefined when the call carries no file list.
 */
function keptFilesDeleteApprovalLines(
  parameters: Record<string, unknown>,
  redact: (text: string) => string
): { lines: string[]; redacted: boolean; files: number } | undefined {
  const projected = keptFilesDeleteFiles(parameters, redact)
  if (!projected) return undefined
  const lines = [
    DELETE_CARD_HEADER,
    ...projected.files.map(file => deleteCardLine(file, wholeName(file.name))),
    `Total files: ${projected.files.length}`,
  ]
  return { lines, redacted: projected.redacted, files: projected.files.length }
}

/**
 * The text of a delete approval card in Desktop and in a channel with no
 * message limit (`email`, `rpc`, or no channel type): the lines of
 * {@link keptFilesDeleteApprovalLines}, joined and cut at
 * {@link APPROVAL_INPUT_PREVIEW_BYTES}. `cut` says the bound was reached,
 * `redacted` that redaction changed a kind or a name, and `files` is the
 * number of files the call lists, which a cut card no longer shows. Such a
 * channel appends its approve or deny instruction after this text, and before
 * it, for a cut card, a line that says the list is cut and gives `files` as
 * the total; the bound cuts neither. Telegram, Slack and Teams show
 * {@link keptFilesDeleteChannelNotification} instead. Undefined when the call
 * carries no file list.
 */
export function keptFilesDeleteApprovalCard(
  parameters: Record<string, unknown>,
  redact: (text: string) => string
): { text: string; cut: boolean; redacted: boolean; files: number } | undefined {
  const projected = keptFilesDeleteApprovalLines(parameters, redact)
  if (!projected) return undefined
  const bounded = boundPreviewText(projected.lines.join('\n'))
  return {
    text: bounded.text,
    cut: bounded.cut,
    redacted: projected.redacted,
    files: projected.files,
  }
}

/** How much text one channel message carries, and how that channel counts it. */
export interface ApprovalCardBudget {
  max: number
  size(text: string): number
}

/** The length of a text after channel-reader's Slack escape of `&`, `<` and `>`. */
function slackEscapedLength(text: string): number {
  let size = text.length
  for (const character of text) {
    if (character === '&') size += 4
    else if (character === '<' || character === '>') size += 3
  }
  return size
}

/**
 * The one-message limit of a channel, counted as channel-reader sends the
 * text; undefined for a channel with no message limit (`email`, `rpc`, or no
 * channel type), whose delete card stays bounded at
 * {@link APPROVAL_INPUT_PREVIEW_BYTES}.
 */
export function approvalCardBudget(
  channelType: string | undefined
): ApprovalCardBudget | undefined {
  switch (channelType) {
    case 'telegram':
      // One Telegram message, in UTF-16 code units.
      return { max: 4096, size: text => text.length }
    case 'slack':
      // One section block, measured after the reader escapes `& < >`.
      return { max: 3000, size: slackEscapedLength }
    case 'teams':
      // The activity carries the text twice (card text and summary).
      return { max: 12_000, size: text => Buffer.byteLength(JSON.stringify(text), 'utf8') }
    default:
      return undefined
  }
}

/** The fewest units a shortened name keeps, head and tail together. */
const NAME_MIN_UNITS = 4

/** The units a name keeps in the last resort: 16 head and 8 tail units, or more tail for a longer extension. */
const NAME_LAST_RESORT_UNITS = 24

/** The redaction markers of `core/safety/safety.ts`; a configured secret's name is a Secret key. */
const REDACTION_MARKER = /\[REDACTED(?::[-._A-Za-z0-9]+)?\]|\[filtered\]/g

const SHORTENED_NOTICE =
  'Some names are shortened: "…" between two quoted parts marks the missing middle.'

/**
 * A redacted name as units: each redaction marker is one unit, every other
 * code point is one unit, so a cut keeps a marker whole or drops it whole and
 * never splits a surrogate pair.
 */
function nameUnits(name: string): string[] {
  const units: string[] = []
  // Loops, not `push(...)`: a name is not schema-checked before the approval,
  // and spreading one argument per code point overflows the call stack.
  const pushCodePoints = (text: string) => {
    for (const codePoint of text) units.push(codePoint)
  }
  let at = 0
  for (const marker of name.matchAll(REDACTION_MARKER)) {
    pushCodePoints(name.slice(at, marker.index))
    units.push(marker[0])
    at = marker.index + marker[0].length
  }
  pushCodePoints(name.slice(at))
  return units
}

/**
 * The units of the final extension, from the last unit that is exactly `.`,
 * when it has 2 to 12 units and is not the whole name; otherwise 0.
 */
function extensionUnits(units: string[]): number {
  const dot = units.lastIndexOf('.')
  const length = units.length - dot
  return dot > 0 && length >= 2 && length <= 12 ? length : 0
}

/**
 * A name as shown with at most `cap` units: whole and quoted when it has no
 * more, otherwise `"head"…"tail"`, the tail keeping the extension whole when
 * `cap` exceeds it. Each piece is escaped after the cut, so no escape is
 * split. The name stays whole when the shortened form does not measure
 * smaller, so a line's size never decreases as `cap` grows.
 */
function shownName(
  units: string[],
  cap: number,
  size: (text: string) => number
): { text: string; shortened: boolean } {
  const whole = wholeName(units.join(''))
  if (units.length <= cap) return { text: whole, shortened: false }
  const tail = Math.min(cap - 1, Math.max(extensionUnits(units), Math.floor(cap / 3)))
  const head = cap - tail
  const shortened = `${wholeName(units.slice(0, head).join(''))}…${wholeName(units.slice(units.length - tail).join(''))}`
  return size(shortened) < size(whole)
    ? { text: shortened, shortened: true }
    : { text: whole, shortened: false }
}

/** The line that replaces the total when the last resort leaves names out. */
function lastResortNote(named: number, total: number): string {
  return total === 1
    ? 'This file is not listed by name here: its line is too long for one message. Approving covers it.'
    : `Only ${named} of ${total} files are listed by name here: the list is too long for one message. Approving covers all ${total} files in the request. To see every name, deny and ask to delete fewer files at a time.`
}

/** A file whose line cannot fit in the message even alone. */
function lastResortPlaceholder(file: DeleteCardFile): string {
  return `File not shown by kind and name (too long for one message) — ${file.values}`
}

/**
 * The delete approval for a channel that shows it as one message, ending
 * with `trailer` (the channel's approve or deny instruction), measured whole
 * by `budget`:
 * 1. the whole card, as in Desktop, when it fits;
 * 2. otherwise every file, with names over a cap shortened in the middle and
 *    a line that says so; the cap is the largest that fits, found by
 *    measuring the card;
 * 3. when no cap fits (names that redaction lengthened, or a list the tool
 *    refuses), the first lines that fit, with names cut at
 *    {@link NAME_LAST_RESORT_UNITS} units, a placeholder for a line too long
 *    to fit alone, and a note that replaces the total and says how many files
 *    are listed by name.
 * Undefined when the call carries no file list.
 */
export function keptFilesDeleteChannelNotification(
  parameters: Record<string, unknown>,
  redact: (text: string) => string,
  trailer: string,
  budget: ApprovalCardBudget
): string | undefined {
  const projected = keptFilesDeleteFiles(parameters, redact)
  if (!projected) return undefined
  const files = projected.files
  const fits = (text: string) => budget.size(text) <= budget.max
  const total = `Total files: ${files.length}`

  const whole = [
    DELETE_CARD_HEADER,
    ...files.map(file => deleteCardLine(file, wholeName(file.name))),
    total,
    trailer,
  ].join('\n')
  if (fits(whole)) return whole

  const units = files.map(file => nameUnits(file.name))
  const card = (lines: string[], shortened: boolean, end: string) =>
    [DELETE_CARD_HEADER, ...lines, ...(shortened ? [SHORTENED_NOTICE] : []), end, trailer].join(
      '\n'
    )
  const cardAt = (cap: number) => {
    const names = units.map(name => shownName(name, cap, budget.size))
    return card(
      files.map((file, n) => deleteCardLine(file, names[n]!.text)),
      names.some(name => name.shortened),
      total
    )
  }

  // A line's size does not decrease as the cap grows, so the caps that fit
  // are the ones up to the largest: a binary search finds it.
  let low = NAME_MIN_UNITS
  let high = units.reduce((longest, name) => Math.max(longest, name.length), 0) - 1
  if (low <= high) {
    let best = cardAt(low)
    if (fits(best)) {
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        const text = cardAt(middle)
        if (fits(text)) {
          low = middle
          best = text
        } else {
          high = middle - 1
        }
      }
      return best
    }
  }

  // Last resort: a line that cannot fit alone, measured with the note it
  // would carry as the only line, is shown as the placeholder; then whole
  // lines are added in order while the card fits.
  const candidates = files.map((file, n) => {
    const name = shownName(units[n]!, NAME_LAST_RESORT_UNITS, budget.size)
    const line = deleteCardLine(file, name.text)
    return fits(card([line], name.shortened, lastResortNote(1, files.length)))
      ? { line, named: true, shortened: name.shortened }
      : { line: lastResortPlaceholder(file), named: false, shortened: false }
  })
  const lastResort = (shown: typeof candidates) =>
    card(
      shown.map(candidate => candidate.line),
      shown.some(candidate => candidate.shortened),
      lastResortNote(shown.filter(candidate => candidate.named).length, files.length)
    )
  let shown: typeof candidates = []
  for (const candidate of candidates) {
    const next = [...shown, candidate]
    if (!fits(lastResort(next))) break
    shown = next
  }
  return lastResort(shown)
}

export function projectApprovalInputPreview(
  toolName: string,
  parameters: Record<string, unknown>,
  redact: (text: string) => string
): ApprovalInputPreview | undefined {
  if (toolName === KEPT_FILES_DELETE_APPROVAL_TOOL) {
    const card = keptFilesDeleteApprovalCard(parameters, redact)
    if (!card) return undefined
    return { text: card.text, truncated: card.cut || card.redacted }
  }
  if (toolName !== 'shell_exec' || typeof parameters.command !== 'string') return undefined
  const command = parameters.command
  // Redact the entire input before limiting it, so the limit cannot split a
  // protected value. A redactor may also shorten or normalize the text.
  const redacted = redact(command)
  const bounded = boundPreviewText(redacted)
  return { text: bounded.text, truncated: bounded.cut || redacted !== command }
}
