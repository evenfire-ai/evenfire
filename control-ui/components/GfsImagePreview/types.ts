export interface GfsImagePreviewProps {
  byteLength: number
  fileName: string
  mimeType: string
  unavailable?: boolean
  onClose: () => void
  rid: string
}
