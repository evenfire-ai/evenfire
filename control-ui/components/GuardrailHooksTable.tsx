'use client'

import React, { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DataTable, TableStateRow, TableViewport, useTableSort } from '@clerum/frontend-components'
import { RowActionsMenu } from '@components/RowActionsMenu'
import { CONTROL_ROUTES } from '@constants/routes'
import type { LlmHookStatus } from '../lib/api'
import type {
  GuardrailHooksTableProps,
  LlmHookSpecView,
  LlmHookTarget,
} from './GuardrailHooksTable.types'
import { SectionSearchInput } from './SectionSearchInput'
import { IconShield } from './Sidebar/icons'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh } from './icons'

const HOOK_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'lifecycle', label: 'Lifecycle' },
  { key: 'order', label: 'Order' },
  { key: 'failMode', label: 'Fail mode' },
  { key: 'status', label: 'Status' },
  { key: 'actions', align: 'right', ariaLabel: 'Actions' },
]

function StatusBadge({ status }: { status?: LlmHookStatus }) {
  const conditions = status?.conditions
  const ready = conditions?.find(c => c.type === 'Ready' && c.status === 'True')
  const failing = conditions?.find(c => c.status === 'False')
  const state = ready ? 'ready' : failing ? 'error' : conditions?.length ? 'pending' : 'unknown'
  const label =
    state === 'ready'
      ? 'Ready'
      : state === 'error'
        ? 'Error'
        : state === 'pending'
          ? 'Pending'
          : 'Unknown'
  return (
    <span
      className={`cu-connector-badge cu-connector-badge--status-${state}`}
      title={failing?.message}
    >
      {label}
    </span>
  )
}

function FailModeBadge({ failMode }: { failMode?: 'open' | 'closed' }) {
  if (!failMode) return <span className="cu-muted">—</span>
  return (
    <span
      className={`cu-connector-badge cu-connector-badge--${failMode === 'open' ? 'yes' : 'no'}`}
    >
      {failMode}
    </span>
  )
}

function describeTarget(target?: LlmHookTarget): string {
  if (target?.image?.ref) return target.image.ref
  if (target?.service?.name) {
    const namespace = target.service.namespace ? `${target.service.namespace}/` : ''
    const port = target.service.port ? `:${target.service.port}` : ''
    return `${namespace}${target.service.name}${port}`
  }
  if (target?.remote?.baseUrl) return target.remote.baseUrl
  return ''
}

export function GuardrailHooksTable({
  items,
  onInstall,
  onUninstall,
  uninstallingKey,
  onRefresh,
  refreshing,
  loading,
}: GuardrailHooksTableProps) {
  const router = useRouter()
  const [searchQuery, setSearchQuery] = useState('')

  const rows = useMemo(
    () =>
      items.map(item => {
        const name = item.metadata?.name || 'unknown'
        return { key: name, name, item }
      }),
    [items]
  )
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const filteredRows = useMemo(() => {
    if (!normalizedSearch) return rows
    return rows.filter(({ name, item }) => {
      const spec = (item.spec || {}) as LlmHookSpecView
      const conditionText = (item.status?.conditions || [])
        .map(condition =>
          [condition.type, condition.status, condition.reason, condition.message].join(' ')
        )
        .join(' ')
      return [
        name,
        (spec.lifecyclePoints || []).join(' '),
        spec.failMode,
        describeTarget(spec.target),
        (spec.capabilities || []).join(' '),
        conditionText,
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    })
  }, [normalizedSearch, rows])
  const hookSort = useTableSort<
    (typeof filteredRows)[number],
    'name' | 'lifecycle' | 'order' | 'failMode' | 'status'
  >({
    rows: filteredRows,
    defaultKey: 'name',
    identity: row => row.key,
    accessors: {
      name: row => row.name,
      lifecycle: row => ((row.item.spec || {}) as LlmHookSpecView).lifecyclePoints?.join(', '),
      order: row => ((row.item.spec || {}) as LlmHookSpecView).order,
      failMode: row => ((row.item.spec || {}) as LlmHookSpecView).failMode,
      status: row =>
        row.item.status?.conditions?.find(condition => condition.type === 'Ready')?.status,
    },
  })
  const columns = HOOK_COLUMNS.map(column =>
    column.key === 'actions'
      ? column
      : {
          ...column,
          activeDirection: hookSort.key === column.key ? hookSort.direction : null,
          onSort: () =>
            hookSort.sortBy(column.key as 'name' | 'lifecycle' | 'order' | 'failMode' | 'status'),
        }
  )

  React.useEffect(() => {
    if (!onRefresh) return
    const id = setInterval(() => void onRefresh(), 10_000)
    return () => clearInterval(id)
  }, [onRefresh])

  function openDetail(name: string) {
    router.push(CONTROL_ROUTES.guardrails.detail(name))
  }

  const isInitialLoad = loading && items.length === 0

  return (
    <div className="cu-card cu-card--viewport-fill cu-section-card">
      <TablePanelHeader
        title={
          <>
            <IconShield />
            {isInitialLoad
              ? 'Installed Guardrails'
              : `Installed Guardrails (${filteredRows.length})`}
          </>
        }
        subtitle="Installed LLM guardrail hooks across the cluster."
        primaryAction={
          onInstall ? (
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={onInstall}
              disabled={isInitialLoad}
            >
              Install Guardrail
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
              aria-label={refreshing ? 'Refreshing...' : 'Reload installed guardrails'}
            >
              <IconRefresh className={refreshing ? 'cu-spin' : undefined} width={18} height={18} />
            </button>
          ) : undefined
        }
        search={
          <SectionSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search guardrails"
            ariaLabel="Search installed guardrails"
            disabled={isInitialLoad}
          />
        }
      />
      <TableViewport className="cu-table-wrap cu-guardrails-table-wrap">
        <DataTable className="eft-table cu-table cu-table--header-band cu-guardrails-table">
          <thead>
            <TableHeaderRow columns={columns} />
          </thead>
          <tbody>
            {isInitialLoad ? (
              <TableStateRow
                colSpan={columns.length}
                kind="loading"
                message="Loading guardrails…"
              />
            ) : filteredRows.length === 0 ? (
              <TableStateRow
                colSpan={columns.length}
                message={
                  normalizedSearch ? 'No guardrails match this search.' : 'No guardrails installed.'
                }
              />
            ) : (
              hookSort.sortedRows.map(({ key, name, item }) => {
                const spec = (item.spec || {}) as LlmHookSpecView
                const lifecycle = (spec.lifecyclePoints || []).join(', ')
                return (
                  <tr
                    key={key}
                    className="cu-table__row cu-table__row--clickable"
                    role="button"
                    onClick={() => openDetail(name)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openDetail(name)
                      }
                    }}
                    tabIndex={0}
                    aria-label={`View guardrail ${name}`}
                  >
                    <td>
                      <span className="cu-table__cell-name">{name}</span>
                    </td>
                    <td>{lifecycle ? lifecycle : <span className="cu-muted">—</span>}</td>
                    <td>
                      {typeof spec.order === 'number' ? (
                        spec.order
                      ) : (
                        <span className="cu-muted">—</span>
                      )}
                    </td>
                    <td>
                      <FailModeBadge failMode={spec.failMode} />
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
                        ariaLabel={`Actions for guardrail ${name}`}
                        actions={[
                          { key: 'view', label: 'View details', onClick: () => openDetail(name) },
                          ...(onUninstall
                            ? [
                                {
                                  key: 'uninstall',
                                  label: uninstallingKey === key ? 'Uninstalling…' : 'Uninstall',
                                  danger: true,
                                  disabled: uninstallingKey === key,
                                  onClick: () => void onUninstall({ name }),
                                },
                              ]
                            : []),
                        ]}
                      />
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </DataTable>
      </TableViewport>
    </div>
  )
}
