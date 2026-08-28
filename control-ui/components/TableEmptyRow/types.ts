import type { ReactNode } from 'react'

export type TableEmptyRowProps = {
  /** Number of columns to span. Must match the table's header row. */
  colSpan: number
  message: ReactNode
  /** Offer this when the empty state is the result of a filter the user can undo. */
  action?: {
    label: string
    onSelect: () => void
  }
}
