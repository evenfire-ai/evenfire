export type GfsImagePreviewProps = {
  byteLength: number
  fileName: string
  gfsUri: string
  mimeType: string
  onClose: () => void
  onDownloadError?: (error: unknown) => void
}
