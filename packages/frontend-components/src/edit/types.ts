import type { ReactNode, RefObject } from 'react'

export type DialogSize = 'default' | 'fit' | 'large'
export type DialogTone = 'info' | 'warning' | 'error' | 'success'
export type DialogDismissReason = 'escape' | 'backdrop' | 'close-button' | 'cancel'

export interface DialogShellProps {
  open: boolean
  onDismiss: (reason: DialogDismissReason) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  status?: ReactNode
  error?: ReactNode
  size?: DialogSize
  role?: 'dialog' | 'alertdialog'
  closeButtonLabel?: string
  dismissOnEscape?: boolean
  dismissOnBackdrop?: boolean
  preventDismissWhileBusy?: boolean
  busy?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
}

export interface ConfirmationSecondaryAction {
  label: string
  onSelect: () => void
  disabled?: boolean
}

export interface ConfirmationDialogProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  tone?: DialogTone
  icon?: ReactNode
  cancelLabel?: string
  confirmLabel?: string
  secondaryAction?: ConfirmationSecondaryAction
  confirmDisabled?: boolean
  pending?: boolean
  error?: ReactNode
  size?: DialogSize
}

export interface SingleValueEditorProps<T> {
  value: T
  onChange: (value: T) => void
  disabled: boolean
}

export interface SingleValueEditDialogProps<T> {
  open: boolean
  initialValue: T
  onDismiss: (reason: DialogDismissReason) => void
  onSave: (value: T) => void
  renderEditor: (props: SingleValueEditorProps<T>) => ReactNode
  title: ReactNode
  description?: ReactNode
  isValid?: boolean
  isEqual?: (left: T, right: T) => boolean
  pending?: boolean
  error?: ReactNode
  discardLabel?: string
  saveLabel?: string
  closeButtonLabel?: string
  size?: DialogSize
  className?: string
}

export interface SimpleEditDialogProps {
  open: boolean
  onCancel: () => void
  onSave: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  isValid?: boolean
  isDirty?: boolean
  pending?: boolean
  error?: ReactNode
  cancelLabel?: string
  saveLabel?: string
  closeButtonLabel?: string
  size?: DialogSize
}

export type SecretEditState =
  | { status: 'untouched' }
  | { status: 'replaced'; value: string }
  | { status: 'cleared' }
  | { status: 'restored' }

export interface SecretEditFieldProps {
  id: string
  label: string
  existingValue: boolean
  state: SecretEditState
  onStateChange: (state: SecretEditState) => void
  disabled?: boolean
  placeholder?: string
  helpText?: ReactNode
  clearLabel?: string
  restoreLabel?: string
}

export interface MultiSelectItem {
  id: string
  label: ReactNode
  description?: ReactNode
  searchText?: string
  disabled?: boolean
}

export interface MultiSelectActionDialogProps {
  open: boolean
  onDismiss: (reason: DialogDismissReason) => void
  title: ReactNode
  description?: ReactNode
  items: readonly MultiSelectItem[]
  selectedIds: readonly string[]
  onSelectedIdsChange: (selectedIds: string[]) => void
  onAction: (selectedIds: string[]) => void
  actionLabel: string
  cancelLabel?: string
  searchLabel?: string
  searchPlaceholder?: string
  emptyMessage?: ReactNode
  noMatchesMessage?: ReactNode
  loading?: boolean
  pending?: boolean
  error?: ReactNode
  size?: DialogSize
}
