'use client'

import React from 'react'
import type { TableHeaderColumn, TableHeaderRowProps } from './types'

function sortAriaLabel(column: TableHeaderColumn, isActive: boolean, nextDir: string) {
  const name =
    column.sortLabel ??
    (typeof column.label === 'string' ? column.label : (column.ariaLabel ?? column.key))
  return `Sort by ${name.toLowerCase()} ${nextDir}`
}

export function TableHeaderRow({
  columns,
  sortKey = null,
  sortDir = 'asc',
  onSortToggle,
}: TableHeaderRowProps) {
  return (
    <tr>
      {columns.map(column => {
        const isSortable = Boolean(column.sortable) && Boolean(onSortToggle)
        const isActive = isSortable && sortKey === column.key
        // The label announces the direction the *next* click will apply.
        const nextDir = isActive && sortDir === 'asc' ? 'descending' : 'ascending'
        return (
          <th
            key={column.key}
            aria-label={column.ariaLabel}
            aria-sort={isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
            title={column.title}
            style={{
              ...(column.width ? { width: column.width } : {}),
              ...(column.minWidth ? { minWidth: column.minWidth } : {}),
              ...(column.align ? { textAlign: column.align } : {}),
            }}
          >
            {isSortable ? (
              <button
                type="button"
                className="cu-link cu-link--sm cu-link--sort"
                onClick={() => onSortToggle?.(column.key)}
                aria-label={sortAriaLabel(column, isActive, nextDir)}
              >
                {column.label}
                {isActive ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
              </button>
            ) : (
              column.label
            )}
          </th>
        )
      })}
    </tr>
  )
}
