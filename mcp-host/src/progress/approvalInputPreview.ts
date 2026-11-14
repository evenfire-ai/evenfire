import type { ApprovalInputPreview } from './types'

// Shell commands and kept-file delete calls have no input byte cap when the
// approval is shown. Bound only the approval text (the Desktop preview and the
// channel text of the delete card); approval parameters, their identity and the
// resumed call remain untouched.
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

/**
 * The lines a delete approval shows: a fixed first line, one line per file
 * with its kind and its whole name (each redacted, then escaped by
 * {@link cardValue}; the name quoted), its size and its creation date, and the
 * total. The delete verifies the size and the date against the file before
 * deleting anything, so the card shows the file the call deletes. No id is
 * shown. Undefined when the call carries no file list.
 */
function keptFilesDeleteApprovalLines(
  parameters: Record<string, unknown>,
  redact: (text: string) => string
): { lines: string[]; redacted: boolean } | undefined {
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
  return { lines, redacted }
}

/**
 * The text of a delete approval card, the same in Desktop and in channels:
 * the lines of {@link keptFilesDeleteApprovalLines}, joined and cut at
 * {@link APPROVAL_INPUT_PREVIEW_BYTES}. `cut` says the bound was reached and
 * `redacted` that redaction changed a kind or a name. A channel appends its
 * approve or deny instruction after this text, so the bound never cuts it.
 * Undefined when the call carries no file list.
 */
export function keptFilesDeleteApprovalCard(
  parameters: Record<string, unknown>,
  redact: (text: string) => string
): { text: string; cut: boolean; redacted: boolean } | undefined {
  const projected = keptFilesDeleteApprovalLines(parameters, redact)
  if (!projected) return undefined
  const bounded = boundPreviewText(projected.lines.join('\n'))
  return { text: bounded.text, cut: bounded.cut, redacted: projected.redacted }
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
