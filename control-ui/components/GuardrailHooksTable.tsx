'use client'

import React, { Fragment, useMemo, useState } from 'react'
import type { LlmHookStatus } from '../lib/api'
import type {
  GuardrailHooksTableProps,
  LlmHookSpecView,
  LlmHookTarget,
} from './GuardrailHooksTable.types'
import { SectionSearchInput } from './SectionSearchInput'
import { IconShield } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconChevronRight, IconRefresh, IconX } from './icons'

const HOOK_COLUMNS: TableHeaderColumn[] = [
  { key: 'expand', ariaLabel: 'Expand hook' },
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
  onUninstall,
  uninstallingKey,
  onRefresh,
  refreshing,
  loading,
}: GuardrailHooksTableProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())

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

  const isInitialLoad = loading && items.length === 0

  return (
    <div className="cu-card cu-card--viewport-fill cu-section-card">
      <TablePanelHeader
        title={
          <>
            <IconShield />
            {isInitialLoad ? 'Guardrail Hooks' : `Guardrail Hooks (${filteredRows.length})`}
          </>
        }
        subtitle="Installed LLM guardrail hooks across the cluster."
        actions={
          <>
            <SectionSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search hooks"
              ariaLabel="Search guardrail hooks"
              disabled={isInitialLoad}
            />
            {onRefresh ? (
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--toolbar"
                onClick={() => void onRefresh()}
                disabled={refreshing || isInitialLoad}
                aria-label={refreshing ? 'Refreshing...' : 'Reload guardrail hooks'}
              >
                <IconRefresh
                  className={refreshing ? 'cu-spin' : undefined}
                  width={18}
                  height={18}
                />
              </button>
            ) : null}
          </>
        }
      />
      {isInitialLoad ? (
        <div className="cu-table-wrap cu-guardrails-table-wrap">
          <table className="cu-table cu-table--header-band cu-expandable-table cu-guardrails-table">
            <thead>
              <TableHeaderRow columns={HOOK_COLUMNS} />
            </thead>
            <tbody>
              <SkeletonTableRows columns={HOOK_COLUMNS.length} rows={5} />
            </tbody>
          </table>
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="cu-empty">
          {normalizedSearch ? 'No hooks match this search.' : 'No guardrail hooks installed.'}
        </div>
      ) : (
        <div className="cu-table-wrap cu-guardrails-table-wrap">
          <table className="cu-table cu-table--header-band cu-expandable-table cu-guardrails-table">
            <thead>
              <TableHeaderRow columns={HOOK_COLUMNS} />
            </thead>
            <tbody>
              {filteredRows.map(({ key, name, item }) => {
                const spec = (item.spec || {}) as LlmHookSpecView
                const expanded = expandedKeys.has(key)
                const lifecycle = (spec.lifecyclePoints || []).join(', ')
                const target = describeTarget(spec.target)
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
                      aria-controls={`hook-details-${key}`}
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} hook ${name}`}
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
                        <div className="cu-table-actions">
                          {onUninstall ? (
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--danger-icon"
                              onClick={() => void onUninstall({ name })}
                              disabled={uninstallingKey === key}
                              aria-label={
                                uninstallingKey === key
                                  ? 'Uninstalling...'
                                  : `Uninstall hook ${name}`
                              }
                              title={
                                uninstallingKey === key
                                  ? 'Uninstalling...'
                                  : `Uninstall hook ${name}`
                              }
                            >
                              <IconX width={16} height={16} />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr id={`hook-details-${key}`} className="cu-expandable-detail-row">
                        <td colSpan={HOOK_COLUMNS.length}>
                          <div className="cu-expandable-detail cu-connector-detail">
                            <div className="cu-expandable-detail__fields">
                              <div className="cu-expandable-field cu-expandable-field--wide">
                                <span className="cu-expandable-field__label">Target</span>
                                <span className="cu-expandable-field__code">{target || '—'}</span>
                              </div>
                              <div className="cu-expandable-field">
                                <span className="cu-expandable-field__label">Path</span>
                                <span className="cu-expandable-field__code">
                                  {spec.path || '/'}
                                </span>
                              </div>
                              <div className="cu-expandable-field cu-expandable-field--wide">
                                <span className="cu-expandable-field__label">Capabilities</span>
                                {spec.capabilities && spec.capabilities.length > 0 ? (
                                  <div className="cu-expandable-tags">
                                    {spec.capabilities.map(capability => (
                                      <span key={capability} className="cu-registry-tag">
                                        {capability}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="cu-muted">None declared</span>
                                )}
                              </div>
                              <div className="cu-expandable-field">
                                <span className="cu-expandable-field__label">Observed digest</span>
                                <span className="cu-expandable-field__code">
                                  {item.status?.observedDigest || '—'}
                                </span>
                              </div>
                              <div className="cu-expandable-field">
                                <span className="cu-expandable-field__label">Ready replicas</span>
                                <span>
                                  {typeof item.status?.readyReplicas === 'number'
                                    ? item.status.readyReplicas
                                    : '—'}
                                </span>
                              </div>
                              <div className="cu-expandable-field">
                                <span className="cu-expandable-field__label">Last reconciled</span>
                                <span>{item.status?.lastReconciled || '—'}</span>
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
    </div>
  )
}
