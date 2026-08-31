import type { ReactNode } from 'react'
import type { SortDirection } from '@clerum/frontend-table-system'

export type TableHeaderColumn = {
  align?: 'left' | 'right' | 'center'
  ariaLabel?: string
  key: string
  label?: ReactNode
  minWidth?: string
  title?: string
  width?: string
  activeDirection?: SortDirection | null
  defaultDirection?: SortDirection
  onSort?: () => void
  sortLabel?: ReactNode
}
