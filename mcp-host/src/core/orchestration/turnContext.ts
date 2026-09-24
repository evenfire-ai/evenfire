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
 * one `attached_file` line per file plus a fixed read instruction (#666);
 * turns with structured file references list one `referenced_file` line per
 * reference, with its availability, plus their own read instruction.
 */
import { quotePromptValue } from '@clerum/gfs-interaction-policy'
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

/**
 * A file referenced by this turn (#666), as admission resolved it under the
 * Host principal. Only metadata reaches the model: an available GFS file is
 * read on demand with `clerum__gfs_read`, pinned to `version`.
 */
export interface TurnContextReferencedFile {
  referenceId: string
  name: string
  class: string
  byteLength: number
  /** Present for GFS references; absent for any other source. */
  gfs?: { drive: string; resourceId: string; version: number }
  sourceKind: string
  availability: string
  /** The availability code; absent when the file is available. */
  code?: string
  /** The version gfsc reported for a stale reference. */
  currentVersion?: number
}

export interface TurnContextInput {
  date: Date
  channel: TurnContextChannel
  cron?: TurnContextCron
  attachedFiles?: TurnContextAttachedFile[]
  referencedFiles?: TurnContextReferencedFile[]
}

export const ATTACHED_FILES_INSTRUCTION =
  "If the user's request refers to an attached file, read it with clerum__attachment_read before answering. Files with reader=none cannot be read in this turn; say so instead of guessing."

export const REFERENCED_FILES_INSTRUCTION =
  "If the user's request refers to a referenced file, read it with clerum__gfs_read using its drive and resourceId. The Host pins each referenced file to its listed version; pass expectedVersion only to read the current_version of a stale reference. A referenced file whose availability is neither available nor stale cannot be read in this turn; tell the user why instead of guessing."

// Client-supplied values are written with quotePromptValue, which keeps each
// one on its own line and inside its own field. Values the Host computed
// (enums, integers) are written unquoted.
function referencedFileLine(file: TurnContextReferencedFile): string {
  let line = `referenced_file: id=${quotePromptValue(file.referenceId)} name=${quotePromptValue(file.name)} source=${file.sourceKind}`
  if (file.gfs) {
    line += ` drive=${quotePromptValue(file.gfs.drive)} resourceId=${quotePromptValue(file.gfs.resourceId)} version=${file.gfs.version}`
  }
  line += ` class=${file.class} bytes=${file.byteLength} availability=${file.availability}`
  if (file.code) line += ` code=${file.code}`
  if (file.currentVersion !== undefined) line += ` current_version=${file.currentVersion}`
  return line
}

function attachedFileLine(file: TurnContextAttachedFile): string {
  const line = `attached_file: id=${quotePromptValue(file.attachmentId)} name=${quotePromptValue(file.name)} class=${file.class} bytes=${file.byteLength} reader=${file.reader}`
  if (!file.mismatch) return line
  const declared =
    file.declaredMediaType === null ? '' : ` declared=${quotePromptValue(file.declaredMediaType)}`
  return `${line} mismatch=true${declared} detected=${file.detectedMediaType}`
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
  if (input.referencedFiles && input.referencedFiles.length > 0) {
    lines.push(...input.referencedFiles.map(referencedFileLine))
    lines.push(REFERENCED_FILES_INSTRUCTION)
  }
  return `<turn-context>\n${lines.join('\n')}\n</turn-context>\n\n`
}
