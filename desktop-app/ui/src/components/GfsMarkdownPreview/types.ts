import type { ReactNode } from 'react'

/**
 * De-modalized markdown/text preview body (spec 18 §3.B.2): the rendered
 * `<article>` + its fetch, copy, and size-guard, without modal chrome. Shared by
 * the surviving modal and `FilePreviewPage`.
 */
export type GfsMarkdownPreviewBodyProps = {
  byteLength: number
  fileName: string
  gfsUri: string
  onDownloadError?: (error: unknown) => void
  titleId?: string
  headerActions?: ReactNode
  headingLevel?: 2 | 3
}
