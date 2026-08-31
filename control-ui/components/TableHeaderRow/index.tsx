'use client'

import { TableHeaderCell } from '@clerum/frontend-table-system'
import type { TableHeaderColumn } from './types'

export function TableHeaderRow({ columns }: { columns: TableHeaderColumn[] }) {
  return (
    <tr>
      {columns.map(column => (
        <TableHeaderCell
          key={column.key}
          aria-label={column.ariaLabel}
          title={column.title}
          label={column.label}
          style={{
            ...(column.width ? { width: column.width } : {}),
            ...(column.minWidth ? { minWidth: column.minWidth } : {}),
            ...(column.align ? { textAlign: column.align } : {}),
          }}
        />
      ))}
    </tr>
  )
}
