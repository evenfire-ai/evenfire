'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'
import { DEFAULT_WORKFLOW_RECIPE_NAMESPACE } from '@constants/workflowRecipes'
import type { WorkflowRecipeResource } from '../lib/api'
import { SectionSearchInput } from './SectionSearchInput'
import { IconWorkflow } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconChevronRight, IconRefresh } from './icons'

const RECIPE_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'phase', label: 'Phase' },
  { key: 'created', label: 'Created' },
  { key: 'navigation', ariaLabel: 'Navigation', align: 'right' },
]

type Props = {
  items: WorkflowRecipeResource[]
  loading: boolean
  error: string
  onInstall: () => void
  onRefresh: () => void
}

function normalizeRecipePhase(phase?: string): string {
  return phase?.trim().toLowerCase() || 'unknown'
}

export function RecipesTab({ items, loading, error, onInstall, onRefresh }: Props) {
  const router = useRouter()
  const [searchQuery, setSearchQuery] = useState('')
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const filteredItems = useMemo(() => {
    if (!normalizedSearch) return items
    return items.filter(item => {
      const name = item.metadata?.name ?? ''
      const namespace = item.metadata?.namespace ?? DEFAULT_WORKFLOW_RECIPE_NAMESPACE
      const phase = normalizeRecipePhase(item.status?.phase)
      const statusWorkloads = (item.status?.workloads as Array<{ id?: string }> | undefined) ?? []
      const specWorkloads = (item.spec?.workloads as Array<{ id?: string }> | undefined) ?? []
      return [
        name,
        namespace,
        phase,
        ...statusWorkloads.map(workload => workload.id || ''),
        ...specWorkloads.map(workload => workload.id || ''),
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    })
  }, [items, normalizedSearch])
  const isInitialLoad = loading && items.length === 0

  function detailHref(name: string, namespace: string): string {
    return CONTROL_ROUTES.plugins.tab(namespace, name, 'workloads')
  }

  return (
    <div className="cu-card cu-card--viewport-fill cu-section-card">
      <TablePanelHeader
        title={
          <>
            <IconWorkflow />
            {isInitialLoad ? 'Plugins' : `Plugins (${filteredItems.length})`}
          </>
        }
        subtitle="Select a plugin to view status, run history, and actions."
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
              onClick={() => router.push(CONTROL_ROUTES.plugins.sdk)}
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
      {error ? <div className="cu-banner cu-banner--error cu-table-error">{error}</div> : null}

      {isInitialLoad ? (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band cu-installed-plugins-table">
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
              No plugins installed. Select <strong>Install Plugin</strong> to deploy one.
            </>
          )}
        </div>
      ) : (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band cu-installed-plugins-table">
            <thead>
              <TableHeaderRow columns={RECIPE_COLUMNS} />
            </thead>
            <tbody>
              {filteredItems.map(item => {
                const name = item.metadata?.name ?? '(unnamed)'
                const namespace = item.metadata?.namespace ?? DEFAULT_WORKFLOW_RECIPE_NAMESPACE
                const key = `${namespace}/${name}`
                const phase = normalizeRecipePhase(item.status?.phase)
                const created = item.metadata?.creationTimestamp
                  ? new Date(item.metadata.creationTimestamp).toLocaleDateString()
                  : '—'
                const href = detailHref(name, namespace)

                return (
                  <tr
                    key={key}
                    className="cu-table__row cu-table__row--clickable"
                    onClick={() => router.push(href)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        router.push(href)
                      }
                    }}
                    tabIndex={0}
                    role="link"
                    aria-label={`Open ${name}`}
                  >
                    <td className="cu-installed-plugin__name">{name}</td>
                    <td>
                      <span
                        className={`cu-plugin-phase cu-plugin-phase--${phase}`}
                        aria-label={`Phase: ${phase}`}
                      >
                        {phase}
                      </span>
                    </td>
                    <td className="cu-installed-plugin__created">{created}</td>
                    <td className="cu-installed-plugin__navigation" aria-hidden="true">
                      <IconChevronRight width={18} height={18} />
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
