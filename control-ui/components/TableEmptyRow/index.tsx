'use client'

import { TableStateRow } from '@clerum/frontend-table-system'
import { Button } from '@components/ui'
import type { TableEmptyRowProps } from './types'

/**
 * The empty state for a route table. It is a row, not a replacement for the
 * table, so the column headers stay mounted: unmounting them strands the user
 * with a line of text and no structure to orient against.
 */
export function TableEmptyRow({ action, colSpan, message }: TableEmptyRowProps) {
  return (
    <TableStateRow
      action={
        action ? (
          <Button className="cu-empty__action" onClick={action.onSelect} size="sm" variant="ghost">
            {action.label}
          </Button>
        ) : undefined
      }
      colSpan={colSpan}
      message={message}
    />
  )
}
