'use client'

import React, { useMemo, useState } from 'react'
import { ContextResource } from '../lib/api'
import { RowActionsMenu } from './RowActionsMenu'
import { SectionSearchInput } from './SectionSearchInput'
import { IconGroupWork } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh } from './icons'

type ContextRef = { name: string }

const CONTEXT_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Context Name' },
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

  const isInitialLoad = loading && items.length === 0

  function openContext(name: string) {
    onView({ name })
  }

  function handleRowKeyDown(event: React.KeyboardEvent<HTMLTableRowElement>, name: string) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openContext(name)
    }
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
        actions={
          <>
            <SectionSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search contexts"
              ariaLabel="Search contexts"
              disabled={isInitialLoad}
            />
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              onClick={() => void onRefresh()}
              disabled={refreshing || isInitialLoad}
              aria-label={refreshing ? 'Refreshing…' : 'Reload contexts'}
            >
              <IconRefresh className={refreshing ? 'cu-spin' : undefined} width={18} height={18} />
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={onCreate}
              disabled={isInitialLoad}
            >
              Create context
            </button>
          </>
        }
      />
      {isInitialLoad ? (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={CONTEXT_COLUMNS} />
            </thead>
            <tbody>
              <SkeletonTableRows columns={CONTEXT_COLUMNS.length} rows={4} />
            </tbody>
          </table>
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="cu-empty">
          {normalizedSearch ? 'No contexts match this search.' : 'No contexts found.'}
        </div>
      ) : (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={CONTEXT_COLUMNS} />
            </thead>
            <tbody>
              {filteredRows.map(({ key, name, displayName, item, mcpServers }) => (
                <tr
                  key={key}
                  className="cu-table__row cu-table__row--clickable"
                  onClick={() => openContext(name)}
                  onKeyDown={event => handleRowKeyDown(event, name)}
                  tabIndex={0}
                  aria-label={`Open context ${name}`}
                >
                  <td>
                    <span className="cu-expandable-row__name">{displayName}</span>
                    {displayName !== name ? (
                      <div className="cu-table__cell-subtle">{name}</div>
                    ) : null}
                    <div className="cu-registry-description" title={item.spec?.description || '—'}>
                      {item.spec?.description || '—'}
                    </div>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
