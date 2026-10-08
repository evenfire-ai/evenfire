import { createHash } from 'node:crypto'
import type { Attachment } from '../core/types'
import type { ModelStepCheckpointAttachmentInput } from '../db/worker/modelStepCheckpointOps'

/**
 * #1043 — raw bytes of a turn's inline uploaded files, as a resumable
 * model-step checkpoint stores them. Images are excluded: their content is
 * already in the checkpoint entries. The digest is recomputed from the bytes;
 * when admission recorded one, the two must agree.
 */
export function inlineFileAttachmentBytes(
  attachments: readonly Attachment[] | undefined
): ModelStepCheckpointAttachmentInput[] {
  const result: ModelStepCheckpointAttachmentInput[] = []
  for (const attachment of attachments ?? []) {
    if (attachment.kind !== 'file' || attachment.dataBase64.length === 0) continue
    const bytes = Buffer.from(attachment.dataBase64, 'base64')
    const digestHex = createHash('sha256').update(bytes).digest('hex')
    if (attachment.digest && attachment.digest.hex !== digestHex) {
      throw new Error(`Inline attachment ${attachment.id} does not match its admitted digest`)
    }
    result.push({ attachmentId: attachment.id, digestHex, bytes })
  }
  return result
}
