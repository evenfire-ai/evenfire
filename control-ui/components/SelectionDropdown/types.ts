import type { ReactNode } from 'react'

export type SelectionDropdownOption = {
  value: string
  label: string
  icon?: ReactNode
  description?: string
  badge?: string
}

export type SelectionDropdownProps = {
  ariaLabel?: string
  className?: string
  id?: string
  options: SelectionDropdownOption[]
  value: string[]
  onChange: (next: string[]) => void
  onSearchQueryChange?: (query: string) => void
  placeholder: string
  disabled?: boolean
  emptyLabel?: ReactNode
  searchPlaceholder?: string
  selectionLabel?: string
  multiple?: boolean
  inline?: boolean
  /** Render the menu at document.body so ancestor overflow cannot clip it. */
  portal?: boolean
  searchable?: boolean
  invalid?: boolean
  menuClassName?: string
  showSelectedChips?: boolean
}
