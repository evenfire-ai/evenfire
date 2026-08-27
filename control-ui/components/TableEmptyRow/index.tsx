'use client'

import { Button } from '@components/ui'
import type { TableEmptyRowProps } from './types'

/**
 * The empty state for a route table. It is a row, not a replacement for the
 * table, so the column headers stay mounted: unmounting them strands the user
 * with a line of text and no structure to orient against.
 */
export function TableEmptyRow({ action, colSpan, message }: TableEmptyRowProps) {
  return (
    <tr>
      <td className="cu-empty" colSpan={colSpan}>
        {message}
        {action ? (
          <Button className="cu-empty__action" onClick={action.onSelect} size="sm" variant="ghost">
            {action.label}
          </Button>
        ) : null}
      </td>
    </tr>
  )
}
