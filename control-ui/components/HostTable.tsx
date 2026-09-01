'use client'

import React, { useMemo, useState } from 'react'
import { DataTable, TableRow, TableStateRow, useTableSort } from '@clerum/frontend-components'
import { getProviderLabel } from '../lib/llm'
import type { HostItem, HostRef } from './HostTable.types'
import { LlmProviderIcon } from './LlmProviderIcon'
import { RowActionsMenu } from './RowActionsMenu'
import { SectionSearchInput } from './SectionSearchInput'
import { IconRobot } from './Sidebar/icons'
import { TableEmptyRow } from './TableEmptyRow'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh } from './icons'

const HOST_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'identifier', label: 'Identifier' },
  { key: 'context', label: 'Connectors', width: '14%' },
  { key: 'providers', label: 'Providers', minWidth: '8rem' },
  { key: 'actions', width: '3.5rem', align: 'right', ariaLabel: 'Actions' },
]

export function collectProviderIds(spec: Record<string, unknown>): string[] {
  const primary = String((spec.model as { provider?: string } | undefined)?.provider || '').trim()
  const fallbacks = Array.isArray(
    (spec.llmPolicy as { fallbacks?: Array<{ provider?: string }> } | undefined)?.fallbacks
  )
    ? (spec.llmPolicy as { fallbacks: Array<{ provider?: string }> }).fallbacks
        .map(f => String(f.provider || '').trim())
        .filter(Boolean)
    : []
  // Primary first, then fallbacks in declared order; dedup so the same provider
  // doesn't render twice if it appears in both the model and the fallback list.
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of [primary, ...fallbacks]) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

// Hover card over the context cell. Mirrors the `cu-agent-context-mcp-summary`
// block the create wizard shows for the selected context — the operator gets
// the same list of attached MCP servers without navigating away. The card is
// keyboard-accessible (focus + blur mirror hover) and `role="tooltip"` keeps
// screen readers in sync with what's visible.
function ContextMcpHoverCard({
  contextRef,
  mcpServers,
  onOpenContext,
}: {
  contextRef: string
  mcpServers: string[] | undefined
  onOpenContext: (contextRef: string) => void
}) {
  const [open, setOpen] = useState(false)
  const servers = Array.isArray(mcpServers) ? mcpServers : []
  const hasServers = servers.length > 0
  const cardId = `ctx-mcp-${contextRef}`

  const trigger = (
    <button
      type="button"
      className="cu-link cu-host-context-count"
      onClick={e => {
        e.stopPropagation()
        onOpenContext(contextRef)
      }}
      onKeyDown={e => e.stopPropagation()}
      aria-describedby={hasServers && open ? cardId : undefined}
    >
      {servers.length}
    </button>
  )

  if (!hasServers) return trigger

  return (
    <span
      className="cu-host-context-hover"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {trigger}
      {open ? (
        <div role="tooltip" id={cardId} className="cu-agent-context-mcp-summary">
          <div className="cu-agent-context-mcp-summary__head">
            <span>{contextRef}</span>
            <span>{servers.length}</span>
          </div>
          <ul className="cu-agent-context-mcp-summary__list">
            {servers.map(server => (
              <li key={server} title={server}>
                {server}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </span>
  )
}

export function HostTable({
  items,
  onOpen,
  onOpenContext,
  onDelete,
  deletingKey,
  onRefresh,
  onCreateHost,
  refreshing,
  loading,
  contextsByRef,
}: {
  items: HostItem[]
  onOpen: (host: HostRef) => void
  onOpenContext: (contextName: string) => void
  onDelete: (host: HostRef) => Promise<void>
  deletingKey: string | null
  onRefresh: () => void
  onCreateHost: () => void
  refreshing: boolean
  loading?: boolean
  // contextRef (host.spec.contextRef) → list of attached MCP server names. The
  // page passes this from the same `/api/v1/admin/contexts` payload the
  // creation wizard consumes, so the operator sees the same attribution here.
  contextsByRef?: Record<string, string[]>
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const rows = useMemo(
    () =>
      items.map(i => {
        const namespace = i.metadata?.namespace || 'default'
        const name = i.metadata?.name || 'unknown'
        // The visible name is the editable spec.host; the slug (metadata.name)
        // stays as secondary identity. Empty-after-trim falls back to the slug
        // (legacy Hosts, mirrors accessReconciliation), never a blank label.
        const displayName =
          String((i.spec as { host?: string } | undefined)?.host || '').trim() || name
        const key = `${namespace}/${name}`
        return { key, namespace, name, displayName, item: i }
      }),
    [items]
  )
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const filteredRows = useMemo(() => {
    if (!normalizedSearch) return rows
    return rows.filter(({ name, displayName, namespace, item }) => {
      const spec = item.spec || {}
      const contextRef = String(spec.contextRef || '').trim()
      const providers = collectProviderIds(spec)
      const providerLabels = providers.map(id => getProviderLabel(id)).join(' ')
      return [name, displayName, namespace, contextRef, providerLabels]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    })
  }, [normalizedSearch, rows])
  const hostSort = useTableSort<
    (typeof filteredRows)[number],
    'name' | 'identifier' | 'context' | 'providers'
  >({
    rows: filteredRows,
    defaultKey: 'name',
    accessors: {
      name: row => row.displayName,
      identifier: row => row.name,
      context: row => contextsByRef?.[String(row.item.spec?.contextRef || '').trim()]?.length ?? 0,
      providers: row => collectProviderIds(row.item.spec || {}).join(','),
    },
    identity: row => row.key,
  })
  const hostColumns = HOST_COLUMNS.map(column => ({
    ...column,
    ...(column.key !== 'actions'
      ? {
          activeDirection: hostSort.key === column.key ? hostSort.direction : null,
          onSort: () =>
            hostSort.sortBy(column.key as 'name' | 'identifier' | 'context' | 'providers'),
        }
      : {}),
  }))

  const isInitialLoad = loading && items.length === 0

  return (
    <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
      <TablePanelHeader
        title={
          <>
            <IconRobot />
            {isInitialLoad ? 'Agents' : `Agents (${filteredRows.length})`}
          </>
        }
        subtitle="Manage available agents and their host mappings."
        primaryAction={
          <button
            type="button"
            className="cu-btn cu-btn--primary cu-btn--sm"
            onClick={onCreateHost}
            disabled={isInitialLoad}
          >
            Create agent
          </button>
        }
        refreshAction={
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--toolbar"
            onClick={() => void onRefresh()}
            disabled={refreshing || isInitialLoad}
            aria-label={refreshing ? 'Refreshing…' : 'Reload agents'}
          >
            <IconRefresh className={refreshing ? 'cu-spin' : undefined} width={18} height={18} />
          </button>
        }
        search={
          <SectionSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search agents"
            ariaLabel="Search agents"
            disabled={isInitialLoad}
          />
        }
      />
      <div className="eft-table-viewport cu-table-wrap">
        <DataTable className="eft-table cu-table cu-table--header-band">
          <thead>
            <TableHeaderRow columns={hostColumns} />
          </thead>
          <tbody>
            {isInitialLoad ? (
              <TableStateRow
                colSpan={hostColumns.length}
                kind="loading"
                message="Loading agents…"
              />
            ) : filteredRows.length === 0 ? (
              <TableEmptyRow
                colSpan={hostColumns.length}
                message={normalizedSearch ? 'No agents match this search.' : 'No agents found.'}
                action={
                  normalizedSearch
                    ? { label: 'Clear search', onSelect: () => setSearchQuery('') }
                    : undefined
                }
              />
            ) : (
              hostSort.sortedRows.map(({ key, namespace, name, displayName, item }) => {
                const rawContext = String(item.spec?.contextRef || '').trim()
                const contextRef = rawContext || '-'
                const contextServers = contextsByRef?.[rawContext]
                const contextClickable =
                  Boolean(rawContext) && Array.isArray(contextServers) && contextServers.length > 0
                const providers = collectProviderIds(item.spec || {})
                const openAgent = () => onOpen({ namespace, name })
                return (
                  <TableRow
                    key={key}
                    className="cu-table__row cu-table__row--clickable"
                    onNavigate={openAgent}
                    aria-label={`Open agent ${name}`}
                  >
                    <td>
                      <span className="cu-table__cell-name">{displayName}</span>
                    </td>
                    <td className="cu-table__cell-subtle">{name}</td>
                    <td>
                      {contextClickable ? (
                        <ContextMcpHoverCard
                          contextRef={contextRef}
                          mcpServers={contextServers}
                          onOpenContext={onOpenContext}
                        />
                      ) : rawContext ? (
                        <span className="cu-table__cell-muted">0</span>
                      ) : (
                        <span className="cu-table__cell-muted">—</span>
                      )}
                    </td>
                    <td className="cu-table__cell-soft">
                      {providers.length === 0 ? (
                        <span className="cu-table__cell-muted">-</span>
                      ) : (
                        <span
                          className="cu-host-providers"
                          aria-label={`Providers: ${providers
                            .map(id => getProviderLabel(id))
                            .join(', ')}`}
                        >
                          {providers.map(providerId => {
                            const label = getProviderLabel(providerId)
                            return (
                              <span
                                key={providerId}
                                className="cu-host-providers__chip"
                                title={label}
                              >
                                <LlmProviderIcon provider={providerId} label={label} />
                              </span>
                            )
                          })}
                        </span>
                      )}
                    </td>
                    <td className="cu-table__cell-actions" onClick={e => e.stopPropagation()}>
                      <RowActionsMenu
                        ariaLabel={`Actions for agent ${name}`}
                        horizontalTrigger
                        actions={[
                          {
                            key: 'view',
                            label: 'View agent details',
                            onClick: () => onOpen({ namespace, name }),
                          },
                          {
                            key: 'delete',
                            label: deletingKey === key ? 'Deleting agent…' : 'Delete',
                            danger: true,
                            disabled: deletingKey === key,
                            onClick: () => void onDelete({ namespace, name }),
                          },
                        ]}
                      />
                    </td>
                  </TableRow>
                )
              })
            )}
          </tbody>
        </DataTable>
      </div>
    </div>
  )
}
