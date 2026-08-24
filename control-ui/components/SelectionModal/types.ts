export type SelectionModalOption = {
  value: string
  label: string
  description?: string
  badge?: string
}

export type SelectionModalProps = {
  busy: boolean
  emptyLabel: string
  id: string
  label: string
  onChange: (next: string[]) => void
  onClose: () => void
  onConfirm: () => Promise<void>
  options: SelectionModalOption[]
  placeholder: string
  searchPlaceholder: string
  selectionLabel: string
  submitLabel: string
  title: string
  titleId: string
  value: string[]
}
