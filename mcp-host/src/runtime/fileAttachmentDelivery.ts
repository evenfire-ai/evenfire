import type { Attachment } from '../core/types'
import type { ResultStore } from '../resultStore'

type AttachmentEntry = {
  attachments?: Attachment[]
}

type WritableResultStore<T> = Pick<ResultStore<T>, 'set'>

function stripFileAttachments(attachments: Attachment[] | undefined): Attachment[] | undefined {
  if (!attachments?.some(attachment => attachment.kind === 'file')) return attachments

  const nonFileAttachments = attachments.filter(attachment => attachment.kind !== 'file')
  return nonFileAttachments.length > 0 ? nonFileAttachments : undefined
}

export function entryHasFileAttachment(entry: AttachmentEntry): boolean {
  return entry.attachments?.some(attachment => attachment.kind === 'file') ?? false
}

export function markFileAttachmentsDelivered<T extends AttachmentEntry>(
  store: WritableResultStore<T>,
  id: string,
  entry: T
): void {
  if (!entryHasFileAttachment(entry)) return

  store.set(id, {
    ...entry,
    attachments: stripFileAttachments(entry.attachments),
  })
}
