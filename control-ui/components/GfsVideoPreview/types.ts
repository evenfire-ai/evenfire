export interface GfsVideoPreviewProps {
  byteLength: number
  fileName: string
  mimeType: string
  unavailable?: boolean
  onClose: () => void
  rid: string
}
