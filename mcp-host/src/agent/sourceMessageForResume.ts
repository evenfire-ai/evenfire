import type { Attachment, ResumeFileAttachment, ResumeSourceMessage } from '../core/types'
import type { IncomingMessage } from '../server'

/**
 * #666 R4-M2 — the metadata a cold restart needs to rebuild the turn's
 * file-reference pins and attachment lines: identity, resolutions and
 * file-attachment metadata. Image attachments are dropped (their content lives
 * in the frozen snapshot) and inline bytes (dataBase64) never persist.
 */
export function sourceMessageForResume(
  message: IncomingMessage | undefined
): ResumeSourceMessage | undefined {
  if (!message) return undefined
  const files = message.attachments?.filter(attachment => attachment.kind === 'file') ?? []
  return {
    ...message,
    attachments: files.length ? files.map(fileWithoutBytes) : undefined,
  }
}

function fileWithoutBytes(attachment: Attachment): ResumeFileAttachment {
  const metadata: Partial<Attachment> = { ...attachment }
  delete metadata.dataBase64
  return metadata as ResumeFileAttachment
}
