'use client'

import React, { useMemo, useState } from 'react'
import { DataTable } from '@clerum/frontend-table-system'
import type {
  ConnectorAccessSummary,
  ConnectorContextBinding,
  McpServerStatus,
  McpServerTableProps,
} from './McpServerTable.types'
import { RowActionsMenu } from './RowActionsMenu'
import { SectionSearchInput } from './SectionSearchInput'
import { SelectionDropdown } from './SelectionDropdown'
import { IconCable } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh, IconX } from './icons'

const ENABLED_TOOLTIP = 'Enabled controls whether this server is available to contexts and agents.'
type ConnectorSortKey =
  | 'name'
  | 'description'
  | 'transport'
  | 'endpoint'
  | 'image'
  | 'access'
  | 'managed'
  | 'enabled'
  | 'status'
type SortDirection = 'asc' | 'desc'

const CONNECTOR_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'description', label: 'Description' },
  { key: 'transport', label: 'Transport' },
  { key: 'endpoint', label: 'Endpoint' },
  { key: 'image', label: 'Image' },
  { key: 'access', label: 'Access' },
  { key: 'managed', label: 'Managed' },
  { key: 'enabled', label: 'Enabled', title: ENABLED_TOOLTIP },
  { key: 'status', label: 'Status' },
  { key: 'actions', align: 'right', ariaLabel: 'Actions' },
]

function TransportBadge({ type }: { type?: string }) {
  return type ? (
    <span className={`cu-connector-badge cu-connector-badge--transport-${type}`}>{type}</span>
  ) : (
    <span className="cu-muted">—</span>
  )
}

function BoolBadge({
  value,
  trueLabel,
  falseLabel,
}: {
  value?: boolean
  trueLabel: string
  falseLabel: string
}) {
  const isTrue = value !== false
  return (
    <span className={`cu-connector-badge cu-connector-badge--${isTrue ? 'yes' : 'no'}`}>
      {isTrue ? trueLabel : falseLabel}
    </span>
  )
}

function getStatusState(status?: McpServerStatus) {
  const conditions = status?.conditions
  const missingSecret = conditions?.find(c => c.type === 'SecretResolved' && c.status === 'False')
  const ready = conditions?.find(c => c.type === 'Ready' && c.status === 'True')
  return missingSecret ? 'error' : ready ? 'ready' : conditions?.length ? 'pending' : 'unknown'
}

function getStatusLabel(status?: McpServerStatus) {
  const state = getStatusState(status)
  return state === 'error'
    ? 'Missing Secret'
    : state === 'ready'
      ? 'Ready'
      : state === 'pending'
        ? 'Pending'
        : 'Unknown'
}

function StatusBadge({ status }: { status?: McpServerStatus }) {
  const conditions = status?.conditions
  const missingSecret = conditions?.find(c => c.type === 'SecretResolved' && c.status === 'False')
  const state = getStatusState(status)
  const label = getStatusLabel(status)
  return (
    <span
      className={`cu-connector-badge cu-connector-badge--status-${state}`}
      title={missingSecret?.message}
    >
      {label}
    </span>
  )
}

export function McpServerTable({
  items,
  accessByConnectorKey,
  contexts = [],
  onAddToContexts,
  onRemoveFromContext,
  updatingContextMembershipKey,
  onDelete,
  onEdit,
  deletingKey,
  onRefresh,
  onCreate,
  onInstallFromRegistry,
  detailContent,
  refreshing,
  loading,
}: McpServerTableProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [sortKey, setSortKey] = useState<ConnectorSortKey | null>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [serverKeyAddingContexts, setServerKeyAddingContexts] = useState<string | null>(null)
  const [serverKeyViewingAccess, setServerKeyViewingAccess] = useState<string | null>(null)
  const [selectedContextNamesToAdd, setSelectedContextNamesToAdd] = useState<string[]>([])
  const rows = useMemo(
    () =>
      items.map(item => {
        const namespace = item.metadata?.namespace || 'default'
        const name = item.metadata?.name || 'unknown'
        return { key: `${namespace}/${name}`, namespace, name, item }
      }),
    [items]
  )
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const filteredRows = useMemo(() => {
    const matchingRows = !normalizedSearch
      ? rows
      : rows.filter(({ namespace, name, item, key }) => {
          const spec = item.spec || {}
          const access = accessByConnectorKey?.[key]
          const accessText = [
            ...(access?.agents ?? []),
            ...(access?.users ?? []),
            ...(access?.teams ?? []),
          ]
            .flatMap(principal => [principal.id, principal.label])
            .join(' ')
          const conditionText = (item.status?.conditions || [])
            .map(condition =>
              [condition.type, condition.status, condition.reason, condition.message].join(' ')
            )
            .join(' ')
          return [
            namespace,
            name,
            spec.image,
            spec.description,
            spec.transport?.type,
            spec.transport?.url,
            accessText,
            conditionText,
          ]
            .join(' ')
            .toLowerCase()
            .includes(normalizedSearch)
        })
    if (!sortKey) return matchingRows

    const direction = sortDirection === 'asc' ? 1 : -1
    return [...matchingRows].sort((left, right) => {
      const leftAccess = accessByConnectorKey?.[left.key]
      const rightAccess = accessByConnectorKey?.[right.key]
      const accessCount = (access?: ConnectorAccessSummary) =>
        (access?.agents.length ?? 0) + (access?.teams.length ?? 0) + (access?.users.length ?? 0)
      const comparison =
        sortKey === 'name'
          ? left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
          : sortKey === 'description'
            ? (left.item.spec?.description ?? '').localeCompare(
                right.item.spec?.description ?? '',
                undefined,
                { sensitivity: 'base' }
              )
            : sortKey === 'transport'
              ? (left.item.spec?.transport?.type ?? '').localeCompare(
                  right.item.spec?.transport?.type ?? ''
                )
              : sortKey === 'endpoint'
                ? (left.item.spec?.transport?.url ?? left.item.spec?.image ?? '').localeCompare(
                    right.item.spec?.transport?.url ?? right.item.spec?.image ?? ''
                  )
                : sortKey === 'image'
                  ? (left.item.spec?.image ?? '').localeCompare(right.item.spec?.image ?? '')
                  : sortKey === 'access'
                    ? accessCount(leftAccess) - accessCount(rightAccess)
                    : sortKey === 'managed'
                      ? Number((left.item.spec?.managed ?? true) === true) -
                        Number((right.item.spec?.managed ?? true) === true)
                      : sortKey === 'enabled'
                        ? Number((left.item.spec?.enabled ?? true) === true) -
                          Number((right.item.spec?.enabled ?? true) === true)
                        : getStatusLabel(left.item.status).localeCompare(
                            getStatusLabel(right.item.status)
                          )
      if (comparison !== 0) return comparison * direction
      return left.key.localeCompare(right.key)
    })
  }, [accessByConnectorKey, normalizedSearch, rows, sortDirection, sortKey])

  React.useEffect(() => {
    if (!onRefresh) return
    const id = setInterval(() => void onRefresh(), 10_000)
    return () => clearInterval(id)
  }, [onRefresh])

  function toggleSort(key: ConnectorSortKey) {
    if (sortKey === key) {
      setSortDirection(direction => (direction === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDirection('asc')
  }

  function renderSortHeader(key: ConnectorSortKey, label: string) {
    const isActive = sortKey === key
    const indicator = isActive ? (sortDirection === 'asc' ? '↑' : '↓') : ''
    const nextDirection = isActive && sortDirection === 'asc' ? 'descending' : 'ascending'
    return (
      <button
        type="button"
        className={`cu-table__sort-link${isActive ? ' is-active' : ''}`}
        onClick={() => toggleSort(key)}
        aria-label={`Sort by ${label.toLowerCase()} ${nextDirection}`}
        aria-pressed={isActive}
      >
        {label} {indicator}
      </button>
    )
  }

  const columns = CONNECTOR_COLUMNS.map(column => {
    if (column.key !== 'actions') {
      return {
        ...column,
        label: renderSortHeader(column.key as ConnectorSortKey, column.label as string),
      }
    }
    return column
  })

  function contextsForConnector(name: string): ConnectorContextBinding[] {
    return contexts.filter(context => context.mcpServers.includes(name))
  }

  function openAddContexts(key: string) {
    setSelectedContextNamesToAdd([])
    setServerKeyAddingContexts(key)
  }

  function closeAddContexts() {
    if (updatingContextMembershipKey) return
    setSelectedContextNamesToAdd([])
    setServerKeyAddingContexts(null)
  }

  const isInitialLoad = loading && items.length === 0

  return (
    <div className="cu-card cu-card--viewport-fill cu-section-card">
      <TablePanelHeader
        title={
          <>
            <IconCable />
            {isInitialLoad ? 'Connectors' : `Connectors (${filteredRows.length})`}
          </>
        }
        titleActions={
          onCreate ? (
            <RowActionsMenu
              ariaLabel="Connector actions"
              horizontalTrigger
              actions={[
                {
                  key: 'create',
                  label: 'Create connector',
                  onClick: onCreate,
                  disabled: isInitialLoad,
                },
              ]}
            />
          ) : null
        }
        subtitle="Browse connector deployments and context bindings."
        actionsClassName="cu-table-panel__actions--mcp"
        actions={
          <>
            <SectionSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search connectors"
              ariaLabel="Search connectors"
              disabled={isInitialLoad}
            />
            {onRefresh ? (
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--toolbar"
                onClick={() => void onRefresh()}
                disabled={refreshing || isInitialLoad}
                aria-label={refreshing ? 'Refreshing...' : 'Reload connectors'}
              >
                <IconRefresh
                  className={refreshing ? 'cu-spin' : undefined}
                  width={18}
                  height={18}
                />
              </button>
            ) : null}
            {onInstallFromRegistry ? (
              <button
                type="button"
                className="cu-btn cu-btn--primary cu-btn--sm cu-btn--mcp-install"
                onClick={onInstallFromRegistry}
                disabled={isInitialLoad}
              >
                Install from Marketplace
              </button>
            ) : null}
          </>
        }
      />
      {detailContent ? <div className="cu-card__body">{detailContent}</div> : null}
      {isInitialLoad ? (
        <div className="eft-table-viewport cu-table-wrap cu-connectors-table-wrap">
          <DataTable className="eft-table cu-table cu-table--header-band cu-expandable-table cu-connectors-table">
            <thead>
              <TableHeaderRow columns={columns} />
            </thead>
            <tbody>
              <SkeletonTableRows columns={columns.length} rows={5} />
            </tbody>
          </DataTable>
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="cu-empty">
          {normalizedSearch ? 'No connectors match this search.' : 'No connectors found.'}
        </div>
      ) : (
        <div className="eft-table-viewport cu-table-wrap cu-connectors-table-wrap">
          <DataTable className="eft-table cu-table cu-table--header-band cu-expandable-table cu-connectors-table">
            <thead>
              <TableHeaderRow columns={columns} />
            </thead>
            <tbody>
              {filteredRows.map(({ key, namespace, name, item }) => {
                const spec = item.spec || {}
                const assignedContexts = contextsForConnector(name)
                const contextMembershipBusy = updatingContextMembershipKey === key
                const access = accessByConnectorKey?.[key]
                return (
                  <tr
                    className={onEdit ? 'cu-table__row cu-table__row--clickable' : undefined}
                    key={key}
                    onClick={onEdit ? () => onEdit({ namespace, name }) : undefined}
                    onKeyDown={
                      onEdit
                        ? event => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              onEdit({ namespace, name })
                            }
                          }
                        : undefined
                    }
                    tabIndex={onEdit ? 0 : undefined}
                  >
                    <td>{name}</td>
                    <td>
                      <span className="cu-cell-truncate" title={spec.description}>
                        {spec.description || '—'}
                      </span>
                    </td>
                    <td>
                      <TransportBadge type={spec.transport?.type} />
                    </td>
                    <td className="cu-code-text">
                      <span className="cu-cell-truncate" title={spec.transport?.url || spec.image}>
                        {spec.transport?.url || spec.image || '—'}
                      </span>
                    </td>
                    <td className="cu-code-text">
                      <span className="cu-cell-truncate" title={spec.image || undefined}>
                        {spec.image || '—'}
                      </span>
                    </td>
                    <td>
                      {assignedContexts.length} context{assignedContexts.length === 1 ? '' : 's'} ·{' '}
                      {(access?.agents.length ?? 0) +
                        (access?.teams.length ?? 0) +
                        (access?.users.length ?? 0)}{' '}
                      principal
                      {(access?.agents.length ?? 0) +
                        (access?.teams.length ?? 0) +
                        (access?.users.length ?? 0) ===
                      1
                        ? ''
                        : 's'}
                    </td>
                    <td>
                      <BoolBadge value={spec.managed} trueLabel="Yes" falseLabel="No" />
                    </td>
                    <td>
                      <BoolBadge value={spec.enabled} trueLabel="Yes" falseLabel="No" />
                    </td>
                    <td>
                      <StatusBadge status={item.status} />
                    </td>
                    <td
                      className="cu-table__cell-actions"
                      onClick={event => event.stopPropagation()}
                      onKeyDown={event => event.stopPropagation()}
                    >
                      <RowActionsMenu
                        ariaLabel={`Actions for connector ${name}`}
                        actions={[
                          ...(onEdit
                            ? [
                                {
                                  key: 'view',
                                  label: 'View details',
                                  onClick: () => onEdit({ namespace, name }),
                                },
                              ]
                            : []),
                          ...(onAddToContexts
                            ? [
                                {
                                  key: 'add-contexts',
                                  label: 'Add to contexts',
                                  disabled: contextMembershipBusy,
                                  onClick: () => openAddContexts(key),
                                },
                              ]
                            : []),
                          {
                            key: 'view-access',
                            label: 'View access details',
                            onClick: () => setServerKeyViewingAccess(key),
                          },
                          ...(onRemoveFromContext
                            ? assignedContexts.map(context => ({
                                key: `remove-context-${context.name}`,
                                label: `Remove from ${context.name}`,
                                disabled: contextMembershipBusy,
                                onClick: () =>
                                  void onRemoveFromContext({ name, namespace }, context.name),
                              }))
                            : []),
                          ...(onDelete
                            ? [
                                {
                                  key: 'remove',
                                  label: deletingKey === key ? 'Deleting…' : 'Delete',
                                  danger: true,
                                  disabled: deletingKey === key,
                                  onClick: () => void onDelete({ namespace, name }),
                                },
                              ]
                            : []),
                        ]}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </DataTable>
        </div>
      )}
      {serverKeyAddingContexts
        ? (() => {
            const row = rows.find(candidate => candidate.key === serverKeyAddingContexts)
            if (!row || !onAddToContexts) return null
            const assignedNames = new Set(
              contextsForConnector(row.name).map(context => context.name)
            )
            const contextOptions = contexts
              .filter(context => !assignedNames.has(context.name))
              .map(context => ({
                value: context.name,
                label: context.name,
                description: context.description || undefined,
              }))
            const busy = updatingContextMembershipKey === row.key
            return (
              <div
                className="cu-modal-backdrop"
                role="presentation"
                onClick={event => {
                  if (event.target === event.currentTarget && !busy) closeAddContexts()
                }}
              >
                <div
                  className="cu-modal-panel cu-modal-panel--selection"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="add-connector-context-title"
                  onClick={event => event.stopPropagation()}
                >
                  <div className="cu-modal-panel__head">
                    <h3 id="add-connector-context-title" className="cu-modal-panel__title">
                      Add connector to contexts
                    </h3>
                    <button
                      type="button"
                      className="cu-btn cu-btn--icon cu-btn--ghost"
                      onClick={closeAddContexts}
                      disabled={busy}
                      aria-label="Close"
                    >
                      <IconX width={18} height={18} />
                    </button>
                  </div>

                  <div className="cu-field">
                    <label htmlFor="connector-context-picker">Contexts</label>
                    <SelectionDropdown
                      id="connector-context-picker"
                      inline
                      value={selectedContextNamesToAdd}
                      onChange={setSelectedContextNamesToAdd}
                      options={contextOptions}
                      placeholder="Select contexts"
                      searchPlaceholder="Search contexts..."
                      selectionLabel="Selected contexts"
                      emptyLabel="No available contexts."
                      disabled={busy}
                    />
                  </div>

                  <div className="cu-modal-panel__foot">
                    <button
                      type="button"
                      className="cu-btn cu-btn--ghost cu-btn--sm"
                      onClick={closeAddContexts}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="cu-btn cu-btn--primary"
                      onClick={async () => {
                        if (selectedContextNamesToAdd.length === 0) return
                        await onAddToContexts(
                          { namespace: row.namespace, name: row.name },
                          selectedContextNamesToAdd
                        )
                        setSelectedContextNamesToAdd([])
                        setServerKeyAddingContexts(null)
                      }}
                      disabled={busy || selectedContextNamesToAdd.length === 0}
                    >
                      {selectedContextNamesToAdd.length > 1 ? 'Add to contexts' : 'Add to context'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })()
        : null}
      {serverKeyViewingAccess
        ? (() => {
            const row = rows.find(candidate => candidate.key === serverKeyViewingAccess)
            if (!row) return null
            const access = accessByConnectorKey?.[row.key]
            const linkedContexts = contextsForConnector(row.name)
            const groups = [
              { key: 'contexts', label: 'Contexts', items: linkedContexts.map(item => item.name) },
              {
                key: 'agents',
                label: 'Agents',
                items: (access?.agents ?? []).map(item => item.label),
              },
              {
                key: 'teams',
                label: 'Teams',
                items: (access?.teams ?? []).map(item => item.label),
              },
              {
                key: 'users',
                label: 'Users',
                items: (access?.users ?? []).map(item => item.label),
              },
            ]
            return (
              <div
                className="cu-modal-overlay"
                role="presentation"
                onMouseDown={event => {
                  if (event.target === event.currentTarget) setServerKeyViewingAccess(null)
                }}
              >
                <section
                  aria-labelledby="connector-access-title"
                  aria-modal="true"
                  className="cu-modal-panel"
                  role="dialog"
                >
                  <div className="cu-modal-panel__header">
                    <h3 className="cu-modal-panel__title" id="connector-access-title">
                      Access for {row.name}
                    </h3>
                  </div>
                  <div className="cu-registry-context-access cu-connector-access-grid">
                    {groups.map(group => (
                      <section className="cu-registry-context-access__group" key={group.key}>
                        <div className="cu-registry-context-access__heading">
                          <h4>{group.label}</h4>
                          <span>{group.items.length}</span>
                        </div>
                        {group.items.length ? (
                          <ul className="cu-registry-context-access__list">
                            {group.items.map(item => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="cu-muted">No {group.label.toLowerCase()} linked.</p>
                        )}
                      </section>
                    ))}
                  </div>
                  <div className="cu-modal-panel__actions">
                    <button
                      className="cu-btn cu-btn--primary"
                      onClick={() => setServerKeyViewingAccess(null)}
                      type="button"
                    >
                      Close
                    </button>
                  </div>
                </section>
              </div>
            )
          })()
        : null}
    </div>
  )
}
