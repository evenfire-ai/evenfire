import type { ReactNode } from 'react'

export type TableSortDirection = 'asc' | 'desc'

export type TableHeaderColumn = {
  align?: 'left' | 'right' | 'center'
  ariaLabel?: string
  key: string
  label?: ReactNode
  minWidth?: string
  // Opt-in: renders the label as a sort button and exposes `aria-sort`. Only
  // takes effect when the row also receives `onSortToggle`.
  sortable?: boolean
  // Plain-text name used in the sort button's aria-label when `label` is not a
  // string (e.g. an icon + text node).
  sortLabel?: string
  title?: string
  width?: string
}

export type TableHeaderRowProps = {
  columns: TableHeaderColumn[]
  // Key of the currently sorted column, or null for "unsorted" (server order).
  sortKey?: string | null
  sortDir?: TableSortDirection
  onSortToggle?: (key: string) => void
}
