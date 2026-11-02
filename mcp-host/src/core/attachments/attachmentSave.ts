import { resourceNameProblem } from '@clerum/gfs-interaction-policy'
import type { GfsToolScope } from '../../internalTools/gfsClient'
import type { Attachment } from '../types'

/**
 * Whether clerum__gfs_save_attachment exists for this turn. Only the tool
 * registry calls this; the turn-context instruction follows the registry, so
 * the tool and its instruction always appear together. Bytes live only on the
 * turn's own message; a message rebuilt after a cold restart has none, and
 * then nothing is offered.
 */
export function attachmentSaveAvailable(
  scopes: ReadonlySet<GfsToolScope> | null,
  attachments: readonly Attachment[] | undefined
): boolean {
  if (!scopes?.has('gfs.write')) return false
  return (attachments ?? []).some(attachment => typeof attachment.dataBase64 === 'string')
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

/**
 * The GFS name an attachment is saved under. The turn context shows this name
 * and the save tool writes it, so the model sees exactly what will be created.
 *
 * A file attachment keeps the name admission validated. An image name comes
 * from the client unchecked and is often absent (pasted screenshots, channel
 * photos), so images go through {@link imageSaveName}. Returns `null` only for
 * a file attachment whose name is unusable, which admission does not let
 * through.
 */
export function attachmentSaveName(attachment: Attachment): string | null {
  if (attachment.kind === 'image') return imageSaveName(attachment)
  return usableName(attachment.filename)
}

/**
 * An image's client-supplied name when it is a usable GFS resource name;
 * otherwise (missing, blank, `..`, containing `/` or control characters)
 * `image-<id>.<ext>`.
 */
export function imageSaveName(image: Attachment): string {
  const supplied = usableName(image.filename)
  if (supplied !== null) return supplied
  const extension = IMAGE_EXTENSIONS[image.mimeType] ?? 'img'
  const id = image.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  return id ? `image-${id}.${extension}` : `image.${extension}`
}

function usableName(raw: string | undefined): string | null {
  const name = raw?.normalize('NFC')
  if (name === undefined || name.trim() === '' || resourceNameProblem(name) !== null) return null
  return name
}
