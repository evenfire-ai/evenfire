import type { ReactNode } from 'react'

export type ConfirmDialogProps = {
  body: ReactNode
  cancelLabel?: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
  title: string
  tone?: 'danger' | 'primary'
}
