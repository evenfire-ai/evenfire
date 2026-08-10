'use client'

import React, { useEffect, useMemo, useState } from 'react'
import type { LlmAllowedModel } from '@lib/api'
import { formatContextWindow, getProviderDisplayLabel } from '@lib/llm'
import { isUnpricedAllowedModel } from '@lib/llmModelUnpriced'
import { type SortDirection, TableSortHeader, compareNullsLast, toggleSort } from '@lib/tableSort'
import { FilterSelect } from './FilterSelect'
import type { LlmModelTableProps } from './LlmModelTable.types'
import { LlmProviderIcon } from './LlmProviderIcon'
import { MissingPriceWarning } from './MissingPriceWarning'
import { SectionSearchInput } from './SectionSearchInput'
import { IconModels } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconChevronRight, IconPencil, IconRefresh, IconX } from './icons'
import { SelectInput } from './ui'

type ModelSortKey = 'model' | 'vendor' | 'displayName' | 'contextWindow'

// Natural default direction per column: numeric columns read best descending
// (largest context window first); text columns read best ascending.
const MODEL_SORT_DEFAULT_DIR: Record<ModelSortKey, SortDirection> = {
  contextWindow: 'desc',
  displayName: 'asc',
  model: 'asc',
  vendor: 'asc',
}

function compareModelByKey(key: ModelSortKey) {
  return (a: LlmAllowedModel, b: LlmAllowedModel): number => {
    switch (key) {
      case 'model':
        return a.model.localeCompare(b.model)
      case 'vendor':
        return (a.vendor ?? '').localeCompare(b.vendor ?? '')
      case 'displayName':
        return (a.display_name ?? '').localeCompare(b.display_name ?? '')
      case 'contextWindow':
        return (a.context_window_tokens ?? 0) - (b.context_window_tokens ?? 0)
    }
  }
}

function compareModel(a: LlmAllowedModel, b: LlmAllowedModel): number {
  return a.model.localeCompare(b.model)
}

const ALL_PROVIDERS = '__all__'

type EnabledFilter = 'all' | 'enabled' | 'disabled'
type SourceFilter = 'all' | 'manual' | 'discovery'

export function LlmModelTable({
  items,
  navigation,
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
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<ModelSortKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDirection>('asc')
  const normalizedSearch = searchQuery.trim().toLowerCase()

  const providerOptions = useMemo(() => {
    return Array.from(new Set(items.map(model => model.provider))).sort((left, right) =>
      getProviderDisplayLabel(left).localeCompare(getProviderDisplayLabel(right))
    )
  }, [items])

  const providerFilterOptions = useMemo(
    () => [
      {
        value: ALL_PROVIDERS,
        label: 'All providers',
        icon: <IconModels />,
      },
      ...providerOptions.map(provider => {
        const label = getProviderDisplayLabel(provider)
        return {
          value: provider,
          label,
          icon: <LlmProviderIcon provider={provider} label={label} />,
        }
      }),
    ],
    [providerOptions]
  )

  // Only surface the source filter when both kinds are present — a pure-manual
  // (or pure-discovery) allowlist gains nothing from the control.
  const hasMultipleSources = useMemo(() => new Set(items.map(m => m.source)).size > 1, [items])

  // When a refresh/delete collapses the list to a single source, the source
  // control unmounts — clear its filter so it can't silently blank the table
  // with no visible way to reset it.
  useEffect(() => {
    if (!hasMultipleSources) setSourceFilter('all')
  }, [hasMultipleSources])

  // A provider can disappear after a refresh or deletion. Clear a selection
  // that is no longer available even if other providers still keep the filter
  // visible, otherwise the table presents an empty state with no matching
  // option selected.
  useEffect(() => {
    if (providerFilter !== ALL_PROVIDERS && !providerOptions.includes(providerFilter)) {
      setProviderFilter(ALL_PROVIDERS)
    }
  }, [providerFilter, providerOptions])

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

  const groupedItems = useMemo(() => {
    const groups = new Map<string, LlmAllowedModel[]>()
    for (const model of filteredItems) {
      const group = groups.get(model.provider)
      if (group) group.push(model)
      else groups.set(model.provider, [model])
    }
    for (const group of groups.values()) {
      if (!sortKey) continue
      const direction = sortDir === 'asc' ? 1 : -1
      const byKey = compareModelByKey(sortKey)
      group.sort((a, b) => {
        if (sortKey === 'contextWindow') {
          const nullOrder = compareNullsLast(a.context_window_tokens, b.context_window_tokens)
          if (nullOrder !== null) return nullOrder
        }
        const diff = byKey(a, b) * direction
        if (diff !== 0) return diff
        return compareModel(a, b)
      })
    }
    return Array.from(groups.entries()).sort(([left], [right]) =>
      getProviderDisplayLabel(left).localeCompare(getProviderDisplayLabel(right))
    )
  }, [filteredItems, sortDir, sortKey])

  // Search should reveal results without forcing the operator to open every
  // matching provider first. Keep those groups open after search is cleared so
  // the result the operator was working with does not suddenly disappear.
  useEffect(() => {
    if (!normalizedSearch) return
    setExpandedProviders(current => {
      const next = new Set(current)
      for (const [provider] of groupedItems) next.add(provider)
      return next
    })
  }, [groupedItems, normalizedSearch])

  const hasActiveFilter =
    Boolean(normalizedSearch) ||
    providerFilter !== ALL_PROVIDERS ||
    enabledFilter !== 'all' ||
    sourceFilter !== 'all'

  const isInitialLoad = Boolean(loading) && items.length === 0

  function handleProviderFilterChange(nextProvider: string) {
    setProviderFilter(nextProvider)
    if (nextProvider === ALL_PROVIDERS) return
    setExpandedProviders(current => new Set(current).add(nextProvider))
  }

  function toggleProvider(provider: string) {
    setExpandedProviders(current => {
      const next = new Set(current)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }

  const renderSortHeader = (key: ModelSortKey, label: string) => (
    <TableSortHeader
      activeKey={sortKey}
      defaultDirections={MODEL_SORT_DEFAULT_DIR}
      direction={sortDir}
      label={label}
      onSort={nextKey =>
        toggleSort(nextKey, sortKey, MODEL_SORT_DEFAULT_DIR, setSortKey, setSortDir)
      }
      sortKey={key}
    />
  )

  const modelColumns: TableHeaderColumn[] = [
    { key: 'model', label: renderSortHeader('model', 'Model'), minWidth: '15rem' },
    { key: 'vendor', label: renderSortHeader('vendor', 'Vendor'), width: '10rem' },
    {
      key: 'displayName',
      label: renderSortHeader('displayName', 'Display name'),
      minWidth: '10rem',
    },
    {
      key: 'contextWindow',
      label: renderSortHeader('contextWindow', 'Context window'),
      align: 'right',
      width: '9rem',
    },
    { key: 'enabled', label: 'Enabled', width: '6rem' },
    { key: 'source', label: 'Source', width: '7rem' },
    { key: 'catalogStatus', label: 'Catalog status', width: '8rem' },
    { key: 'actions', width: '5rem', align: 'right', ariaLabel: 'Actions' },
  ]

  return (
    <div className="cu-card cu-card--viewport-fill cu-section-card">
      <TablePanelHeader
        title={
          <>
            <IconModels />
            LLM Models
          </>
        }
        subtitle="The authoritative allowlist of manual and discovered models. Only enabled rows can be selected for agents and runtime."
        actions={
          <>
            {providerOptions.length > 1 ? (
              <FilterSelect
                className="cu-llm-provider-filter"
                value={providerFilter}
                onChange={handleProviderFilterChange}
                options={providerFilterOptions}
                disabled={isInitialLoad}
                ariaLabel="Filter by provider"
              />
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
      {navigation}
      {isInitialLoad ? (
        <div className="cu-table-wrap cu-table-wrap--sticky-header">
          <table className="cu-table cu-table--header-band cu-llm-model-table">
            <thead>
              <TableHeaderRow columns={modelColumns} />
            </thead>
            <tbody>
              <SkeletonTableRows columns={modelColumns.length} rows={4} />
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
        <div className="cu-table-wrap cu-table-wrap--sticky-header">
          <table className="cu-table cu-table--header-band cu-llm-model-table">
            <thead>
              <TableHeaderRow columns={modelColumns} />
            </thead>
            {groupedItems.map(([provider, models]) => {
              const providerLabel = getProviderDisplayLabel(provider)
              const providerModels = items.filter(model => model.provider === provider)
              const enabledCount = providerModels.filter(model => model.enabled).length
              const staleCount = providerModels.filter(model => model.stale).length
              const hasFilteredModels = models.length !== providerModels.length
              const expanded = expandedProviders.has(provider)

              return (
                <tbody key={provider} className="cu-llm-model-group">
                  <tr className="cu-llm-model-group__row">
                    <td colSpan={modelColumns.length}>
                      <button
                        type="button"
                        className="cu-llm-model-group__toggle"
                        onClick={() => toggleProvider(provider)}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${providerLabel} models`}
                      >
                        <span className="cu-llm-model-group__chevron" aria-hidden="true">
                          <IconChevronRight
                            className={expanded ? 'is-expanded' : undefined}
                            width={18}
                            height={18}
                          />
                        </span>
                        <LlmProviderIcon provider={provider} label={providerLabel} />
                        <span className="cu-llm-model-group__provider">{providerLabel}</span>
                        <span className="cu-llm-model-group__count">
                          {providerModels.length} model{providerModels.length === 1 ? '' : 's'}
                        </span>
                        <span className="cu-llm-model-group__summary">
                          {enabledCount} enabled
                          {staleCount > 0 ? ` · ${staleCount} stale` : ''}
                          {hasFilteredModels ? ` · ${models.length} matching` : ''}
                        </span>
                        <span className="cu-llm-model-group__action" aria-hidden="true">
                          {expanded ? 'Hide models' : 'Show models'}
                        </span>
                      </button>
                    </td>
                  </tr>
                  {expanded
                    ? models.map((model: LlmAllowedModel) => (
                        <tr key={model.id} className="cu-table__row cu-llm-model-row">
                          <td className="cu-px-model">
                            <span className="cu-px-model-content">
                              {model.model}
                              {isUnpricedAllowedModel(model, unpricedKeys) ? (
                                <MissingPriceWarning
                                  provider={model.provider}
                                  model={model.model}
                                />
                              ) : null}
                            </span>
                          </td>
                          <td>{model.vendor || '—'}</td>
                          <td>{model.display_name || '—'}</td>
                          <td className="cu-px-num">
                            {formatContextWindow(model.context_window_tokens)}
                          </td>
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
                                title="Missing from the latest live provider catalog. It remains available when enabled until an operator disables or removes it."
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
                      ))
                    : null}
                </tbody>
              )
            })}
          </table>
        </div>
      )}
    </div>
  )
}
