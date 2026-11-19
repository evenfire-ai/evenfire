import type { ReactNode } from 'react'

export type SelectionDropdownOption = {
  value: string
  label: string
  /** Plain-text description; always the search source, and rendered when no node is given. */
  description?: string
  /** Optional rich rendering shown in place of the plain-text description. */
  descriptionNode?: ReactNode
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
