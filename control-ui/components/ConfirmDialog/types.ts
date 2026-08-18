import type { ReactNode } from 'react'

export type ConfirmDialogTone = 'default' | 'danger'

export interface ConfirmDialogOptions {
  title?: string
  message: string
  /**
   * Optional rich content rendered below the message inside the dialog — used to
   * show structured detail (e.g. the list of Host/grant references a forced
   * action would strand) the operator must see before confirming.
   */
  details?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmDialogTone
}

export interface ConfirmDialogRequest {
  id: number
  options: ConfirmDialogOptions
  resolve: (confirmed: boolean) => void
}

export interface ConfirmDialogProps {
  request: ConfirmDialogRequest | null
  onResolve: (confirmed: boolean) => void
}
