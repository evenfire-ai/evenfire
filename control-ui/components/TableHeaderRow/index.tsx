'use client'

import React from 'react'
import type { TableHeaderColumn, TableHeaderRowProps } from './types'

// Hint for the pointer tooltip only. It must NOT be an aria-label: that would
// override the button's text as the accessible name and, since the button is
// the sole content of the <th>, screen readers would announce "Sort by model
// ascending" as the header of every cell in the column. The sort state is
// already conveyed by `aria-sort` on the <th>.
function sortTitle(column: TableHeaderColumn, nextDir: 'ascending' | 'descending') {
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
        // The tooltip announces the direction the *next* click will apply.
        const nextDir: 'ascending' | 'descending' =
          isActive && sortDir === 'asc' ? 'descending' : 'ascending'
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
                className="cu-link cu-link--sort"
                onClick={() => onSortToggle?.(column.key)}
                title={sortTitle(column, nextDir)}
              >
                {column.label}
                {isActive ? (
                  <span aria-hidden="true">{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>
                ) : null}
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
