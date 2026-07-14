import type { TableHTMLAttributes } from 'react'

export type DataTableProps = TableHTMLAttributes<HTMLTableElement> & {
  compact?: boolean
  fullBleed?: boolean
  frameless?: boolean
  scrollClassName?: string
}

export type DataTableFilterOption<TValue extends string = string> = {
  label: string
  value: TValue
}

export type DataTableFilterProps<TValue extends string = string> = {
  active?: boolean
  ariaLabel: string
  className?: string
  label: string
  onChange: (value: TValue) => void
  options: ReadonlyArray<DataTableFilterOption<TValue>>
  value: TValue
  variant?: 'select' | 'icon'
}
