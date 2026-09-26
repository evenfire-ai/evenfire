import type { ReactNode } from 'react'

/**
 * Where the preview bytes come from (exactly one):
 * - `gfsUri` — fetched from GFS by URI (Files/preview surfaces).
 * - `dataBase64` — supplied inline as base64 (chat image attachments already
 *   carry their bytes; no GFS round-trip exists for them).
 *
 * Modeled as two optional props (not a discriminated union) so a caller can
 * destructure and forward them losslessly; `GfsImagePreviewBody` guards the
 * exactly-one contract at runtime.
 */
export type GfsImagePreviewSource = {
  gfsUri?: string
  dataBase64?: string
}

export type GfsImagePreviewProps = {
  byteLength: number
  fileName: string
  mimeType: string
  onClose: () => void
  onDownloadError?: (error: unknown) => void
} & GfsImagePreviewSource

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
  mimeType: string
  onDownloadError?: (error: unknown) => void
  titleId?: string
  headerActions?: ReactNode
  headingLevel?: 2 | 3
} & GfsImagePreviewSource
