'use client'

import React, { useMemo, useState } from 'react'
import { DataTable, TableRow, TableStateRow, useTableSort } from '@clerum/frontend-components'
import { ContextResource } from '../lib/api'
import { RowActionsMenu } from './RowActionsMenu'
import { SectionSearchInput } from './SectionSearchInput'
import { IconGroupWork } from './Sidebar/icons'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh } from './icons'

type ContextRef = { name: string }

const CONTEXT_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Context Name' },
  { key: 'identifier', label: 'Identifier' },
  { key: 'description', label: 'Description' },
  { key: 'servers', label: 'Connectors', width: '7rem' },
  { key: 'actions', label: 'Actions', width: '8rem', align: 'right' },
]

export function ContextTable({
  items,
  onView,
  onEdit,
  onDelete,
  deletingKey,
  onRefresh,
  onCreate,
  refreshing,
  loading,
}: {
  items: ContextResource[]
  onView: (context: ContextRef) => void
  onEdit: (context: ContextRef) => void
  onDelete: (context: ContextRef) => Promise<void>
  deletingKey: string | null
  onRefresh: () => void
  onCreate: () => void
  refreshing: boolean
  loading?: boolean
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const rows = useMemo(
    () =>
      items.map(item => {
        const name = item.metadata?.name || 'unknown'
        // Visible name is the optional spec.displayName; fall back to the slug
        // (metadata.name) when it is absent OR blank-after-trim — a displayName
        // written out-of-band (e.g. kubectl) as '' or '   ' must not render a
        // blank label. Mirrors HostTable.tsx (`.trim() || name`).
        const displayName = (item.spec?.displayName ?? '').trim() || name
        const key = name
        const mcpServers = Array.isArray(item.spec?.mcpServers) ? item.spec?.mcpServers : []
        return { key, name, displayName, item, mcpServers }
      }),
    [items]
  )
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const filteredRows = useMemo(() => {
    if (!normalizedSearch) return rows
    return rows.filter(({ name, displayName, item, mcpServers }) => {
      const description = String(item.spec?.description || '').trim()
      return [name, displayName, description, String(mcpServers.length), ...mcpServers.map(String)]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    })
  }, [normalizedSearch, rows])
  const contextSort = useTableSort<
    (typeof filteredRows)[number],
    'name' | 'identifier' | 'description' | 'servers'
  >({
    rows: filteredRows,
    defaultKey: 'name',
    accessors: {
      name: row => row.displayName,
      identifier: row => row.name,
      description: row => String(row.item.spec?.description || ''),
      servers: row => row.mcpServers.length,
    },
    identity: row => row.key,
  })
  const contextColumns = CONTEXT_COLUMNS.map(column => ({
    ...column,
    ...(column.key !== 'actions'
      ? {
          activeDirection: contextSort.key === column.key ? contextSort.direction : null,
          onSort: () =>
            contextSort.sortBy(column.key as 'name' | 'identifier' | 'description' | 'servers'),
        }
      : {}),
  }))

  const isInitialLoad = loading && items.length === 0

  function openContext(name: string) {
    onView({ name })
  }

  return (
    <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
      <TablePanelHeader
        title={
          <>
            <IconGroupWork />
            {isInitialLoad ? 'Contexts' : `Contexts (${filteredRows.length})`}
          </>
        }
        subtitle="Group connectors into reusable access scopes."
        primaryAction={
          <button
            type="button"
            className="cu-btn cu-btn--primary cu-btn--sm"
            onClick={onCreate}
            disabled={isInitialLoad}
          >
            Create context
          </button>
        }
        refreshAction={
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--toolbar"
            onClick={() => void onRefresh()}
            disabled={refreshing || isInitialLoad}
            aria-label={refreshing ? 'Refreshing…' : 'Reload contexts'}
          >
            <IconRefresh className={refreshing ? 'cu-spin' : undefined} width={18} height={18} />
          </button>
        }
        search={
          <SectionSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search contexts"
            ariaLabel="Search contexts"
            disabled={isInitialLoad}
          />
        }
      />
      <div className="eft-table-viewport cu-table-wrap">
        <DataTable className="eft-table cu-table cu-table--header-band">
          <thead>
            <TableHeaderRow columns={contextColumns} />
          </thead>
          <tbody>
            {isInitialLoad ? (
              <TableStateRow
                colSpan={contextColumns.length}
                kind="loading"
                message="Loading contexts…"
              />
            ) : filteredRows.length === 0 ? (
              <TableStateRow
                colSpan={contextColumns.length}
                message={normalizedSearch ? 'No contexts match this search.' : 'No contexts found.'}
              />
            ) : (
              contextSort.sortedRows.map(({ key, name, displayName, item, mcpServers }) => (
                <TableRow
                  key={key}
                  className="cu-table__row cu-table__row--clickable"
                  onNavigate={() => openContext(name)}
                  aria-label={`Open context ${name}`}
                >
                  <td>
                    <span className="cu-table__cell-name">{displayName}</span>
                  </td>
                  <td className="cu-table__cell-subtle">{name}</td>
                  <td className="cu-registry-description" title={item.spec?.description || '—'}>
                    {item.spec?.description || '—'}
                  </td>
                  <td style={{ color: 'var(--cu-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {mcpServers.length}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="cu-table-actions">
                      <RowActionsMenu
                        ariaLabel={`Actions for context ${name}`}
                        horizontalTrigger
                        actions={[
                          {
                            key: 'view',
                            label: 'View details',
                            onClick: () => openContext(name),
                          },
                          {
                            key: 'edit',
                            label: 'Edit',
                            onClick: () => onEdit({ name }),
                          },
                          {
                            key: 'delete',
                            label: deletingKey === key ? 'Deleting…' : 'Delete',
                            danger: true,
                            disabled: deletingKey === key,
                            onClick: () => void onDelete({ name }),
                          },
                        ]}
                      />
                    </div>
                  </td>
                </TableRow>
              ))
            )}
          </tbody>
        </DataTable>
      </div>
    </div>
  )
}
