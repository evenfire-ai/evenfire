import type { ApprovalInputPreview } from './types'

// Shell commands have no declared input byte cap. Bound only this UI projection;
// approval parameters, their identity and the resumed command remain untouched.
export const APPROVAL_INPUT_PREVIEW_BYTES = 64 * 1024

/** The tool whose approval names every file it deletes. */
export const KEPT_FILES_DELETE_APPROVAL_TOOL = 'clerum__kept_files_delete'

/** Longest file name shown on a delete approval; a longer one ends in an ellipsis. */
const DELETE_NAME_LIMIT = 80

/**
 * The lines a delete approval shows, in Desktop and in channels: a fixed first
 * line, one `kind: name` line per file (each name redacted, then cut to 80
 * characters with a visible ellipsis), the total, and a note when a name was
 * cut. Undefined when the call carries no file list.
 */
export function keptFilesDeleteApprovalLines(
  parameters: Record<string, unknown>,
  redact: (text: string) => string
): { lines: string[]; shortened: boolean; redacted: boolean } | undefined {
  const files = parameters.files
  if (!Array.isArray(files)) return undefined
  let shortened = false
  let redacted = false
  const lines = ['Delete these files permanently:']
  for (const file of files) {
    const entry = (typeof file === 'object' && file !== null ? file : {}) as Record<string, unknown>
    const kind = typeof entry.kind === 'string' ? entry.kind : 'file'
    const raw = typeof entry.name === 'string' ? entry.name : ''
    const safe = redact(raw)
    if (safe !== raw) redacted = true
    const characters = [...safe]
    let name = safe
    if (characters.length > DELETE_NAME_LIMIT) {
      name = `${characters.slice(0, DELETE_NAME_LIMIT - 1).join('')}…`
      shortened = true
    }
    lines.push(`${redact(kind)}: ${name}`)
  }
  lines.push(`Total files: ${files.length}`)
  if (shortened) lines.push('Names ending in … are shortened')
  return { lines, shortened, redacted }
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
    return { text, truncated: cut || projected.shortened || projected.redacted }
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
