export interface FileUploadModalProps {
  busy?: boolean
  destination?: string
  file: File | null
  fileSummary?: string
  guidance?: string
  onClose: () => void
  onFileChange: (file: File | null) => void
  onUpload: () => void
  title?: string
}
