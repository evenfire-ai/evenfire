'use client'

import { TableHeaderCell } from '@clerum/frontend-components'
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
          kind={column.kind ?? (column.key === 'actions' ? 'actions' : undefined)}
          activeDirection={column.activeDirection}
          defaultDirection={column.defaultDirection}
          onSort={column.onSort}
          sortLabel={column.sortLabel}
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
