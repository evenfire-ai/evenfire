import type { SelectionDropdownOption } from '@components/SelectionDropdown/types'

export interface GfsSubjectPickerProps {
  disabled?: boolean
  loading?: boolean
  onChange: (next: string[]) => void
  options: SelectionDropdownOption[]
  value: string[]
}
