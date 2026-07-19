export interface GfsPermissionDropdownProps {
  disabled?: boolean
  onChange: (next: string[]) => void
  permissions: string[]
  value: string[]
}
