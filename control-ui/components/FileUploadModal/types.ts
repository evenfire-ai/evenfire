export interface FileUploadModalProps {
  busy?: boolean
  destination?: string
  file: File | null
  fileSummary?: string
  guidance?: string
  progress?: {
    uploadedBytes: number
    totalBytes: number
    state:
      | 'initiated'
      | 'uploading'
      | 'paused'
      | 'finalizing'
      | 'canceling'
      | 'completed'
      | 'aborted'
      | 'failed'
  }
  onClose: () => void
  onCancelUpload?: () => void
  onFileChange: (file: File | null) => void
  onUpload: () => void
  onPauseUpload?: () => void
  onResumeUpload?: () => void
  title?: string
}
