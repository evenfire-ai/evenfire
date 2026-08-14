import { IconAttachFile, IconDocumentText, IconImage } from '@components/SidebarNav/icons'
import { isGfsDocumentFile } from '@lib/gfsDocumentFile'
import { gfsImagePreviewMimeType } from '@lib/gfsImagePreview'
import type { GfsFileIconProps } from './types'

export type { GfsFileIconProps } from './types'

export function GfsFileIcon({ name, ...iconProps }: GfsFileIconProps) {
  if (gfsImagePreviewMimeType(name)) return <IconImage {...iconProps} />
  if (isGfsDocumentFile(name)) return <IconDocumentText {...iconProps} />
  return <IconAttachFile {...iconProps} />
}
