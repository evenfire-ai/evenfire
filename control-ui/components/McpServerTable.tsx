'use client'

import React, { Fragment, useMemo, useState } from 'react'
import type {
  ConnectorAccessSummary,
  ConnectorContextBinding,
  McpServerStatus,
  McpServerTableProps,
} from './McpServerTable.types'
import { SectionSearchInput } from './SectionSearchInput'
import { SelectionDropdown } from './SelectionDropdown'
import { IconCable } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconChevronRight, IconPencil, IconRefresh, IconX } from './icons'

const ENABLED_TOOLTIP = 'Enabled controls whether this server is available to contexts and agents.'

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

function StatusBadge({ status }: { status?: McpServerStatus }) {
  const conditions = status?.conditions
  const missingSecret = conditions?.find(c => c.type === 'SecretResolved' && c.status === 'False')
  const ready = conditions?.find(c => c.type === 'Ready' && c.status === 'True')
  const state = missingSecret
    ? 'error'
    : ready
      ? 'ready'
      : conditions?.length
        ? 'pending'
        : 'unknown'
  const label =
    state === 'error'
      ? 'Missing Secret'
      : state === 'ready'
        ? 'Ready'
        : state === 'pending'
          ? 'Pending'
          : 'Unknown'
  return (
    <span
      className={`cu-connector-badge cu-connector-badge--status-${state}`}
      title={missingSecret?.message}
    >
      {label}
    </span>
  )
}

function AccessSummary({ summary }: { summary?: ConnectorAccessSummary }) {
  const groups = [
    { label: 'Agent', items: summary?.agents ?? [] },
    { label: 'User', items: summary?.users ?? [] },
    { label: 'Team', items: summary?.teams ?? [] },
  ]
  const hasAccess = groups.some(group => group.items.length > 0)

  if (!hasAccess) return <span className="cu-muted">No access assigned</span>

  return (
    <div className="cu-expandable-tags">
      {groups.flatMap(group =>
        group.items.map(principal => (
          <span
            key={`${group.label}-${principal.id}`}
            className="cu-registry-tag"
            title={`${group.label}: ${principal.label}`}
          >
            {principal.label}
          </span>
        ))
      )}
    </div>
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
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [serverKeyAddingContexts, setServerKeyAddingContexts] = useState<string | null>(null)
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
    if (!normalizedSearch) return rows
    return rows.filter(({ namespace, name, item, key }) => {
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
        spec.contextRef,
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
  }, [accessByConnectorKey, normalizedSearch, rows])

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
                className="cu-btn cu-btn--secondary cu-btn--sm cu-btn--mcp-install"
                onClick={onInstallFromRegistry}
                disabled={isInitialLoad}
              >
                Install from Marketplace
              </button>
            ) : null}
            {onCreate ? (
              <button
                type="button"
                className="cu-btn cu-btn--primary cu-btn--sm"
                onClick={onCreate}
                disabled={isInitialLoad}
              >
                Create Connector
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
              <TableHeaderRow columns={CONNECTOR_COLUMNS} />
            </thead>
            <tbody>
              <SkeletonTableRows columns={CONNECTOR_COLUMNS.length} rows={5} />
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
              <TableHeaderRow columns={CONNECTOR_COLUMNS} />
            </thead>
            <tbody>
              {filteredRows.map(({ key, namespace, name, item }) => {
                const spec = item.spec || {}
                const expanded = expandedKeys.has(key)
                const contextRef = spec.contextRef || ''
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
                          {onEdit ? (
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--toolbar"
                              onClick={() => onEdit({ namespace, name })}
                              aria-label={`Edit connector ${name}`}
                              title={`Edit connector ${name}`}
                            >
                              <IconPencil width={16} height={16} />
                            </button>
                          ) : null}
                          {onDelete ? (
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--danger-icon"
                              onClick={() => void onDelete({ namespace, name })}
                              disabled={deletingKey === key}
                              aria-label={
                                deletingKey === key ? 'Deleting...' : `Remove connector ${name}`
                              }
                              title={
                                deletingKey === key ? 'Deleting...' : `Remove connector ${name}`
                              }
                            >
                              <IconX width={16} height={16} />
                            </button>
                          ) : null}
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
                              <div className="cu-expandable-field">
                                <span className="cu-expandable-field__label">Image</span>
                                <span className="cu-expandable-field__code">
                                  {spec.image || '—'}
                                </span>
                              </div>
                              <div className="cu-expandable-field">
                                <span className="cu-expandable-field__label">Transport</span>
                                <TransportBadge type={spec.transport?.type} />
                              </div>
                              <div className="cu-expandable-field">
                                <span className="cu-expandable-field__label">Default context</span>
                                {contextRef && onOpenContext ? (
                                  <button
                                    type="button"
                                    className="cu-link"
                                    onClick={() => onOpenContext(contextRef)}
                                  >
                                    {contextRef}
                                  </button>
                                ) : (
                                  <span className="cu-muted">{contextRef || '—'}</span>
                                )}
                              </div>
                              {onAddToContexts && onRemoveFromContext ? (
                                <div className="cu-expandable-field cu-expandable-field--wide">
                                  <span className="cu-expandable-field__label">
                                    Available in contexts
                                  </span>
                                  <div className="cu-context-connector-bindings">
                                    {assignedContexts.length === 0 ? (
                                      <span className="cu-muted">No contexts assigned</span>
                                    ) : (
                                      <div className="cu-expandable-tags">
                                        {assignedContexts.map(context => (
                                          <span
                                            className="cu-registry-tag cu-context-connector-bindings__tag"
                                            key={context.name}
                                          >
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
                                            <button
                                              type="button"
                                              className="cu-btn cu-btn--icon cu-btn--danger-icon"
                                              disabled={contextMembershipBusy}
                                              aria-label={`Remove connector ${name} from context ${context.name}`}
                                              title={`Remove from ${context.name}`}
                                              onClick={() =>
                                                void onRemoveFromContext(
                                                  { namespace, name },
                                                  context.name
                                                )
                                              }
                                            >
                                              <IconX width={14} height={14} />
                                            </button>
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                    <button
                                      type="button"
                                      className="cu-btn cu-btn--secondary cu-btn--sm"
                                      disabled={contextMembershipBusy}
                                      onClick={() => openAddContexts(key)}
                                    >
                                      Add contexts
                                    </button>
                                  </div>
                                </div>
                              ) : null}
                              <div className="cu-expandable-field cu-expandable-field--wide">
                                <span className="cu-expandable-field__label">Access</span>
                                <AccessSummary summary={accessByConnectorKey?.[key]} />
                              </div>
                              <div className="cu-expandable-field">
                                <span className="cu-expandable-field__label">Managed</span>
                                <BoolBadge value={spec.managed} trueLabel="Yes" falseLabel="No" />
                              </div>
                              <div className="cu-expandable-field cu-expandable-field--wide">
                                <span className="cu-expandable-field__label">URL</span>
                                {spec.transport?.url ? (
                                  <a
                                    className="cu-link cu-expandable-field__code"
                                    href={spec.transport.url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {spec.transport.url}
                                  </a>
                                ) : (
                                  <span className="cu-muted">—</span>
                                )}
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
                style={{
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(0, 0, 0, 0.6)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 1000,
                  padding: '1rem',
                }}
                role="presentation"
                onClick={event => {
                  if (event.target === event.currentTarget && !busy) closeAddContexts()
                }}
              >
                <div
                  className="cu-modal-panel cu-modal-panel--selection"
                  role="dialog"
                  aria-labelledby="add-connector-context-title"
                  onClick={event => event.stopPropagation()}
                >
                  <div className="cu-modal-panel__head">
                    <strong
                      id="add-connector-context-title"
                      style={{ fontSize: '1rem', lineHeight: 1.35 }}
                    >
                      Add connector to contexts
                    </strong>
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
