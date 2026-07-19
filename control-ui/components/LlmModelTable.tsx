'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CONTROL_ROUTES } from '@constants/routes'
import type { LlmAllowedModel } from '@lib/api'
import { formatContextWindow, getProviderDisplayLabel } from '@lib/llm'
import { isUnpricedAllowedModel } from '@lib/llmModelUnpriced'
import type { LlmModelTableProps } from './LlmModelTable.types'
import { SectionSearchInput } from './SectionSearchInput'
import { IconModels } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconPencil, IconRefresh, IconX } from './icons'
import { SelectInput } from './ui'

const MODEL_COLUMNS: TableHeaderColumn[] = [
  { key: 'provider', label: 'Provider', width: '10%' },
  { key: 'model', label: 'Model', minWidth: '12rem' },
  { key: 'vendor', label: 'Vendor', width: '10rem' },
  { key: 'displayName', label: 'Display name', minWidth: '10rem' },
  { key: 'contextWindow', label: 'Context window', align: 'right', width: '9rem' },
  { key: 'enabled', label: 'Enabled', width: '6rem' },
  { key: 'source', label: 'Source', width: '7rem' },
  { key: 'stale', label: 'Stale', width: '6rem' },
  { key: 'actions', width: '5rem', align: 'right', ariaLabel: 'Actions' },
]

const ALL_PROVIDERS = '__all__'

type EnabledFilter = 'all' | 'enabled' | 'disabled'
type SourceFilter = 'all' | 'manual' | 'discovery'

export function LlmModelTable({
  items,
  unpricedKeys,
  onCreate,
  onEdit,
  onDelete,
  onRefresh,
  deletingId,
  refreshing,
  loading,
}: LlmModelTableProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState<string>(ALL_PROVIDERS)
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const normalizedSearch = searchQuery.trim().toLowerCase()

  const providerOptions = useMemo(() => {
    const providers = Array.from(new Set(items.map(m => m.provider))).sort()
    return providers
  }, [items])

  // Only surface the source filter when both kinds are present — a pure-manual
  // (or pure-discovery) allowlist gains nothing from the control.
  const hasMultipleSources = useMemo(() => new Set(items.map(m => m.source)).size > 1, [items])

  // When a refresh/delete collapses the list to a single source, the source
  // control unmounts — clear its filter so it can't silently blank the table
  // with no visible way to reset it.
  useEffect(() => {
    if (!hasMultipleSources) setSourceFilter('all')
  }, [hasMultipleSources])

  const filteredItems = useMemo(() => {
    return items.filter(model => {
      if (providerFilter !== ALL_PROVIDERS && model.provider !== providerFilter) return false
      if (enabledFilter === 'enabled' && !model.enabled) return false
      if (enabledFilter === 'disabled' && model.enabled) return false
      if (sourceFilter !== 'all' && model.source !== sourceFilter) return false
      if (!normalizedSearch) return true
      return [
        model.provider,
        getProviderDisplayLabel(model.provider),
        model.model,
        model.vendor ?? '',
        model.display_name ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    })
  }, [items, normalizedSearch, providerFilter, enabledFilter, sourceFilter])

  const hasActiveFilter =
    Boolean(normalizedSearch) ||
    providerFilter !== ALL_PROVIDERS ||
    enabledFilter !== 'all' ||
    sourceFilter !== 'all'

  const unpricedCount = useMemo(
    () => items.filter(model => isUnpricedAllowedModel(model, unpricedKeys)).length,
    [items, unpricedKeys]
  )

  const isInitialLoad = Boolean(loading) && items.length === 0

  return (
    <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
      <TablePanelHeader
        title={
          <>
            <IconModels />
            {isInitialLoad ? 'LLM Models' : `LLM Models (${filteredItems.length})`}
          </>
        }
        subtitle="Operator-declared allowlist of usable models per provider. Only enabled models can be selected for agents and runtime."
        actions={
          <>
            {providerOptions.length > 1 ? (
              <SelectInput
                compact
                value={providerFilter}
                onChange={event => setProviderFilter(event.target.value)}
                disabled={isInitialLoad}
                aria-label="Filter by provider"
              >
                <option value={ALL_PROVIDERS}>All providers</option>
                {providerOptions.map(provider => (
                  <option key={provider} value={provider}>
                    {getProviderDisplayLabel(provider)}
                  </option>
                ))}
              </SelectInput>
            ) : null}
            <SelectInput
              compact
              value={enabledFilter}
              onChange={event => setEnabledFilter(event.target.value as EnabledFilter)}
              disabled={isInitialLoad}
              aria-label="Filter by enabled state"
            >
              <option value="all">All states</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </SelectInput>
            {hasMultipleSources ? (
              <SelectInput
                compact
                value={sourceFilter}
                onChange={event => setSourceFilter(event.target.value as SourceFilter)}
                disabled={isInitialLoad}
                aria-label="Filter by source"
              >
                <option value="all">All sources</option>
                <option value="manual">Manual</option>
                <option value="discovery">Discovered</option>
              </SelectInput>
            ) : null}
            <SectionSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search models"
              ariaLabel="Search models"
              disabled={isInitialLoad}
            />
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              onClick={() => void onRefresh()}
              disabled={refreshing || isInitialLoad}
              aria-label={refreshing ? 'Refreshing…' : 'Reload models'}
            >
              <IconRefresh className={refreshing ? 'cu-spin' : undefined} width={18} height={18} />
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={onCreate}
              disabled={isInitialLoad}
            >
              Add model
            </button>
          </>
        }
      />
      {unpricedCount > 0 ? (
        <div className="cu-px-unpriced-slot">
          <div className="cu-banner cu-banner--warning" role="status">
            <strong>{unpricedCount}</strong> allowed model{unpricedCount === 1 ? '' : 's'}{' '}
            {unpricedCount === 1 ? 'has' : 'have'} no enabled price. Cost budgets under-count spend
            for {unpricedCount === 1 ? 'it' : 'them'} until you{' '}
            <Link href={CONTROL_ROUTES.costAndUsage.llmPrices} className="cu-link">
              add a price
            </Link>
            .
          </div>
        </div>
      ) : null}
      {isInitialLoad ? (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={MODEL_COLUMNS} />
            </thead>
            <tbody>
              <SkeletonTableRows columns={MODEL_COLUMNS.length} rows={4} />
            </tbody>
          </table>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="cu-empty">
          {hasActiveFilter
            ? 'No models match this filter.'
            : 'No models in the allowlist yet. Add one to let agents and runtime use it.'}
        </div>
      ) : (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={MODEL_COLUMNS} />
            </thead>
            <tbody>
              {filteredItems.map((model: LlmAllowedModel) => (
                <tr key={model.id} className="cu-table__row">
                  <td>{getProviderDisplayLabel(model.provider)}</td>
                  <td className="cu-px-model">
                    {model.model}
                    {isUnpricedAllowedModel(model, unpricedKeys) ? (
                      <Link
                        href={CONTROL_ROUTES.costAndUsage.llmPrices}
                        className="cu-px-badge cu-px-badge--off"
                        style={{ marginLeft: '0.5rem', textDecoration: 'none' }}
                        title="Allowed model without a price — add one so cost budgets can price it"
                      >
                        No price
                      </Link>
                    ) : null}
                  </td>
                  <td>{model.vendor || '—'}</td>
                  <td>{model.display_name || '—'}</td>
                  <td className="cu-px-num">{formatContextWindow(model.context_window_tokens)}</td>
                  <td>
                    <span
                      className={
                        model.enabled
                          ? 'cu-px-badge cu-px-badge--on'
                          : 'cu-px-badge cu-px-badge--off'
                      }
                    >
                      {model.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td>
                    <span
                      className={
                        model.source === 'discovery'
                          ? 'cu-px-badge cu-px-badge--info'
                          : 'cu-px-badge cu-px-badge--off'
                      }
                    >
                      {model.source === 'discovery' ? 'Discovered' : 'Manual'}
                    </span>
                  </td>
                  <td>
                    {model.stale === true ? (
                      <span
                        className="cu-px-badge cu-px-badge--warn"
                        title="This model vanished from provider discovery but is kept — it is never auto-removed. Review whether to keep or remove it."
                      >
                        Stale
                      </span>
                    ) : null}
                  </td>
                  <td className="cu-px-actions">
                    <button
                      type="button"
                      className="cu-btn cu-btn--icon cu-btn--toolbar"
                      onClick={() => onEdit(model.id)}
                      aria-label={`Edit model ${model.provider}/${model.model}`}
                    >
                      <IconPencil width={16} height={16} />
                    </button>
                    <button
                      type="button"
                      className="cu-btn cu-btn--icon cu-btn--danger-icon"
                      onClick={() => void onDelete(model)}
                      disabled={deletingId === model.id}
                      aria-label={
                        deletingId === model.id
                          ? 'Deleting model…'
                          : `Delete model ${model.provider}/${model.model}`
                      }
                    >
                      <IconX width={16} height={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
