export interface FilePreviewPageProps {
  /** The previewed file's gfsUri — the byte source and the tab's identity. */
  gfsUri: string
  /** The file name (the tab title), used for the preview heading and alt text. */
  fileName: string
  fileKind: 'image' | 'markdown' | 'video'
  mimeType?: string
  /** File size in bytes, for the per-kind size-guard (not the bytes). */
  byteLength: number
}
