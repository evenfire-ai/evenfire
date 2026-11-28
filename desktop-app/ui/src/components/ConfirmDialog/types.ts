import type { ReactNode } from 'react'

export type ConfirmDialogProps = {
  /** Initiating control and surviving conversation region for focus restoration. */
  returnFocusTo?: HTMLElement | null
  fallbackFocusWithin?: HTMLElement | null
  body: ReactNode
  cancelLabel?: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void | Promise<unknown>
  title: string
  tone?: 'danger' | 'primary'
}
