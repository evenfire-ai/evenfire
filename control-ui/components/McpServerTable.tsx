'use client'

import React, { useMemo, useState } from 'react'
import {
  DataTable,
  TableRow,
  TableStateRow,
  TableViewport,
  TruncatedText,
} from '@clerum/frontend-components'
import { connectorAuthenticationLabel } from '@lib/connectorAuthentication'
import { ConnectorAgentAccessDialog } from './ConnectorAgentAccessDialog'
import type {
  ConnectorAgentBinding,
  McpServerStatus,
  McpServerTableProps,
} from './McpServerTable.types'
import { RowActionsMenu } from './RowActionsMenu'
import { SectionSearchInput } from './SectionSearchInput'
import { IconCable } from './Sidebar/icons'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconChevronRight, IconRefresh } from './icons'
import { Button } from './ui'

const ENABLED_TOOLTIP = 'Enabled controls whether this server is available to agents.'
type ConnectorSortKey = 'name' | 'description' | 'authentication' | 'managed' | 'enabled' | 'status'
type SortDirection = 'asc' | 'desc'

const CONNECTOR_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name', width: '24%' },
  { key: 'description', label: 'Description' },
  { key: 'authentication', label: 'Authentication', width: '10rem' },
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

function AuthenticationBadge({ authType }: { authType: unknown }) {
  return <span className="cu-connector-badge">{connectorAuthenticationLabel(authType)}</span>
}

export function McpServerTable({
  items,
  agentBindingsByConnectorName = {},
  agentTargets = [],
  onAddToAgents,
  updatingAgentAccessKey,
  onDelete,
  onOpen,
  deletingKey,
  onRefresh,
  onCreate,
  onAddRemote,
  onInstallFromRegistry,
  detailContent,
  refreshing,
  loading,
}: McpServerTableProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [sortKey, setSortKey] = useState<ConnectorSortKey>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [serverKeyAddingAgents, setServerKeyAddingAgents] = useState<string | null>(null)
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
      : rows.filter(({ namespace, name, item }) => {
          const spec = item.spec || {}
          const accessText = (agentBindingsByConnectorName[name] ?? [])
            .flatMap(binding => binding.agents)
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
            spec.auth?.type,
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
            : sortKey === 'authentication'
              ? connectorAuthenticationLabel(left.item.spec?.auth?.type).localeCompare(
                  connectorAuthenticationLabel(right.item.spec?.auth?.type)
                )
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
  }, [agentBindingsByConnectorName, normalizedSearch, rows, sortDirection, sortKey])

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
    setServerKeyAddingAgents(key)
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
          onCreate || onAddRemote ? (
            <RowActionsMenu
              ariaLabel="Connector actions"
              horizontalTrigger
              actions={[
                ...(onCreate
                  ? [
                      {
                        key: 'create-connector',
                        label: 'Create connector',
                        onClick: onCreate,
                        disabled: isInitialLoad,
                      },
                    ]
                  : []),
                ...(onAddRemote
                  ? [
                      {
                        key: 'add-remote-server',
                        label: 'Add remote server',
                        onClick: onAddRemote,
                        disabled: isInitialLoad,
                      },
                    ]
                  : []),
              ]}
            />
          ) : undefined
        }
        subtitle="Browse connector deployments and agent access."
        actionsClassName="cu-table-panel__actions--mcp"
        primaryAction={
          onInstallFromRegistry ? (
            <Button
              size="sm"
              variant="primary"
              onClick={onInstallFromRegistry}
              disabled={isInitialLoad}
            >
              <IconChevronRight width={16} height={16} />
              Marketplace
            </Button>
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
                const agentAccessBusy = updatingAgentAccessKey === key
                return (
                  <TableRow
                    className={onOpen ? 'cu-table__row cu-table__row--clickable' : undefined}
                    key={key}
                    onNavigate={onOpen ? () => onOpen({ namespace, name }) : undefined}
                  >
                    <td>{name}</td>
                    <td className="cu-registry-description">
                      <TruncatedText value={spec.description} />
                    </td>
                    <td>
                      <AuthenticationBadge authType={spec.auth?.type} />
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
                          ...(onOpen
                            ? [
                                {
                                  key: 'view',
                                  label: 'View details',
                                  onClick: () => onOpen({ namespace, name }),
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
            return (
              <ConnectorAgentAccessDialog
                key={serverKeyAddingAgents}
                server={{ namespace: row.namespace, name: row.name }}
                connectorSpec={row.item.spec}
                agentTargets={agentTargets}
                boundAgentNames={bindingsForConnector(row.name).flatMap(binding =>
                  binding.agents.map(agent => agent.id)
                )}
                pending={updatingAgentAccessKey === row.key}
                onAdd={onAddToAgents}
                onDismiss={() => setServerKeyAddingAgents(null)}
              />
            )
          })()
        : null}
    </div>
  )
}
