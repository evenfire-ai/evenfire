export type DropdownSelectOption = {
  label: string
  value: string
}

export type DropdownSelectProps = {
  ariaLabel?: string
  className?: string
  disabled?: boolean
  id?: string
  onChange: (value: string) => void
  options: DropdownSelectOption[]
  placeholder: string
  /** Render the menu at document.body so ancestor overflow cannot clip it. */
  portal?: boolean
  value: string
}
