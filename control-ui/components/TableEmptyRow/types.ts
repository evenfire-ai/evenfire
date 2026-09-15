import type { TableStateRowProps } from '@clerum/frontend-components'

export type TableEmptyRowProps = {
  /** Number of columns to span. Must match the table's header row. */
  colSpan: number
  message?: TableStateRowProps['message']
  /** Offer this when the empty state is the result of a filter the user can undo. */
  action?: {
    label: string
    onSelect: () => void
  }
}
