export type ConfirmDialogTone = 'default' | 'danger'

export interface ConfirmDialogOptions {
  title?: string
  message: string
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
