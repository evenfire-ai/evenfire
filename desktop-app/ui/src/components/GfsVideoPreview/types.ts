import type { ReactNode } from 'react'

/**
 * De-modalized video preview body (spec 18 §3.B.2): the `<video>` + its fetch
 * and size-guard, without modal chrome. Shared by the surviving modal and
 * `FilePreviewPage`. Video has no copy affordance.
 */
export type GfsVideoPreviewBodyProps = {
  byteLength: number
  /**
   * Bumped when the server publishes a newer version of the same file. The body
   * re-downloads in place, keeping the current content until the new one lands.
   */
  contentVersion?: number
  fileName: string
  gfsUri: string
  mimeType: string
  onDownloadError?: (error: unknown) => void
  titleId?: string
  titleActions?: ReactNode
  headerActions?: ReactNode
  headingLevel?: 2 | 3
}
