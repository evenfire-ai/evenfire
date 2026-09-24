import type { ReactNode } from 'react'

export type GfsImagePreviewProps = {
  byteLength: number
  fileName: string
  gfsUri: string
  mimeType: string
  onClose: () => void
  onDownloadError?: (error: unknown) => void
}

/**
 * The de-modalized image preview (spec 18 §3.B.2): the `<img>` + its fetch,
 * copy, and size-guard, WITHOUT the portal/backdrop/close/Escape chrome. Both
 * the surviving modal and `FilePreviewPage` mount it. `headerActions` is a slot
 * for chrome-owned controls (the modal's close button); `headingLevel` lets a
 * page use `h2` while the modal keeps `h3`.
 */
export type GfsImagePreviewBodyProps = {
  byteLength: number
  fileName: string
  gfsUri: string
  mimeType: string
  onDownloadError?: (error: unknown) => void
  titleId?: string
  headerActions?: ReactNode
  headingLevel?: 2 | 3
}
