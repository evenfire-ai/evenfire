'use client'

import React, { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DEFAULT_WORKFLOW_RECIPE_NAMESPACE } from '@constants/workflowRecipes'
import type { WorkflowRecipeResource } from '../lib/api'
import { SectionSearchInput } from './SectionSearchInput'
import { IconWorkflow } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh } from './icons'

const RECIPE_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'phase', label: 'Phase' },
  { key: 'workloads', label: 'Workloads' },
  { key: 'created', label: 'Created' },
  { key: 'arrow', label: '' },
]

type Props = {
  items: WorkflowRecipeResource[]
  loading: boolean
  error: string
  onInstall: () => void
  onRefresh: () => void
}

function normalizeRecipePhase(phase?: string): string | undefined {
  const normalized = phase?.trim().toLowerCase()
  if (
    normalized === 'deploying' ||
    normalized === 'running' ||
    normalized === 'active' ||
    normalized === 'failed' ||
    normalized === 'cancelled'
  ) {
    return normalized
  }
  return undefined
}

function getRecipeResourcePhase(item: WorkflowRecipeResource): string {
  const phase = item.status?.phase?.trim()
  return phase ? phase.toLowerCase() : 'unknown'
}

function phaseBadgeStyle(phase?: string): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: '0.78rem',
    fontWeight: 600,
    display: 'inline-block',
  }
  switch (normalizeRecipePhase(phase)) {
    case 'active':
      return { ...base, background: '#1a3a2a', color: '#34d399' }
    case 'failed':
      return { ...base, background: '#3a1a1a', color: '#f87171' }
    case 'cancelled':
      return { ...base, background: 'var(--cu-bg-elevated)', color: 'var(--cu-text-soft)' }
    case 'deploying':
      return { ...base, background: '#2a2a1a', color: '#fbbf24' }
    case 'running':
      return {
        ...base,
        background: 'rgba(var(--cu-accent-rgb), 0.14)',
        color: 'var(--cu-accent-hover)',
      }
    default:
      return { ...base, background: 'var(--cu-bg-elevated)', color: 'var(--cu-text-soft)' }
  }
}

export function RecipesTab({ items, loading, error, onInstall, onRefresh }: Props) {
  const router = useRouter()
  const [searchQuery, setSearchQuery] = useState('')
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const filteredItems = useMemo(() => {
    if (!normalizedSearch) return items
    return items.filter(item => {
      const name = item.metadata?.name ?? ''
      const ns = item.metadata?.namespace ?? DEFAULT_WORKFLOW_RECIPE_NAMESPACE
      const phase = getRecipeResourcePhase(item)
      const statusWorkloads = (item.status?.workloads as Array<{ id?: string }> | undefined) ?? []
      const specWorkloads = (item.spec?.workloads as Array<{ id?: string }> | undefined) ?? []
      return [
        name,
        ns,
        phase,
        ...statusWorkloads.map(w => w.id || ''),
        ...specWorkloads.map(w => w.id || ''),
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    })
  }, [items, normalizedSearch])
  const isInitialLoad = loading && items.length === 0

  function detailHref(name: string, namespace: string): string {
    return `/workflow-recipes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
  }

  return (
    <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
      <TablePanelHeader
        title={
          <>
            <IconWorkflow />
            {isInitialLoad ? 'Plugins' : `Plugins (${filteredItems.length})`}
          </>
        }
        subtitle="Click a row to view status, run history, and actions."
        actions={
          <>
            <SectionSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search plugins"
              ariaLabel="Search plugins"
              disabled={isInitialLoad}
            />
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              onClick={onRefresh}
              disabled={loading || isInitialLoad}
              aria-label={loading ? 'Refreshing…' : 'Reload plugins'}
            >
              <IconRefresh className={loading ? 'cu-spin' : undefined} width={18} height={18} />
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--sm cu-nowrap"
              onClick={() => router.push('/plugin-workload-sdk')}
              disabled={isInitialLoad}
            >
              Plugins SDK
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={onInstall}
              disabled={isInitialLoad}
            >
              Install Plugin
            </button>
          </>
        }
      />
      {error ? (
        <div className="cu-banner cu-banner--error" style={{ padding: '0.85rem 1rem 0' }}>
          {error}
        </div>
      ) : null}

      {isInitialLoad ? (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={RECIPE_COLUMNS} />
            </thead>
            <tbody>
              <SkeletonTableRows columns={RECIPE_COLUMNS.length} rows={4} />
            </tbody>
          </table>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="cu-empty">
          {normalizedSearch ? (
            'No plugins match this search.'
          ) : (
            <>
              No plugins installed. Click <strong>Install Plugin</strong> to deploy one.
            </>
          )}
        </div>
      ) : (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={RECIPE_COLUMNS} />
            </thead>
            <tbody>
              {filteredItems.map(item => {
                const name = item.metadata?.name ?? '(unnamed)'
                const ns = item.metadata?.namespace ?? DEFAULT_WORKFLOW_RECIPE_NAMESPACE
                const key = `${ns}/${name}`
                const phase = getRecipeResourcePhase(item)
                const statusWorkloads = item.status?.workloads as
                  | Array<{ id: string; ready: boolean; replicas?: number }>
                  | undefined
                const workloadIds = (
                  (item.spec?.workloads as Array<{ id?: string }> | undefined) ?? []
                ).map((w, i) => w.id ?? `wl-${i}`)
                const created = item.metadata?.creationTimestamp
                  ? new Date(item.metadata.creationTimestamp).toLocaleDateString()
                  : '—'
                const href = detailHref(name, ns)

                return (
                  <tr
                    key={key}
                    className="cu-table__row cu-table__row--clickable"
                    onClick={() => router.push(href)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        router.push(href)
                      }
                    }}
                    tabIndex={0}
                    role="link"
                    aria-label={`Open ${name}`}
                    style={{
                      borderBottom: '1px solid var(--cu-border-subtle)',
                      cursor: 'pointer',
                    }}
                  >
                    <td style={{ padding: '10px 10px', fontWeight: 600, color: 'var(--cu-text)' }}>
                      {name}
                    </td>
                    <td
                      style={{
                        padding: '10px 10px',
                        color: 'var(--cu-text-soft)',
                        fontSize: '0.85rem',
                      }}
                    >
                      {ns}
                    </td>
                    <td style={{ padding: '10px 10px' }}>
                      <span aria-label={`Phase: ${phase}`} style={phaseBadgeStyle(phase)}>
                        {phase}
                      </span>
                    </td>
                    <td style={{ padding: '10px 10px' }}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {statusWorkloads ? (
                          statusWorkloads.length === 0 ? (
                            <span style={{ color: 'var(--cu-text-muted)' }}>—</span>
                          ) : (
                            statusWorkloads.map(w => (
                              <span
                                key={w.id}
                                title={w.ready ? 'Ready' : 'Not Ready'}
                                style={{
                                  padding: '1px 7px',
                                  borderRadius: 4,
                                  background: 'var(--cu-bg-elevated)',
                                  color: 'var(--cu-text-soft)',
                                  fontSize: '0.75rem',
                                  fontFamily: 'monospace',
                                  border: `1px solid ${w.ready ? 'rgba(var(--cu-success-rgb), 0.5)' : '#4a3a10'}`,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                }}
                              >
                                <span
                                  style={{
                                    color: w.ready ? 'var(--cu-success)' : '#fbbf24',
                                    fontSize: '0.65rem',
                                  }}
                                >
                                  ●
                                </span>
                                {w.id}
                                {w.replicas !== undefined && (
                                  <span
                                    style={{ color: 'var(--cu-text-muted)', fontSize: '0.7rem' }}
                                  >
                                    ×{w.replicas}
                                  </span>
                                )}
                              </span>
                            ))
                          )
                        ) : workloadIds.length === 0 ? (
                          <span style={{ color: 'var(--cu-text-muted)' }}>—</span>
                        ) : (
                          workloadIds.map(id => (
                            <span
                              key={id}
                              style={{
                                padding: '1px 7px',
                                borderRadius: 4,
                                background: 'var(--cu-bg-elevated)',
                                color: 'var(--cu-text-soft)',
                                fontSize: '0.75rem',
                                fontFamily: 'monospace',
                                border: '1px solid var(--cu-border)',
                              }}
                            >
                              {id}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td
                      style={{
                        padding: '10px 10px',
                        color: 'var(--cu-text-soft)',
                        fontSize: '0.85rem',
                      }}
                    >
                      {created}
                    </td>
                    <td
                      style={{
                        padding: '10px 10px',
                        textAlign: 'right',
                        color: 'var(--cu-text-muted)',
                      }}
                      aria-hidden
                    >
                      ›
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
