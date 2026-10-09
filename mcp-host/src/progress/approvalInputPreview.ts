import type { ApprovalInputPreview } from './types'

// Shell commands have no declared input byte cap. Bound only this UI projection;
// approval parameters, their identity and the resumed command remain untouched.
export const APPROVAL_INPUT_PREVIEW_BYTES = 64 * 1024

export function projectApprovalInputPreview(
  toolName: string,
  parameters: Record<string, unknown>,
  redact: (text: string) => string
): ApprovalInputPreview | undefined {
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
