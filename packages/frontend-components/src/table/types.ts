import type { ReactNode, ThHTMLAttributes } from 'react'

export type SortDirection = 'asc' | 'desc'
export type SortValue = string | number | boolean | Date | null | undefined
export type TableVariant = 'standard' | 'selection' | 'hierarchy' | 'embedded' | 'grouped'
export type CellKind = 'text' | 'numeric' | 'fixed' | 'selection' | 'actions'

export type DataViewHeaderProps = {
  actions?: ReactNode
  className?: string
  description?: ReactNode
  icon?: ReactNode
  tabs?: ReactNode
  title: ReactNode
}

export type TableHeaderCellProps = Omit<ThHTMLAttributes<HTMLTableCellElement>, 'children'> & {
  activeDirection?: SortDirection | null
  defaultDirection?: SortDirection
  kind?: CellKind
  label: ReactNode
  onSort?: () => void
  sortLabel?: ReactNode
}

export type TableStateRowProps = {
  action?: ReactNode
  colSpan: number
  kind?: 'loading' | 'empty' | 'error'
  message?: ReactNode
}

type GroupedTableBodyBaseProps = {
  childBodyClassName?: string
  childHeader?: ReactNode
  childTableClassName?: string
  children: ReactNode
  className?: string
  colSpan: number
  disclosureClassName?: string
  disclosureLabel: (expanded: boolean) => string
  expanded: boolean
  groupId: string
  nestedChildTable?: boolean
  onExpandedChange: (expanded: boolean) => void
}

export type GroupedTableSummaryCell = {
  className?: string
  colSpan?: number
  content: ReactNode
  key: string
}

export type GroupedTableBodyProps = GroupedTableBodyBaseProps &
  (
    | {
        summary: ReactNode
        summaryCells?: never
      }
    | {
        summary?: never
        summaryCells: readonly GroupedTableSummaryCell[]
      }
  )

export type RowAction = {
  key: string
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  disabledReason?: ReactNode
}
