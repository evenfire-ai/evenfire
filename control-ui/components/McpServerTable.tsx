'use client'

import React, { useMemo, useState } from 'react'
import {
  DataTable,
  TableRow,
  TableStateRow,
  TableViewport,
  TruncatedText,
} from '@clerum/frontend-components'
import { canAssignConnectorToContext } from '../lib/connectorOAuthAccess'
import type {
  ConnectorAgentBinding,
  McpServerStatus,
  McpServerTableProps,
} from './McpServerTable.types'
import { RowActionsMenu } from './RowActionsMenu'
import { SectionSearchInput } from './SectionSearchInput'
import { SelectionDropdown } from './SelectionDropdown'
import { IconCable } from './Sidebar/icons'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh, IconX } from './icons'

const ENABLED_TOOLTIP = 'Enabled controls whether this server is available to agents.'
type ConnectorSortKey = 'name' | 'description' | 'managed' | 'enabled' | 'status'
type SortDirection = 'asc' | 'desc'

const CONNECTOR_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name', width: '24%' },
  { key: 'description', label: 'Description' },
  { key: 'managed', label: 'Managed', width: '6rem' },
  { key: 'enabled', label: 'Enabled', title: ENABLED_TOOLTIP, width: '6rem' },
  { key: 'status', label: 'Status', width: '7rem' },
  { key: 'actions', align: 'right', ariaLabel: 'Actions', width: '3.5rem' },
]

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
  agentBindingsByConnectorName = {},
  agentTargets = [],
  onAddToAgents,
  onRemoveFromAgents,
  updatingAgentAccessKey,
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
  const [sortKey, setSortKey] = useState<ConnectorSortKey>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [serverKeyAddingAgents, setServerKeyAddingAgents] = useState<string | null>(null)
  const [serverKeyViewingAccess, setServerKeyViewingAccess] = useState<string | null>(null)
  const [selectedAgentNamesToAdd, setSelectedAgentNamesToAdd] = useState<string[]>([])
  const accessDialogRef = React.useRef<HTMLElement | null>(null)
  const accessCloseButtonRef = React.useRef<HTMLButtonElement | null>(null)
  const accessOpenerRef = React.useRef<HTMLElement | null>(null)
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
    const direction = sortDirection === 'asc' ? 1 : -1
    return [...matchingRows].sort((left, right) => {
      const comparison =
        sortKey === 'name'
          ? left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
          : sortKey === 'description'
            ? (left.item.spec?.description ?? '').localeCompare(
                right.item.spec?.description ?? '',
                undefined,
                { sensitivity: 'base' }
              )
            : sortKey === 'managed'
              ? Number((left.item.spec?.managed ?? true) === true) -
                Number((right.item.spec?.managed ?? true) === true)
              : sortKey === 'enabled'
                ? Number((left.item.spec?.enabled ?? true) === true) -
                  Number((right.item.spec?.enabled ?? true) === true)
                : getStatusLabel(left.item.status).localeCompare(getStatusLabel(right.item.status))
      if (comparison !== 0) return comparison * direction
      return left.key.localeCompare(right.key)
    })
  }, [accessByConnectorKey, normalizedSearch, rows, sortDirection, sortKey])

  React.useEffect(() => {
    if (!onRefresh) return
    const id = setInterval(() => void onRefresh(), 10_000)
    return () => clearInterval(id)
  }, [onRefresh])

  React.useEffect(() => {
    if (!serverKeyViewingAccess) return
    accessCloseButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setServerKeyViewingAccess(null)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        accessDialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      )
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    const opener = accessOpenerRef.current
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      opener?.focus()
    }
  }, [serverKeyViewingAccess])

  function toggleSort(key: ConnectorSortKey) {
    if (sortKey === key) {
      setSortDirection(direction => (direction === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDirection('asc')
  }

  const columns = CONNECTOR_COLUMNS.map(column => {
    if (column.key !== 'actions') {
      const key = column.key as ConnectorSortKey
      return {
        ...column,
        activeDirection: sortKey === key ? sortDirection : null,
        onSort: () => toggleSort(key),
      }
    }
    return column
  })

  function bindingsForConnector(name: string): ConnectorAgentBinding[] {
    return agentBindingsByConnectorName[name] ?? []
  }

  function openAddAgents(key: string) {
    setSelectedAgentNamesToAdd([])
    setServerKeyAddingAgents(key)
  }

  function closeAddAgents() {
    if (updatingAgentAccessKey) return
    setSelectedAgentNamesToAdd([])
    setServerKeyAddingAgents(null)
  }

  function openAccessDetails(key: string) {
    accessOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setServerKeyViewingAccess(key)
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
        subtitle="Browse connector deployments and agent access."
        actionsClassName="cu-table-panel__actions--mcp"
        primaryAction={
          onInstallFromRegistry ? (
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm cu-btn--mcp-install"
              onClick={onInstallFromRegistry}
              disabled={isInitialLoad}
            >
              Install from Marketplace
            </button>
          ) : undefined
        }
        refreshAction={
          onRefresh ? (
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              onClick={() => void onRefresh()}
              disabled={refreshing || isInitialLoad}
              aria-label={refreshing ? 'Refreshing...' : 'Reload connectors'}
            >
              <IconRefresh className={refreshing ? 'cu-spin' : undefined} width={18} height={18} />
            </button>
          ) : undefined
        }
        search={
          <SectionSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search connectors"
            ariaLabel="Search connectors"
            disabled={isInitialLoad}
          />
        }
      />
      {detailContent ? <div className="cu-card__body">{detailContent}</div> : null}
      <TableViewport className="cu-table-wrap cu-connectors-table-wrap">
        <DataTable className="eft-table cu-table cu-table--header-band cu-connectors-table">
          <thead>
            <TableHeaderRow columns={columns} />
          </thead>
          <tbody>
            {isInitialLoad ? (
              <TableStateRow
                colSpan={columns.length}
                kind="loading"
                message="Loading connectors…"
              />
            ) : filteredRows.length === 0 ? (
              <TableStateRow
                colSpan={columns.length}
                message={
                  normalizedSearch ? 'No connectors match this search.' : 'No connectors found.'
                }
              />
            ) : (
              filteredRows.map(({ key, namespace, name, item }) => {
                const spec = item.spec || {}
                const agentBindings = bindingsForConnector(name)
                const agentAccessBusy = updatingAgentAccessKey === key
                return (
                  <TableRow
                    className={onEdit ? 'cu-table__row cu-table__row--clickable' : undefined}
                    key={key}
                    onNavigate={onEdit ? () => onEdit({ namespace, name }) : undefined}
                  >
                    <td>{name}</td>
                    <td className="cu-registry-description">
                      <TruncatedText value={spec.description} />
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
                          ...(onAddToAgents
                            ? [
                                {
                                  key: 'add-agents',
                                  label: 'Add to agents',
                                  disabled: agentAccessBusy,
                                  onClick: () => openAddAgents(key),
                                },
                              ]
                            : []),
                          {
                            key: 'view-access',
                            label: 'View access details',
                            onClick: () => openAccessDetails(key),
                          },
                          ...(onRemoveFromAgents
                            ? agentBindings.map(binding => ({
                                key: `remove-agents-${binding.contextRef}`,
                                label:
                                  binding.agents.length === 1
                                    ? `Remove from ${binding.agents[0].label}`
                                    : `Remove from ${binding.agents.length} agents`,
                                disabled: agentAccessBusy,
                                onClick: () =>
                                  void onRemoveFromAgents({ name, namespace }, binding),
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
                  </TableRow>
                )
              })
            )}
          </tbody>
        </DataTable>
      </TableViewport>
      {serverKeyAddingAgents
        ? (() => {
            const row = rows.find(candidate => candidate.key === serverKeyAddingAgents)
            if (!row || !onAddToAgents) return null
            const boundAgentNames = new Set(
              bindingsForConnector(row.name).flatMap(binding =>
                binding.agents.map(agent => agent.id)
              )
            )
            const agentOptions = agentTargets
              .filter(
                target =>
                  !boundAgentNames.has(target.name) &&
                  canAssignConnectorToContext(row.item.spec, target.contextRef)
              )
              .map(target => ({
                value: target.name,
                label: target.label,
                description: target.name,
              }))
            const busy = updatingAgentAccessKey === row.key
            return (
              <div
                className="cu-modal-backdrop"
                role="presentation"
                onClick={event => {
                  if (event.target === event.currentTarget && !busy) closeAddAgents()
                }}
              >
                <div
                  className="cu-modal-panel cu-modal-panel--selection"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="add-connector-agents-title"
                  onClick={event => event.stopPropagation()}
                >
                  <div className="cu-modal-panel__head">
                    <h3 id="add-connector-agents-title" className="cu-modal-panel__title">
                      Give agents access to this connector
                    </h3>
                    <button
                      type="button"
                      className="cu-btn cu-btn--icon cu-btn--ghost"
                      onClick={closeAddAgents}
                      disabled={busy}
                      aria-label="Close"
                    >
                      <IconX width={18} height={18} />
                    </button>
                  </div>

                  <div className="cu-field">
                    <label htmlFor="connector-agent-picker">Agents</label>
                    <SelectionDropdown
                      id="connector-agent-picker"
                      inline
                      value={selectedAgentNamesToAdd}
                      onChange={setSelectedAgentNamesToAdd}
                      options={agentOptions}
                      placeholder="Select agents"
                      searchPlaceholder="Search agents..."
                      selectionLabel="Selected agents"
                      emptyLabel="No other agents available."
                      disabled={busy}
                    />
                  </div>

                  <div className="cu-modal-panel__foot">
                    <button
                      type="button"
                      className="cu-btn cu-btn--ghost cu-btn--sm"
                      onClick={closeAddAgents}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="cu-btn cu-btn--primary"
                      onClick={async () => {
                        if (selectedAgentNamesToAdd.length === 0) return
                        const selected = agentTargets.filter(target =>
                          selectedAgentNamesToAdd.includes(target.name)
                        )
                        await onAddToAgents(
                          { namespace: row.namespace, name: row.name },
                          selected.map(target => ({
                            name: target.name,
                            contextRef: target.contextRef,
                          }))
                        )
                        setSelectedAgentNamesToAdd([])
                        setServerKeyAddingAgents(null)
                      }}
                      disabled={busy || selectedAgentNamesToAdd.length === 0}
                    >
                      {selectedAgentNamesToAdd.length > 1 ? 'Add to agents' : 'Add to agent'}
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
            const linkedAgents = bindingsForConnector(row.name).flatMap(binding => binding.agents)
            const groups = [
              {
                key: 'agents',
                label: 'Agents',
                items: linkedAgents.map(item => ({ key: item.id, label: item.label })),
              },
              {
                key: 'teams',
                label: 'Teams',
                items: (access?.teams ?? []).map(item => ({ key: item.id, label: item.label })),
              },
              {
                key: 'users',
                label: 'Users',
                items: (access?.users ?? []).map(item => ({ key: item.id, label: item.label })),
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
                  ref={accessDialogRef}
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
                              <li key={item.key}>{item.label}</li>
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
                      ref={accessCloseButtonRef}
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
