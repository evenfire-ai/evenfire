'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DataTable, TableStateRow, useTableSort } from '@clerum/frontend-table-system'
import { CONTROL_ROUTES } from '@constants/routes'
import { DEFAULT_WORKFLOW_RECIPE_NAMESPACE } from '@constants/workflowRecipes'
import type { WorkflowRecipeResource } from '../lib/api'
import { PluginsEmptyState } from './PluginsEmptyState'
import { SectionSearchInput } from './SectionSearchInput'
import { IconWorkflow } from './Sidebar/icons'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh } from './icons'

const RECIPE_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'phase', label: 'Phase' },
  { key: 'created', label: 'Created' },
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
  const recipeSort = useTableSort<WorkflowRecipeResource, 'name' | 'phase' | 'created'>({
    rows: filteredItems,
    defaultKey: 'name',
    identity: item =>
      `${item.metadata?.namespace ?? DEFAULT_WORKFLOW_RECIPE_NAMESPACE}/${item.metadata?.name ?? ''}`,
    accessors: {
      name: item => item.metadata?.name,
      phase: item => normalizeRecipePhase(item.status?.phase),
      created: item => item.metadata?.creationTimestamp,
    },
  })
  const columns = RECIPE_COLUMNS.map(column => ({
    ...column,
    activeDirection: recipeSort.key === column.key ? recipeSort.direction : null,
    onSort: () => recipeSort.sortBy(column.key as 'name' | 'phase' | 'created'),
  }))
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
        secondaryActions={
          <button
            type="button"
            className="cu-btn cu-btn--sm cu-nowrap"
            onClick={() => router.push(CONTROL_ROUTES.plugins.sdk)}
            disabled={isInitialLoad}
          >
            Plugins SDK
          </button>
        }
        refreshAction={
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--toolbar"
            onClick={onRefresh}
            disabled={loading || isInitialLoad}
            aria-label={loading ? 'Refreshing…' : 'Reload plugins'}
          >
            <IconRefresh className={loading ? 'cu-spin' : undefined} width={18} height={18} />
          </button>
        }
        search={
          <SectionSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search plugins"
            ariaLabel="Search plugins"
            disabled={isInitialLoad}
          />
        }
        primaryAction={
          <button
            type="button"
            className="cu-btn cu-btn--primary cu-btn--sm"
            onClick={onInstall}
            disabled={isInitialLoad}
          >
            Install Plugin
          </button>
        }
      />
      {error ? <div className="cu-banner cu-banner--error cu-table-error">{error}</div> : null}

      <div className="eft-table-viewport cu-table-wrap">
        <DataTable className="eft-table cu-table cu-table--header-band cu-installed-plugins-table">
          <thead>
            <TableHeaderRow columns={columns} />
          </thead>
          <tbody>
            {isInitialLoad ? (
              <TableStateRow colSpan={columns.length} kind="loading" message="Loading plugins…" />
            ) : error && recipeSort.sortedRows.length === 0 ? (
              <TableStateRow colSpan={columns.length} kind="error" message={error} />
            ) : filteredItems.length === 0 ? (
              <TableStateRow
                colSpan={columns.length}
                message={normalizedSearch ? 'No plugins match this search.' : <PluginsEmptyState />}
              />
            ) : (
              recipeSort.sortedRows.map(item => {
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
                  </tr>
                )
              })
            )}
          </tbody>
        </DataTable>
      </div>
    </div>
  )
}
