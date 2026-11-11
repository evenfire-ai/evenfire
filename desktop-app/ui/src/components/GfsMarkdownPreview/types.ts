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
  expectedSessionGeneration?: number
  onDownloadError?: (error: unknown) => void
  onCopyContentReady?: (copy: (() => Promise<boolean>) | null) => void
  onSourceLoaded?: (source: string, version: number) => boolean | void
  editor?: ReactNode
  titleId?: string
  titleActions?: ReactNode
  headerActions?: ReactNode
  headingLevel?: 2 | 3
}
