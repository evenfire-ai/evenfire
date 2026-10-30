import type { GfsToolScope } from '../../internalTools/gfsClient'
import type { Attachment } from '../types'

/**
 * Whether clerum__gfs_save_attachment exists for this turn. The tool registry
 * and the turn-context block both call this, so the tool and its instruction
 * always appear together. Bytes live only on the turn's own message; a message
 * rebuilt after a cold restart has none, and then nothing is offered.
 */
export function attachmentSaveAvailable(
  scopes: ReadonlySet<GfsToolScope> | null,
  attachments: readonly Attachment[] | undefined
): boolean {
  if (!scopes?.has('gfs.write')) return false
  return (attachments ?? []).some(attachment => typeof attachment.dataBase64 === 'string')
}

/** Decoded byte length of canonical base64 (admission guarantees the shape). */
export function decodedBase64Length(encoded: string): number {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  return (encoded.length / 4) * 3 - padding
}
