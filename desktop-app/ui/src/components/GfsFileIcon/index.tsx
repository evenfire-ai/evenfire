import {
  FileImageOutlined,
  FileTextOutlined,
  PaperClipOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons'
import { isGfsDocumentFile } from '@lib/gfsDocumentFile'
import { gfsImagePreviewMimeType } from '@lib/gfsImagePreview'
import { isGfsVideoFile } from '@lib/gfsVideoFile'
import type { GfsFileIconProps } from './types'

export type { GfsFileIconProps } from './types'

export function GfsFileIcon({ name, ...iconProps }: GfsFileIconProps) {
  if (gfsImagePreviewMimeType(name)) return <FileImageOutlined aria-hidden="true" {...iconProps} />
  if (isGfsVideoFile(name)) return <VideoCameraOutlined aria-hidden="true" {...iconProps} />
  if (isGfsDocumentFile(name)) return <FileTextOutlined aria-hidden="true" {...iconProps} />
  return <PaperClipOutlined aria-hidden="true" {...iconProps} />
}
