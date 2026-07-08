'use client'

import React, { useMemo, useState } from 'react'
import type { ConnectorAccessSummary } from './McpServerTable.types'
import { SectionSearchInput } from './SectionSearchInput'
import { IconCable } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconPencil, IconRefresh, IconX } from './icons'

type McpServerSpec = {
  image?: string
  contextRef?: string
  description?: string
  enabled?: boolean
  managed?: boolean
  transport?: {
    type?: 'sse' | 'streamableHttp' | 'stdio'
    url?: string
    port?: number
  }
  auth?: {
    type?: 'none' | 'bearer' | 'basic' | 'apiKey'
  }
}

type McpServerCondition = {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime?: string
}

type McpServerStatus = {
  conditions?: McpServerCondition[]
  resolvedEgressIPs?: unknown
}

type McpServerItem = {
  metadata?: { name?: string; namespace?: string }
  spec?: McpServerSpec
  status?: McpServerStatus
}

type ServerRef = { name: string; namespace: string }

const ENABLED_TOOLTIP = 'Enabled controls whether this server is available to contexts and agents.'

const MANAGED_TOOLTIP =
  'Managed means Clerum reconciles this server lifecycle. Disabled means it is externally managed.'

const MCP_SERVER_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'image', label: 'Image', width: '16%' },
  { key: 'transport', label: 'Transport', width: '10%' },
  { key: 'context', label: 'Context', width: '12%' },
  {
    key: 'access',
    label: 'Access',
    width: '10%',
    title: 'Agents, users, and teams with access through this connector context.',
  },
  { key: 'enabled', label: 'Enabled', width: '8%', title: ENABLED_TOOLTIP },
  { key: 'managed', label: 'Managed', width: '8%', title: MANAGED_TOOLTIP },
  { key: 'status', label: 'Status', width: '8%' },
  { key: 'url', label: 'URL', width: '12%' },
]

const TRANSPORT_BADGE_STYLES: Record<
  string,
  { background: string; color: string; border: string }
> = {
  sse: {
    background: 'rgba(var(--cu-edge-rgb), 0.2)',
    color: 'var(--cu-text)',
    border: '1px solid rgba(var(--cu-edge-rgb), 0.36)',
  },
  streamableHttp: {
    background: 'rgba(var(--cu-success-rgb), 0.14)',
    color: 'var(--cu-text)',
    border: '1px solid rgba(var(--cu-success-rgb), 0.34)',
  },
  stdio: {
    background: 'rgba(var(--cu-edge-rgb), 0.2)',
    color: 'var(--cu-text)',
    border: '1px solid rgba(var(--cu-edge-rgb), 0.36)',
  },
}

function TransportBadge({ type }: { type?: string }) {
  if (!type) return <span style={{ color: 'var(--cu-text-muted)' }}>-</span>
  const badgeStyle = TRANSPORT_BADGE_STYLES[type] ?? {
    background: 'rgba(var(--cu-edge-rgb), 0.2)',
    color: 'var(--cu-text)',
    border: '1px solid rgba(var(--cu-edge-rgb), 0.35)',
  }
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        background: badgeStyle.background,
        color: badgeStyle.color,
        border: badgeStyle.border,
      }}
    >
      {type}
    </span>
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
    <span
      style={{
        display: 'inline-block',
        padding: '2px 6px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 500,
        background: isTrue
          ? 'rgba(var(--cu-success-rgb), 0.16)'
          : 'rgba(var(--cu-danger-rgb), 0.16)',
        color: isTrue ? 'var(--cu-success)' : 'var(--cu-danger)',
        border: isTrue
          ? '1px solid rgba(var(--cu-success-rgb), 0.36)'
          : '1px solid rgba(var(--cu-danger-rgb), 0.36)',
      }}
    >
      {isTrue ? trueLabel : falseLabel}
    </span>
  )
}

function StatusBadge({ status }: { status?: McpServerStatus }) {
  const conditions = status?.conditions
  let label = 'Unknown'
  let background = 'rgba(148,163,184,0.15)'
  let color = '#94a3b8'
  let tooltip: string | undefined

  const missingSecret = conditions?.find(c => c.type === 'SecretResolved' && c.status === 'False')
  const ready = conditions?.find(c => c.type === 'Ready' && c.status === 'True')

  if (missingSecret) {
    label = 'Missing Secret'
    background = 'rgba(239,68,68,0.15)'
    color = '#ef4444'
    tooltip = missingSecret.message
  } else if (ready) {
    label = 'Ready'
    background = 'rgba(34,197,94,0.15)'
    color = '#22c55e'
  } else if (conditions && conditions.length > 0) {
    label = 'Pending'
    background = 'rgba(234,179,8,0.15)'
    color = '#eab308'
  }

  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        background,
        color,
      }}
    >
      {label}
    </span>
  )
}

function agentInitial(label: string): string {
  const trimmed = label.trim()
  return trimmed ? trimmed[0].toUpperCase() : '?'
}

function AccessSummaryCell({ summary }: { summary?: ConnectorAccessSummary }) {
  const agents = summary?.agents ?? []
  const users = summary?.users ?? []
  const teams = summary?.teams ?? []
  const visibleAgents = agents.slice(0, 5)
  const hiddenAgentCount = Math.max(agents.length - visibleAgents.length, 0)
  const tooltipParts = [
    agents.length ? `Agents: ${agents.map(agent => agent.label).join(', ')}` : 'Agents: none',
    users.length ? `Users: ${users.map(user => user.label).join(', ')}` : 'Users: none',
    teams.length ? `Teams: ${teams.map(team => team.label).join(', ')}` : 'Teams: none',
  ]
  const tooltip = tooltipParts.join('\n')

  if (agents.length === 0) {
    return (
      <span className="cu-connector-access-empty" data-tooltip={tooltip}>
        No agents
      </span>
    )
  }

  return (
    <span
      className="cu-connector-access"
      data-tooltip={tooltip}
      aria-label={`${agents.length} agents with access`}
    >
      <span className="cu-connector-access__avatars" aria-hidden="true">
        {visibleAgents.map(agent => (
          <span key={agent.id} className="cu-connector-access__avatar">
            {agentInitial(agent.label)}
          </span>
        ))}
        {hiddenAgentCount > 0 ? (
          <span className="cu-connector-access__more">+{hiddenAgentCount}</span>
        ) : null}
      </span>
    </span>
  )
}

export function McpServerTable({
  items,
  accessByConnectorKey,
  onOpenContext,
  onDelete,
  onEdit,
  deletingKey,
  onRefresh,
  onCreate,
  onInstallFromRegistry,
  detailContent,
  refreshing,
  loading,
}: {
  items: McpServerItem[]
  accessByConnectorKey?: Record<string, ConnectorAccessSummary>
  onOpenContext?: (contextName: string) => void
  onDelete?: (server: ServerRef) => Promise<void>
  onEdit?: (server: ServerRef) => void
  deletingKey?: string | null
  onRefresh?: () => void
  onCreate?: () => void
  onInstallFromRegistry?: () => void
  detailContent?: React.ReactNode
  refreshing?: boolean
  loading?: boolean
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const rows = useMemo(
    () =>
      items.map(i => {
        const namespace = i.metadata?.namespace || 'default'
        const name = i.metadata?.name || 'unknown'
        const key = `${namespace}/${name}`
        return { key, namespace, name, item: i }
      }),
    [items]
  )
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const filteredRows = useMemo(() => {
    if (!normalizedSearch) return rows
    return rows.filter(({ namespace, name, item }) => {
      const spec = item.spec || {}
      const key = `${namespace}/${name}`
      const access = accessByConnectorKey?.[key]
      const accessText = [
        ...(access?.agents ?? []).flatMap(agent => [agent.id, agent.label]),
        ...(access?.users ?? []).flatMap(user => [user.id, user.label]),
        ...(access?.teams ?? []).flatMap(team => [team.id, team.label]),
      ].join(' ')
      const conditionText = (item.status?.conditions || [])
        .map(c => `${c.type} ${c.status} ${c.reason ?? ''} ${c.message ?? ''}`)
        .join(' ')
      return [
        namespace,
        name,
        spec.image || '',
        spec.contextRef || '',
        spec.description || '',
        spec.transport?.type || '',
        spec.transport?.url || '',
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

  const isInitialLoad = loading && items.length === 0
  const hasActions = Boolean(onDelete || onEdit)
  const totalColumns = 9 + (hasActions ? 1 : 0)
  const tableColumns: TableHeaderColumn[] = hasActions
    ? [
        ...MCP_SERVER_COLUMNS,
        { key: 'actions', width: '5rem', align: 'right', ariaLabel: 'Actions' },
      ]
    : MCP_SERVER_COLUMNS

  return (
    <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
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
            {onRefresh && (
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
            )}
            {onInstallFromRegistry && (
              <button
                type="button"
                className="cu-btn cu-btn--secondary cu-btn--sm cu-btn--mcp-install"
                onClick={onInstallFromRegistry}
                disabled={isInitialLoad}
              >
                Install from Marketplace
              </button>
            )}
            {onCreate && (
              <button
                type="button"
                className="cu-btn cu-btn--primary cu-btn--sm"
                onClick={onCreate}
                disabled={isInitialLoad}
              >
                Create Connector
              </button>
            )}
          </>
        }
      />
      {detailContent ? <div className="cu-card__body">{detailContent}</div> : null}
      {isInitialLoad ? (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={tableColumns} />
            </thead>
            <tbody>
              <SkeletonTableRows columns={totalColumns} rows={5} />
            </tbody>
          </table>
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="cu-empty">
          {normalizedSearch ? 'No connectors match this search.' : 'No connectors found.'}
        </div>
      ) : (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={tableColumns} />
            </thead>
            <tbody>
              {filteredRows.map(({ key, namespace, name, item }) => {
                const spec = item.spec || {}
                const transportType = spec.transport?.type
                const transportUrl = spec.transport?.url || '-'
                const contextRef = spec.contextRef || ''
                const contextClickable = Boolean(contextRef && onOpenContext)
                const image = spec.image || '-'
                // Shorten long image names for display
                const imageShort = image.length > 40 ? '...' + image.slice(-37) : image

                return (
                  <tr key={key}>
                    <td>
                      <span style={{ fontWeight: 500 }}>{name}</span>
                      {spec.description ? (
                        <span
                          style={{
                            display: 'block',
                            color: 'var(--cu-text-muted)',
                            fontSize: '0.75rem',
                            lineHeight: 1.3,
                            marginTop: 2,
                            maxWidth: '16rem',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={spec.description}
                        >
                          {spec.description}
                        </span>
                      ) : null}
                    </td>
                    <td
                      style={{
                        color: 'var(--cu-text-soft)',
                        fontSize: '0.8125rem',
                        fontFamily: 'monospace',
                        wordBreak: 'break-all',
                      }}
                      title={image}
                    >
                      {imageShort}
                    </td>
                    <td>
                      <TransportBadge type={transportType} />
                    </td>
                    <td>
                      {contextClickable ? (
                        <button
                          type="button"
                          className="cu-link"
                          onClick={() => onOpenContext!(contextRef)}
                        >
                          {contextRef}
                        </button>
                      ) : (
                        <span style={{ color: contextRef ? undefined : 'var(--cu-text-muted)' }}>
                          {contextRef || '-'}
                        </span>
                      )}
                    </td>
                    <td>
                      <AccessSummaryCell summary={accessByConnectorKey?.[key]} />
                    </td>
                    <td>
                      <BoolBadge value={spec.enabled} trueLabel="Yes" falseLabel="No" />
                    </td>
                    <td>
                      <BoolBadge value={spec.managed} trueLabel="Yes" falseLabel="No" />
                    </td>
                    <td>
                      <StatusBadge status={item.status} />
                    </td>
                    <td
                      style={{
                        color: 'var(--cu-text-soft)',
                        fontSize: '0.75rem',
                        fontFamily: 'monospace',
                        wordBreak: 'break-all',
                      }}
                      title={transportUrl !== '-' ? transportUrl : undefined}
                    >
                      {transportUrl}
                    </td>
                    {hasActions && (
                      <td className="cu-table__cell-actions">
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
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
