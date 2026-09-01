import type { SortDirection, TableHeaderCellProps } from '@clerum/frontend-components'

export type TableHeaderColumn = {
  align?: 'left' | 'right' | 'center'
  ariaLabel?: string
  key: string
  label?: TableHeaderCellProps['label']
  minWidth?: string
  title?: string
  width?: string
  activeDirection?: SortDirection | null
  defaultDirection?: SortDirection
  onSort?: () => void
  sortLabel?: TableHeaderCellProps['sortLabel']
}
