import type { ApprovalInputPreview } from './types'

// Shell commands have no declared input byte cap. Bound only this UI projection;
// approval parameters, their identity and the resumed command remain untouched.
export const APPROVAL_INPUT_PREVIEW_BYTES = 64 * 1024

/** The tool whose approval shows the name, size and date of every file it deletes. */
export const KEPT_FILES_DELETE_APPROVAL_TOOL = 'clerum__kept_files_delete'

/**
 * A name as one visible card value: every control or format character (line
 * breaks, bidi controls, joiners) is shown as its escape, so a name cannot
 * start a new line, reorder the line or hide part of itself.
 */
function visibleName(name: string): string {
  return name.replace(
    /[\p{Cc}\p{Cf}]/gu,
    character => `\\u{${character.codePointAt(0)!.toString(16).toUpperCase()}}`
  )
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
 * The lines a delete approval shows, in Desktop and in channels: a fixed first
 * line, one line per file with its whole name (redacted, then with control
 * and format characters escaped, and quoted), its size and its creation date,
 * and the total. The delete verifies the size and the date against the file
 * before deleting anything, so the card shows the file the call deletes. No
 * id is shown. Undefined when the call carries no file list.
 */
export function keptFilesDeleteApprovalLines(
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
    const raw = typeof entry.name === 'string' ? entry.name : ''
    const safe = redact(raw)
    if (safe !== raw) redacted = true
    lines.push(
      `${redact(kind)}: "${visibleName(safe)}" — ${shownSize(entry.sizeBytes)}, created ${shownDate(entry.createdAt)}`
    )
  }
  lines.push(`Total files: ${files.length}`)
  return { lines, redacted }
}

export function projectApprovalInputPreview(
  toolName: string,
  parameters: Record<string, unknown>,
  redact: (text: string) => string
): ApprovalInputPreview | undefined {
  if (toolName === KEPT_FILES_DELETE_APPROVAL_TOOL) {
    const projected = keptFilesDeleteApprovalLines(parameters, redact)
    if (!projected) return undefined
    const whole = projected.lines.join('\n')
    const bytes = Buffer.from(whole, 'utf8')
    const cut = bytes.byteLength > APPROVAL_INPUT_PREVIEW_BYTES
    const text = cut
      ? bytes.subarray(0, APPROVAL_INPUT_PREVIEW_BYTES).toString('utf8').replace(/�$/u, '')
      : whole
    return { text, truncated: cut || projected.redacted }
  }
  if (toolName !== 'shell_exec' || typeof parameters.command !== 'string') return undefined
  const command = parameters.command
  // Redact the entire input before limiting it, so the limit cannot split a
  // protected value. A redactor may also shorten or normalize the text.
  const redacted = redact(command)
  const bytes = Buffer.from(redacted, 'utf8')
  const shortened = bytes.byteLength > APPROVAL_INPUT_PREVIEW_BYTES
  const text = shortened
    ? bytes
        .subarray(0, APPROVAL_INPUT_PREVIEW_BYTES)
        .toString('utf8')
        .replace(/\uFFFD$/u, '')
    : redacted
  return { text, truncated: shortened || redacted !== command }
}
