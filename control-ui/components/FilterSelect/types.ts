import type { ReactNode } from 'react'

export type FilterSelectOption = {
  value: string
  label: string
  icon?: ReactNode
}

export type FilterSelectProps = {
  ariaLabel: string
  className?: string
  disabled?: boolean
  id?: string
  onChange: (value: string) => void
  options: FilterSelectOption[]
  value: string
}
