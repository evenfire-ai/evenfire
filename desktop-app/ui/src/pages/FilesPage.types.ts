import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import type { Tone } from '@/uiTypes'

export type GfsDriveResource = GfsBrowserChild & {
  sources?: string[]
  permissions?: string[]
  coversDescendants?: boolean
}

export type GfsPreviewResource = Pick<GfsDriveResource, 'bytes' | 'gfsUri' | 'name'> &
  ({ kind: 'image'; mimeType: string } | { kind: 'markdown' })

export interface FilesPageProps {
  /** App-level toast dispatcher for success feedback (desktop-app/ui rule). */
  pushToast?: (message: string, tone: Tone) => void
}
