/**
 * T2.2 — `<turn-context>` block.
 *
 * Volatile per-turn data (date, channel, sender, cron) moves out of the
 * system prompt (which we want byte-stable across turns for prompt caching)
 * and into a fenced block prepended to the user message. Format from
 * `.specs/mcp-hermes/aclaraciones/system-prompt-tiers.md` §76-84:
 *
 *     <turn-context>
 *     date: 2026-05-19T14:30:00Z
 *     channel: telegram
 *     sender: jane@example.com
 *     </turn-context>
 *
 *     <original user message>
 *
 * For cron-originated turns we append two extra lines (`cron_job` /
 * `scheduled_for`) — see P1-004. Turns with `kind:'file'` attachments list
 * one `attached_file` line per file plus a fixed read instruction (#666).
 */
import type { Attachment } from '../types'

export interface TurnContextChannel {
  type: string
  sender?: string | null
}

export interface TurnContextCron {
  jobId: string
  scheduledFor: string
}

/**
 * A file attached to this turn (#666). Only metadata reaches the model: the
 * content is read on demand with `clerum__attachment_read`.
 */
export interface TurnContextAttachedFile {
  attachmentId: string
  name: string
  class: string
  byteLength: number
  reader: 'text' | 'none'
  mismatch: boolean
  declaredMediaType: string | null
  detectedMediaType: string
}

export interface TurnContextInput {
  date: Date
  channel: TurnContextChannel
  cron?: TurnContextCron
  attachedFiles?: TurnContextAttachedFile[]
}

export const ATTACHED_FILES_INSTRUCTION =
  "If the user's request refers to an attached file, read it with clerum__attachment_read before answering. Files with reader=none cannot be read in this turn; say so instead of guessing."

function attachedFileLine(file: TurnContextAttachedFile): string {
  // The name is user-chosen: JSON quoting keeps a `"` inside it from ending the field.
  const line = `attached_file: id=${file.attachmentId} name=${JSON.stringify(file.name)} class=${file.class} bytes=${file.byteLength} reader=${file.reader}`
  if (!file.mismatch) return line
  return `${line} mismatch=true declared=${file.declaredMediaType ?? 'none'} detected=${file.detectedMediaType}`
}

/**
 * The `attached_file` entries for a source message: every `kind:'file'`
 * attachment admitted with a `FileReferenceV1`. Images are not listed; they
 * reach the model as content parts.
 */
export function attachedFilesForTurnContext(
  attachments: readonly Attachment[] | undefined
): TurnContextAttachedFile[] {
  const files: TurnContextAttachedFile[] = []
  for (const attachment of attachments ?? []) {
    const reference = attachment.kind === 'file' ? attachment.fileReference : undefined
    if (!reference) continue
    files.push({
      attachmentId: attachment.id,
      name: reference.name,
      class: reference.class,
      byteLength: reference.byteLength,
      reader: reference.reader,
      mismatch: reference.mismatch,
      declaredMediaType: reference.declaredMediaType,
      detectedMediaType: reference.detectedMediaType,
    })
  }
  return files
}

export function buildTurnContextBlock(input: TurnContextInput): string {
  const lines: string[] = [`date: ${input.date.toISOString()}`, `channel: ${input.channel.type}`]
  if (input.channel.sender) {
    lines.push(`sender: ${input.channel.sender}`)
  }
  if (input.cron) {
    lines.push(`cron_job: ${input.cron.jobId}`)
    lines.push(`scheduled_for: ${input.cron.scheduledFor}`)
  }
  if (input.attachedFiles && input.attachedFiles.length > 0) {
    lines.push(...input.attachedFiles.map(attachedFileLine))
    lines.push(ATTACHED_FILES_INSTRUCTION)
  }
  return `<turn-context>\n${lines.join('\n')}\n</turn-context>\n\n`
}
