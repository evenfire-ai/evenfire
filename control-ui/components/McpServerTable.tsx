'use client'

import React, { Fragment, useMemo, useState } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'
import type {
  ConnectorAccessSummary,
  ConnectorAgentBinding,
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
import { IconChevronRight, IconCopy, IconRefresh, IconX } from './icons'

const ENABLED_TOOLTIP = 'Enabled controls whether this server is available to agents.'
type ConnectorSortKey = 'name' | 'enabled' | 'status'
type SortDirection = 'asc' | 'desc'

const CONNECTOR_COLUMNS: TableHeaderColumn[] = [
  { key: 'expand', ariaLabel: 'Expand connector' },
  { key: 'name', label: 'Name' },
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

function middleEllipsis(value: string, maxLength = 26): string {
  if (value.length <= maxLength) return value
  const visibleLength = maxLength - 3
  const startLength = Math.ceil(visibleLength * 0.56)
  return `${value.slice(0, startLength)}...${value.slice(-(visibleLength - startLength))}`
}

function AccessReadGroups({ summary }: { summary?: ConnectorAccessSummary }) {
  const groups = [
    { key: 'teams', label: 'Teams', items: summary?.teams ?? [] },
    { key: 'users', label: 'Users', items: summary?.users ?? [] },
  ]

  return (
    <>
      {groups.map(group => (
        <section className="cu-entity-access__group" data-kind={group.key} key={group.key}>
          <div className="cu-entity-access__heading">
            <h4>{group.label}</h4>
            <span>{group.items.length}</span>
          </div>
          {group.items.length > 0 ? (
            <ul className="cu-entity-access__list">
              {group.items.map(principal => (
                <li key={principal.id} title={principal.label}>
                  <span>{principal.label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cu-muted">No {group.label.toLowerCase()} have access.</p>
          )}
        </section>
      ))}
    </>
  )
}

function ConnectorAgentsGroup({
  connectorName,
  namespace,
  bindings,
  busy,
  onAdd,
  onRemove,
}: {
  connectorName: string
  namespace: string
  bindings: ConnectorAgentBinding[]
  busy: boolean
  onAdd?: () => void
  onRemove?: McpServerTableProps['onRemoveFromAgents']
}) {
  const agentCount = bindings.reduce((total, binding) => total + binding.agents.length, 0)

  return (
    <section className="cu-entity-access__group" data-kind="agents">
      <div className="cu-entity-access__heading">
        <h4>Agents</h4>
        <span>{agentCount}</span>
      </div>
      {agentCount > 0 ? (
        <ul className="cu-entity-access__list cu-connector-agent-access__list">
          {bindings.flatMap(binding =>
            binding.agents.map(agent => (
              <li key={`${binding.contextRef}/${agent.id}`}>
                <span className="cu-connector-agent-access__name" title={agent.label}>
                  {agent.label}
                </span>
                {onRemove ? (
                  <button
                    type="button"
                    className="cu-btn cu-btn--icon cu-btn--danger-icon cu-connector-agent-access__remove"
                    disabled={busy}
                    aria-label={
                      binding.agents.length > 1
                        ? `Remove connector ${connectorName} from agents ${binding.agents.map(a => a.label).join(', ')}`
                        : `Remove connector ${connectorName} from agent ${agent.label}`
                    }
                    title={
                      binding.agents.length > 1
                        ? `Remove from ${binding.agents.map(a => a.label).join(', ')}`
                        : `Remove from ${agent.label}`
                    }
                    onClick={() => void onRemove({ namespace, name: connectorName }, binding)}
                  >
                    <IconX width={14} height={14} />
                  </button>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : (
        <p className="cu-muted">No agents have access yet.</p>
      )}
      {onAdd ? (
        <button
          type="button"
          className="cu-btn cu-btn--sm cu-connector-agent-access__add"
          disabled={busy}
          onClick={onAdd}
        >
          Add agents
        </button>
      ) : null}
    </section>
  )
}

function CopyableValue({
  copyKey,
  copyLabel,
  value,
  copied,
  onCopy,
  href,
}: {
  copyKey: string
  copyLabel: string
  value: string
  copied: boolean
  onCopy: (copyKey: string, value: string) => void
  href?: string
}) {
  if (!value) return <span className="cu-muted">—</span>

  return (
    <span className="cu-connector-copyable-value">
      {href ? (
        <a
          className="cu-link cu-expandable-field__code"
          href={href}
          target="_blank"
          rel="noreferrer"
          title={value}
        >
          {middleEllipsis(value)}
        </a>
      ) : (
        <span className="cu-expandable-field__code" title={value}>
          {middleEllipsis(value)}
        </span>
      )}
      <button
        type="button"
        className="cu-btn cu-btn--icon cu-btn--ghost cu-connector-copyable-value__button"
        onClick={() => onCopy(copyKey, value)}
        aria-label={copied ? `${copyLabel} copied` : `Copy ${copyLabel}`}
        title={copied ? 'Copied' : `Copy ${copyLabel}`}
      >
        <IconCopy width={14} height={14} />
      </button>
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
  const [sortKey, setSortKey] = useState<ConnectorSortKey | null>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [serverKeyAddingAgents, setServerKeyAddingAgents] = useState<string | null>(null)
  const [selectedAgentNamesToAdd, setSelectedAgentNamesToAdd] = useState<string[]>([])
  const [copiedValueKey, setCopiedValueKey] = useState<string | null>(null)
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
      const comparison =
        sortKey === 'name'
          ? left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
          : sortKey === 'enabled'
            ? Number((left.item.spec?.enabled ?? true) === true) -
              Number((right.item.spec?.enabled ?? true) === true)
            : getStatusLabel(left.item.status).localeCompare(getStatusLabel(right.item.status))
      return comparison * direction
    })
  }, [accessByConnectorKey, normalizedSearch, rows, sortDirection, sortKey])

  React.useEffect(() => {
    if (!onRefresh) return
    const id = setInterval(() => void onRefresh(), 10_000)
    return () => clearInterval(id)
  }, [onRefresh])

  function toggleExpanded(key: string) {
    setExpandedKeys(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

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
    if (column.key === 'name' || column.key === 'enabled' || column.key === 'status') {
      return { ...column, label: renderSortHeader(column.key, column.label as string) }
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

  async function copyValue(copyKey: string, value: string) {
    if (await copyTextToClipboard(value)) setCopiedValueKey(copyKey)
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
        <div className="cu-table-wrap cu-connectors-table-wrap">
          <table className="cu-table cu-table--header-band cu-expandable-table cu-connectors-table">
            <thead>
              <TableHeaderRow columns={columns} />
            </thead>
            <tbody>
              <SkeletonTableRows columns={columns.length} rows={5} />
            </tbody>
          </table>
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="cu-empty">
          {normalizedSearch ? 'No connectors match this search.' : 'No connectors found.'}
        </div>
      ) : (
        <div className="cu-table-wrap cu-connectors-table-wrap">
          <table className="cu-table cu-table--header-band cu-expandable-table cu-connectors-table">
            <thead>
              <TableHeaderRow columns={columns} />
            </thead>
            <tbody>
              {filteredRows.map(({ key, namespace, name, item }) => {
                const spec = item.spec || {}
                const expanded = expandedKeys.has(key)
                const agentBindings = bindingsForConnector(name)
                const agentAccessBusy = updatingAgentAccessKey === key
                return (
                  <Fragment key={key}>
                    <tr
                      className="cu-table__row cu-table__row--clickable cu-expandable-row"
                      role="button"
                      onClick={() => toggleExpanded(key)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          toggleExpanded(key)
                        }
                      }}
                      tabIndex={0}
                      aria-expanded={expanded}
                      aria-controls={`connector-details-${key}`}
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} connector ${name}`}
                    >
                      <td className="cu-expandable-row__chevron" aria-hidden="true">
                        <IconChevronRight
                          className={expanded ? 'is-expanded' : undefined}
                          width={18}
                          height={18}
                        />
                      </td>
                      <td>
                        <span className="cu-expandable-row__name">{name}</span>
                        <div
                          className="cu-registry-description"
                          title={spec.description || 'No description provided.'}
                        >
                          {spec.description || 'No description provided.'}
                        </div>
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
                        <div className="cu-table-actions">
                          <RowActionsMenu
                            ariaLabel={`Actions for connector ${name}`}
                            horizontalTrigger
                            actions={[
                              ...(onEdit
                                ? [
                                    {
                                      key: 'edit',
                                      label: 'Edit',
                                      onClick: () => onEdit({ namespace, name }),
                                    },
                                  ]
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
                        </div>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr id={`connector-details-${key}`} className="cu-expandable-detail-row">
                        <td colSpan={CONNECTOR_COLUMNS.length}>
                          <div className="cu-expandable-detail cu-connector-detail">
                            <div className="cu-expandable-detail__fields">
                              <p className="cu-expandable-detail__description">
                                {spec.description || 'No description provided.'}
                              </p>
                              <div className="cu-connector-detail__metadata">
                                <div className="cu-expandable-field">
                                  <span className="cu-expandable-field__label">URL</span>
                                  <CopyableValue
                                    copyKey={`${key}/url`}
                                    copyLabel="URL"
                                    value={spec.transport?.url || ''}
                                    href={spec.transport?.url}
                                    copied={copiedValueKey === `${key}/url`}
                                    onCopy={(copyKey, value) => void copyValue(copyKey, value)}
                                  />
                                </div>
                                <div className="cu-expandable-field">
                                  <span className="cu-expandable-field__label">Image</span>
                                  <CopyableValue
                                    copyKey={`${key}/image`}
                                    copyLabel="image URL"
                                    value={spec.image || ''}
                                    copied={copiedValueKey === `${key}/image`}
                                    onCopy={(copyKey, value) => void copyValue(copyKey, value)}
                                  />
                                </div>
                                <div className="cu-expandable-field">
                                  <span className="cu-expandable-field__label">Transport</span>
                                  <TransportBadge type={spec.transport?.type} />
                                </div>
                                <div className="cu-expandable-field">
                                  <span className="cu-expandable-field__label">Managed</span>
                                  <BoolBadge value={spec.managed} trueLabel="Yes" falseLabel="No" />
                                </div>
                              </div>
                              <div className="cu-expandable-field cu-expandable-field--wide cu-connector-access-field">
                                <span className="cu-expandable-field__label">Access</span>
                                <section
                                  className="cu-entity-access cu-connector-access-grid"
                                  aria-label="Connector access"
                                >
                                  <ConnectorAgentsGroup
                                    connectorName={name}
                                    namespace={namespace}
                                    bindings={agentBindings}
                                    busy={agentAccessBusy}
                                    onAdd={onAddToAgents ? () => openAddAgents(key) : undefined}
                                    onRemove={onRemoveFromAgents}
                                  />
                                  <AccessReadGroups summary={accessByConnectorKey?.[key]} />
                                </section>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
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
              .filter(target => !boundAgentNames.has(target.name))
              .map(target => ({
                value: target.name,
                label: target.label,
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
    </div>
  )
}
