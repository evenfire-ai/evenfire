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

export function GfsFileIcon({ name, ...iconProps }: GfsFileIconProps) {
  if (gfsImagePreviewMimeType(name)) return <IconImage aria-hidden="true" {...iconProps} />
  if (isGfsVideoFile(name)) return <IconVideo aria-hidden="true" {...iconProps} />
  if (isGfsDocumentFile(name)) return <IconDocumentText aria-hidden="true" {...iconProps} />
  return <IconAttachFile aria-hidden="true" {...iconProps} />
}
