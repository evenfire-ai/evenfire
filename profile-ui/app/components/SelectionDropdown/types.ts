import type { ReactNode } from 'react'

export type SelectionDropdownOption = {
  value: string
  label: string
  description?: string
  badge?: string
}

export type SelectionDropdownProps = {
  id?: string
  options: SelectionDropdownOption[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder: string
  disabled?: boolean
  emptyLabel?: ReactNode
  searchPlaceholder?: string
  selectionLabel?: string
  multiple?: boolean
  inline?: boolean
  showSelectedChips?: boolean
}
