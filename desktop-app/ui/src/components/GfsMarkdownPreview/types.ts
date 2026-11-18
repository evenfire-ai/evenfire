import type { ReactNode } from 'react'

/**
 * De-modalized markdown/text preview body (spec 18 §3.B.2): the rendered
 * `<article>` + its fetch, copy, and size-guard, without modal chrome. Shared by
 * the surviving modal and `FilePreviewPage`.
 */
export type GfsMarkdownPreviewBodyProps = {
  byteLength: number
  /**
   * Bumped when the server publishes a newer version of the same file. The body
   * re-downloads in place, keeping the current content until the new one lands.
   */
  contentVersion?: number
  fileName: string
  gfsUri: string
  onDownloadError?: (error: unknown) => void
  onCopyContentReady?: (copy: (() => Promise<boolean>) | null) => void
  titleId?: string
  titleActions?: ReactNode
  permissionProgress?: ReactNode
  headerActions?: ReactNode
  headingLevel?: 2 | 3
}
