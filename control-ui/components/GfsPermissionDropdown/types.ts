export interface GfsPermissionDropdownProps {
  disabled?: boolean
  onChange: (next: string[]) => void
  permissions: readonly string[]
  value: string[]
}
