import type { HostMessageAttachment } from '../../../src/types'
import type { ComposerImageAttachment, ReadyComposerFileAttachment } from '../uiTypes'

/**
 * The `attachments` array of a Host message request, built from the composer's
 * images and ready files (#678). Images come first, then files, each in the
 * order the composer holds them.
 */
export function mapComposerAttachmentsToHostRequest(
  attachments: ComposerImageAttachment[],
  files: ReadyComposerFileAttachment[]
): HostMessageAttachment[] {
  return [
    ...attachments.map(
      (att): HostMessageAttachment => ({
        id: att.id,
        kind: 'image',
        mimeType: att.mimeType,
        encoding: 'base64',
        dataBase64: att.dataBase64,
        filename: att.name,
      })
    ),
    ...files.map(
      (file): HostMessageAttachment => ({
        id: file.id,
        kind: 'file',
        filename: file.filename,
        mimeType: file.declaredMediaType,
        detectedMediaType: file.classification.detectedMediaType,
        encoding: 'base64',
        dataBase64: file.dataBase64,
        sizeBytes: file.sizeBytes,
        digest: { algorithm: 'sha256', hex: file.digestHex },
      })
    ),
  ]
}

/**
 * The message text a send posts before the references section is appended:
 * the trimmed draft, or a fixed prompt naming what is attached when the draft
 * is empty.
 */
export function composerRequestBaseContent(
  trimmedContent: string,
  imageCount: number,
  fileCount: number
): string {
  return (
    trimmedContent ||
    (imageCount && fileCount
      ? 'Please analyze the attached image(s) and file(s).'
      : fileCount
        ? 'Please analyze the attached file(s).'
        : imageCount
          ? 'Please analyze the attached image(s).'
          : 'Please use the attached context.')
  )
}
