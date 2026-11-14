import type { ReactNode } from 'react'

/**
 * De-modalized video preview body (spec 18 §3.B.2): the `<video>` + its fetch
 * and size-guard, without modal chrome. Shared by the surviving modal and
 * `FilePreviewPage`. Video has no copy affordance.
 */
export type GfsVideoPreviewBodyProps = {
  byteLength: number
  fileName: string
  gfsUri: string
  mimeType: string
  onDownloadError?: (error: unknown) => void
  /** True only when this fetch is the user opening the file. */
  recordOpen: boolean
  titleId?: string
  titleActions?: ReactNode
  headerActions?: ReactNode
  headingLevel?: 2 | 3
}
