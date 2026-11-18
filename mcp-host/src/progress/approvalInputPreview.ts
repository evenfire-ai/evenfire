import { BasicSafety } from '../core/safety/safety'
import type { ApprovalInputPreview } from './types'

// Shell commands and kept-file delete calls have no input byte cap when the
// approval is shown. Bound only the approval text: the Desktop preview and the
// delete card are cut at this many bytes. In Telegram, Slack and Teams a delete
// whose card does not fit one message is refused before the approval
// (keptFilesDeleteNotification, buildKeptFilesDeleteTool). Approval
// parameters, their identity and the resumed call remain untouched.
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
    text: bytes.subarray(0, APPROVAL_INPUT_PREVIEW_BYTES).toString('utf8').replace(/�$/u, ''),
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

/**
 * The lines a delete approval shows: a fixed first line, one line per file
 * with its kind and its whole name (each redacted, then escaped by
 * {@link cardValue}; the name quoted), its size and its creation date, and the
 * total. The delete verifies the size and the date against the file before
 * deleting anything, so the card shows the file the call deletes. No id is
 * shown. `files` is the length of the call's file list. Undefined when the
 * call carries no file list.
 */
function keptFilesDeleteApprovalLines(
  parameters: Record<string, unknown>,
  redact: (text: string) => string
): { lines: string[]; redacted: boolean; files: number } | undefined {
  const files = parameters.files
  if (!Array.isArray(files)) return undefined
  let redacted = false
  const lines = ['Delete these files permanently:']
  for (const file of files) {
    const entry = (typeof file === 'object' && file !== null ? file : {}) as Record<string, unknown>
    const kind = typeof entry.kind === 'string' ? entry.kind : 'file'
    const safeKind = redact(kind)
    if (safeKind !== kind) redacted = true
    const raw = typeof entry.name === 'string' ? entry.name : ''
    const safe = redact(raw)
    if (safe !== raw) redacted = true
    lines.push(
      `${cardValue(safeKind)}: "${cardValue(safe)}" — ${shownSize(entry.sizeBytes)}, created ${shownDate(entry.createdAt)}`
    )
  }
  lines.push(`Total files: ${files.length}`)
  return { lines, redacted, files: files.length }
}

/**
 * The text of a delete approval card, the same in Desktop and in channels:
 * the lines of {@link keptFilesDeleteApprovalLines}, joined and cut at
 * {@link APPROVAL_INPUT_PREVIEW_BYTES}. `cut` says the bound was reached,
 * `redacted` that redaction changed a kind or a name, and `files` is the
 * number of files the call lists, which a cut card no longer shows. A channel
 * appends its approve or deny instruction after this text, and before it, for
 * a cut card, a line that says the list is cut and gives `files` as the total;
 * the bound cuts neither. {@link keptFilesDeleteNotification} is where both are
 * appended. Undefined when the call carries no file list.
 */
function keptFilesDeleteApprovalCard(
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
interface ApprovalCardBudget {
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

/**
 * The redaction of every kind and name on a delete card: the tool-output
 * redaction of `sanitizeOutput`, with the configured secrets that
 * `secretEntries` gives on each call.
 */
export function keptFilesDeleteRedactor(
  secretEntries: (() => Array<{ name: string; value: string }>) | undefined
): (text: string) => string {
  const safety = new BasicSafety(secretEntries)
  return text => safety.sanitizeOutput(KEPT_FILES_DELETE_APPROVAL_TOOL, text).content
}

/**
 * The last line of a delete approval: the channel's approve or deny
 * instruction when the channel's users may approve, otherwise the CLI
 * instruction with the request id.
 */
export function keptFilesDeleteInstruction(input: {
  approveInChannel: boolean
  channelType: string | undefined
  requestId: string
}): string {
  if (!input.approveInChannel) {
    return `Request ID: ${input.requestId}. Please approve via CLI: POST /v1/runtime/approvals/approve`
  }
  return input.channelType === 'slack'
    ? 'Use the approval controls to continue or cancel.'
    : 'Reply /approve or /deny to this message.'
}

/**
 * Stands for the request id when the instruction is measured before the
 * approval exists. Every approval id is a `randomUUID()`: 36 ASCII
 * characters, which no channel budget counts differently.
 */
export const APPROVAL_REQUEST_ID_SAMPLE = '00000000-0000-0000-0000-000000000000'

/**
 * The delete approval as a channel receives it, and whether it fits one
 * message there. `text` is the card of {@link keptFilesDeleteApprovalCard},
 * then, when the 64 KiB bound cut it, a line that says so and gives the
 * total, then `instruction`: the same text in every channel. `fits` is
 * measured on that whole text by the channel's budget
 * ({@link approvalCardBudget}); a channel with no message limit always fits,
 * with `size` and `max` undefined. The delete's `validateParams` and the
 * approval notification both build the card here. Undefined when the call
 * carries no file list.
 */
export function keptFilesDeleteNotification(
  parameters: Record<string, unknown>,
  redact: (text: string) => string,
  instruction: string,
  channelType: string | undefined
): { text: string; fits: boolean; size?: number; max?: number } | undefined {
  const card = keptFilesDeleteApprovalCard(parameters, redact)
  if (!card) return undefined
  const text = [
    card.text,
    ...(card.cut
      ? [`The list above is cut: it is too long to show whole. Total files: ${card.files}.`]
      : []),
    instruction,
  ].join('\n')
  const budget = approvalCardBudget(channelType)
  if (!budget) return { text, fits: true }
  const size = budget.size(text)
  return { text, fits: size <= budget.max, size, max: budget.max }
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
