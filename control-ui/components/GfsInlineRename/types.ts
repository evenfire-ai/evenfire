export interface GfsInlineRenameProps {
  busy?: boolean
  className?: string
  onCancel: () => void
  onChange: (value: string) => void
  onSubmit: () => void
  value: string
}
