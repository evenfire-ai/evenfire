export type DropdownSelectOption = {
  label: string
  value: string
}

export type DropdownSelectProps = {
  ariaLabel?: string
  disabled?: boolean
  id?: string
  onChange: (value: string) => void
  options: DropdownSelectOption[]
  placeholder: string
  value: string
}
