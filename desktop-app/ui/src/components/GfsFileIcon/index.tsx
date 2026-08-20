import { GfsFileThumbnail } from '@components/GfsFileThumbnail'
import {
  IconAttachFile,
  IconDocumentText,
  IconImage,
  IconVideo,
} from '@components/SidebarNav/icons'
import { isGfsDocumentFile } from '@lib/gfsDocumentFile'
import { gfsImagePreviewMimeType } from '@lib/gfsImagePreview'
import { isGfsVideoFile } from '@lib/gfsVideoFile'
import type { GfsFileIconProps } from './types'

export type { GfsFileIconProps } from './types'

export function GfsFileIcon({ name, bytes, rid, ...iconProps }: GfsFileIconProps) {
  if (gfsImagePreviewMimeType(name)) {
    // Render the inline image thumbnail whenever we have a rid; the
    // component itself decides whether to fetch bytes or short-circuit
    // to the static icon when the file is over the thumbnail budget.
    if (rid !== undefined) {
      return (
        <GfsFileThumbnail byteLength={bytes ?? Number.MAX_SAFE_INTEGER} fileName={name} rid={rid} />
      )
    }
    return <IconImage {...iconProps} />
  }
  if (isGfsVideoFile(name)) return <IconVideo {...iconProps} />
  if (isGfsDocumentFile(name)) return <IconDocumentText {...iconProps} />
  return <IconAttachFile {...iconProps} />
}
