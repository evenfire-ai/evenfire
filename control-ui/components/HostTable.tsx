'use client'

import React, { useMemo, useState } from 'react'
import { getProviderLabel } from '../lib/llm'
import { SectionSearchInput } from './SectionSearchInput'
import { IconRobot } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh, IconX } from './icons'

type HostItem = {
  metadata?: { name?: string; namespace?: string }
  spec?: Record<string, unknown>
}

type HostRef = { name: string; namespace: string }

const HOST_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace', width: '22%' },
  { key: 'context', label: 'Context', width: '22%' },
  { key: 'model', label: 'Model', minWidth: '8rem' },
  { key: 'actions', width: '3.5rem', align: 'right', ariaLabel: 'Actions' },
]

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
      const contextRef = String(spec.contextRef || '').trim()
      const modelProvider = String(
        (spec.model as { provider?: string } | undefined)?.provider || ''
      )
      const modelName = String((spec.model as { name?: string } | undefined)?.name || '')
      const modelProviderLabel = modelProvider ? getProviderLabel(modelProvider) : ''
      return [name, namespace, contextRef, modelProviderLabel, modelName]
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
                const modelProvider = String(
                  (item.spec?.model as { provider?: string } | undefined)?.provider || ''
                )
                const modelName = String(
                  (item.spec?.model as { name?: string } | undefined)?.name || ''
                )
                const modelProviderLabel = modelProvider ? getProviderLabel(modelProvider) : ''
                const model =
                  modelProviderLabel || modelName
                    ? `${modelProviderLabel}${modelProviderLabel && modelName ? '/' : ''}${modelName}`
                    : '-'
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
                      <button
                        type="button"
                        className="cu-link"
                        onClick={e => {
                          e.stopPropagation()
                          openAgent()
                        }}
                        onKeyDown={e => e.stopPropagation()}
                      >
                        {name}
                      </button>
                    </td>
                    <td style={{ color: 'var(--cu-text-soft)' }}>{namespace}</td>
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
                        <span style={{ color: 'var(--cu-text-muted)' }}>{contextRef}</span>
                      )}
                    </td>
                    <td style={{ color: 'var(--cu-text-soft)', fontSize: '0.8125rem' }}>{model}</td>
                    <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
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
