'use client'

import React from 'react'
import type { TableHeaderColumn } from './types'

export function TableHeaderRow({ columns }: { columns: TableHeaderColumn[] }) {
  return (
    <tr>
      {columns.map(column => (
        <th
          key={column.key}
          aria-label={column.ariaLabel}
          title={column.title}
          style={{
            ...(column.width ? { width: column.width } : {}),
            ...(column.minWidth ? { minWidth: column.minWidth } : {}),
            ...(column.align ? { textAlign: column.align } : {}),
          }}
        >
          {column.label}
        </th>
      ))}
    </tr>
  )
}
