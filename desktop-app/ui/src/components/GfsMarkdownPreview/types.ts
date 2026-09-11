export type GfsMarkdownPreviewProps = {
  byteLength: number
  fileName: string
  gfsUri: string
  onClose: () => void
  onDownloadError?: (error: unknown) => void
}
