'use client'

import React, { Fragment, useMemo, useState } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'
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
import { IconChevronRight, IconCopy, IconRefresh, IconX } from './icons'

const ENABLED_TOOLTIP = 'Enabled controls whether this server is available to contexts and agents.'
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

function AccessSummary({ summary }: { summary?: ConnectorAccessSummary }) {
  const groups = [
    { key: 'agents', label: 'Agents', items: summary?.agents ?? [] },
    { key: 'teams', label: 'Teams', items: summary?.teams ?? [] },
    { key: 'users', label: 'Users', items: summary?.users ?? [] },
  ]

  return (
    <>
      {groups.map(group => (
        <section
          className="cu-registry-context-access__group"
          data-kind={group.key}
          key={group.key}
        >
          <div className="cu-registry-context-access__heading">
            <h4>{group.label}</h4>
            <span>{group.items.length}</span>
          </div>
          {group.items.length > 0 ? (
            <ul className="cu-registry-context-access__list">
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

function ConnectorContexts({
  connectorName,
  namespace,
  contexts,
  busy,
  onOpenContext,
  onAdd,
  onRemove,
}: {
  connectorName: string
  namespace: string
  contexts: ConnectorContextBinding[]
  busy: boolean
  onOpenContext?: (contextName: string) => void
  onAdd?: () => void
  onRemove?: McpServerTableProps['onRemoveFromContext']
}) {
  const linkedContexts = contexts.map(context => ({ name: context.name, removable: true }))

  return (
    <section className="cu-registry-context-access__group" data-kind="contexts">
      <div className="cu-registry-context-access__heading">
        <h4>Contexts</h4>
        <span>{linkedContexts.length}</span>
      </div>
      {linkedContexts.length > 0 ? (
        <ul className="cu-registry-context-access__list cu-connector-context-access__list">
          {linkedContexts.map(context => (
            <li key={context.name}>
              <span className="cu-connector-context-access__name" title={context.name}>
                {onOpenContext ? (
                  <button
                    type="button"
                    className="cu-link"
                    onClick={() => onOpenContext(context.name)}
                  >
                    {context.name}
                  </button>
                ) : (
                  context.name
                )}
              </span>
              {context.removable && onRemove ? (
                <button
                  type="button"
                  className="cu-btn cu-btn--icon cu-btn--danger-icon cu-connector-context-access__remove"
                  disabled={busy}
                  aria-label={`Remove connector ${connectorName} from context ${context.name}`}
                  title={`Remove from ${context.name}`}
                  onClick={() => void onRemove({ namespace, name: connectorName }, context.name)}
                >
                  <IconX width={14} height={14} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="cu-muted">No contexts linked.</p>
      )}
      {onAdd ? (
        <button
          type="button"
          className="cu-btn cu-btn--sm cu-connector-context-access__add"
          disabled={busy}
          onClick={onAdd}
        >
          Add contexts
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
  contexts = [],
  onOpenContext,
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
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [serverKeyAddingContexts, setServerKeyAddingContexts] = useState<string | null>(null)
  const [selectedContextNamesToAdd, setSelectedContextNamesToAdd] = useState<string[]>([])
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
        className={`cu-link cu-link--sm cu-table__sort-link${isActive ? ' is-active' : ''}`}
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
                const assignedContexts = contextsForConnector(name)
                const contextMembershipBusy = updatingContextMembershipKey === key
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
                                  className="cu-registry-context-access cu-connector-access-grid"
                                  aria-label="Connector access"
                                >
                                  <ConnectorContexts
                                    connectorName={name}
                                    namespace={namespace}
                                    contexts={assignedContexts}
                                    busy={contextMembershipBusy}
                                    onOpenContext={onOpenContext}
                                    onAdd={onAddToContexts ? () => openAddContexts(key) : undefined}
                                    onRemove={onRemoveFromContext}
                                  />
                                  <AccessSummary summary={accessByConnectorKey?.[key]} />
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
    </div>
  )
}
