'use client'

import React, { useMemo, useState } from 'react'
import { LlmProviderIcon } from './LlmProviderIcon'
import { getProviderLabel } from '../lib/llm'
import type { HostItem, HostLifecycleInfo, HostRef } from './HostTable.types'
import { SectionSearchInput } from './SectionSearchInput'
import { IconRobot } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh, IconX } from './icons'

const HOST_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'lifecycle', label: 'Lifecycle', width: '10rem' },
  { key: 'context', label: 'Context', width: '20%' },
  { key: 'providers', label: 'Providers', minWidth: '8rem' },
  { key: 'actions', width: '3.5rem', align: 'right', ariaLabel: 'Actions' },
]

function getHostLifecycleInfo(host: HostItem): HostLifecycleInfo {
  const isStateless = host.spec?.lifecycle?.stateless === true
  const rejection = host.status?.conditions?.find(
    condition =>
      condition.type === 'StatelessEnableRejected' &&
      String(condition.status || '').toLowerCase() === 'true'
  )
  const rejectedReason = String(rejection?.message || rejection?.reason || '').trim()
  const state = rejection
    ? 'blocked'
    : isStateless
      ? String(host.status?.lifecycle?.state || '').trim()
      : ''
  const reason = rejection
    ? rejectedReason
    : isStateless
      ? String(host.status?.lifecycle?.reason || '').trim()
      : ''
  const label = isStateless ? 'Stateless' : 'Stateful'
  const details = [state, reason].filter(Boolean).join(' - ')
  return {
    kind: rejection ? 'blocked' : isStateless ? 'stateless' : 'stateful',
    label,
    state,
    reason,
    title: details ? `${label}: ${details}` : `${label} agent`,
  }
}

function collectProviderIds(spec: Record<string, unknown>): string[] {
  const primary = String(
    (spec.model as { provider?: string } | undefined)?.provider || ''
  ).trim()
  const fallbacks = Array.isArray(
    (spec.llmPolicy as { fallbacks?: Array<{ provider?: string }> } | undefined)?.fallbacks
  )
    ? (
        spec.llmPolicy as { fallbacks: Array<{ provider?: string }> }
      ).fallbacks
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

function HostLifecycleBadge({ lifecycle }: { lifecycle: HostLifecycleInfo }) {
  return (
    <span
      className={`cu-host-lifecycle cu-host-lifecycle--${lifecycle.kind}`}
      title={lifecycle.title}
      aria-label={lifecycle.title}
    >
      <span className="cu-host-lifecycle__dot" aria-hidden="true" />
      <span className="cu-host-lifecycle__label">{lifecycle.label}</span>
      {lifecycle.state ? <span className="cu-host-lifecycle__state">{lifecycle.state}</span> : null}
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
    return rows.filter(({ name, namespace, item }) => {
      const spec = item.spec || {}
      const lifecycle = getHostLifecycleInfo(item)
      const contextRef = String(spec.contextRef || '').trim()
      const providers = collectProviderIds(spec)
      const providerLabels = providers.map(id => getProviderLabel(id)).join(' ')
      return [
        name,
        namespace,
        lifecycle.label,
        lifecycle.state,
        lifecycle.reason,
        contextRef,
        providerLabels,
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    })
  }, [normalizedSearch, rows])

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
        actions={
          <>
            <SectionSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search agents"
              ariaLabel="Search agents"
              disabled={isInitialLoad}
            />
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              onClick={() => void onRefresh()}
              disabled={refreshing || isInitialLoad}
              aria-label={refreshing ? 'Refreshing…' : 'Reload agents'}
            >
              <IconRefresh className={refreshing ? 'cu-spin' : undefined} width={18} height={18} />
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={onCreateHost}
              disabled={isInitialLoad}
            >
              Create agent
            </button>
          </>
        }
      />
      {isInitialLoad ? (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={HOST_COLUMNS} />
            </thead>
            <tbody>
              <SkeletonTableRows columns={5} rows={4} />
            </tbody>
          </table>
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="cu-empty">
          {normalizedSearch ? 'No agents match this search.' : 'No agents found.'}
        </div>
      ) : (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={HOST_COLUMNS} />
            </thead>
            <tbody>
              {filteredRows.map(({ key, namespace, name, item }) => {
                const rawContext = String(item.spec?.contextRef || '').trim()
                const contextRef = rawContext || '-'
                const contextClickable = Boolean(rawContext)
                const providers = collectProviderIds(item.spec || {})
                const lifecycle = getHostLifecycleInfo(item)
                const openAgent = () => onOpen({ namespace, name })
                return (
                  <tr
                    key={key}
                    className="cu-table__row cu-table__row--clickable"
                    onClick={openAgent}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openAgent()
                      }
                    }}
                    tabIndex={0}
                    aria-label={`Open agent ${name}`}
                  >
                    <td>
                      <span className="cu-expandable-row__name">{name}</span>
                    </td>
                    <td>
                      <HostLifecycleBadge lifecycle={lifecycle} />
                    </td>
                    <td>
                      {contextClickable ? (
                        <button
                          type="button"
                          className="cu-link"
                          onClick={e => {
                            e.stopPropagation()
                            onOpenContext(rawContext)
                          }}
                          onKeyDown={e => e.stopPropagation()}
                        >
                          {contextRef}
                        </button>
                      ) : (
                        <span className="cu-table__cell-muted">{contextRef}</span>
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
                      <button
                        type="button"
                        className="cu-btn cu-btn--icon cu-btn--danger-icon"
                        onClick={() => void onDelete({ namespace, name })}
                        onKeyDown={e => e.stopPropagation()}
                        disabled={deletingKey === key}
                        aria-label={
                          deletingKey === key ? 'Deleting agent…' : `Remove agent ${name}`
                        }
                      >
                        <IconX width={16} height={16} />
                      </button>
                    </td>
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
