'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { DataTable, TableStateRow, useTableSort } from '@clerum/frontend-table-system'
import type { LlmAllowedModel } from '@lib/api'
import { catalogGroupKey, formatContextWindow, getProviderDisplayLabel } from '@lib/llm'
import { isUnpricedAllowedModel } from '@lib/llmModelUnpriced'
import { FilterSelect } from './FilterSelect'
import type { LlmModelTableProps } from './LlmModelTable.types'
import { LlmProviderIcon } from './LlmProviderIcon'
import { MissingPriceWarning } from './MissingPriceWarning'
import { RowActionsMenu } from './RowActionsMenu'
import { SectionSearchInput } from './SectionSearchInput'
import { IconModels } from './Sidebar/icons'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh } from './icons'
import { SelectInput } from './ui'

type ModelSortKey =
  | 'provider'
  | 'model'
  | 'credential'
  | 'vendor'
  | 'displayName'
  | 'contextWindow'
  | 'enabled'
  | 'source'

const ALL_PROVIDERS = '__all__'

type DisplayModel = LlmAllowedModel & {
  credentialLabel: string
  apiKeyRow?: LlmAllowedModel
  subscriptionRow?: LlmAllowedModel
}

function collapseFamilyRows(family: string, models: LlmAllowedModel[]): DisplayModel[] {
  if (family !== 'openai') {
    return models.map(row => ({ ...row, credentialLabel: '' }))
  }
  const byName = new Map<string, LlmAllowedModel[]>()
  for (const row of models) {
    const list = byName.get(row.model) ?? []
    list.push(row)
    byName.set(row.model, list)
  }
  return Array.from(byName.entries()).map(([, rows]) => {
    const apiKey = rows.find(row => row.provider === 'openai')
    const subscription = rows.find(row => row.provider === 'codex-subscription')
    const primary = apiKey ?? subscription ?? rows[0]
    const parts: string[] = []
    if (apiKey) parts.push('API key')
    if (subscription) parts.push('Subscription')
    return {
      ...primary,
      credentialLabel: parts.join(' · '),
      apiKeyRow: apiKey,
      subscriptionRow: subscription,
    }
  })
}

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
  const normalizedSearch = searchQuery.trim().toLowerCase()

  const providerOptions = useMemo(() => {
    return Array.from(new Set(items.map(model => catalogGroupKey(model.provider)))).sort(
      (left, right) => getProviderDisplayLabel(left).localeCompare(getProviderDisplayLabel(right))
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
      if (providerFilter !== ALL_PROVIDERS && catalogGroupKey(model.provider) !== providerFilter) {
        return false
      }
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

  const displayItems = useMemo(() => {
    const groups = new Map<string, LlmAllowedModel[]>()
    for (const model of filteredItems) {
      const family = catalogGroupKey(model.provider)
      const group = groups.get(family)
      if (group) group.push(model)
      else groups.set(family, [model])
    }
    const collapsed: DisplayModel[] = []
    for (const [family, rows] of groups.entries()) {
      collapsed.push(...collapseFamilyRows(family, rows))
    }
    return collapsed
  }, [filteredItems])
  const modelSort = useTableSort<DisplayModel, ModelSortKey>({
    rows: displayItems,
    defaultKey: 'provider',
    defaultDirections: { contextWindow: 'desc' },
    identity: model => model.id,
    accessors: {
      provider: model => getProviderDisplayLabel(catalogGroupKey(model.provider)),
      model: model => model.model,
      credential: model => model.credentialLabel,
      vendor: model => model.vendor,
      displayName: model => model.display_name,
      contextWindow: model => model.context_window_tokens,
      enabled: model => model.enabled,
      source: model => `${model.source ?? 'manual'}/${model.stale ? 'stale' : 'current'}`,
    },
  })

  const hasActiveFilter =
    Boolean(normalizedSearch) ||
    providerFilter !== ALL_PROVIDERS ||
    enabledFilter !== 'all' ||
    sourceFilter !== 'all'

  const isInitialLoad = Boolean(loading) && items.length === 0

  function handleProviderFilterChange(nextProvider: string) {
    setProviderFilter(nextProvider)
  }

  const modelColumns: TableHeaderColumn[] = (
    [
      { key: 'provider', label: 'Provider', minWidth: '9rem' },
      { key: 'model', label: 'Model', minWidth: '15rem' },
      { key: 'credential', label: 'Credential', width: '11rem' },
      { key: 'vendor', label: 'Vendor', width: '10rem' },
      { key: 'displayName', label: 'Display name', minWidth: '10rem' },
      { key: 'contextWindow', label: 'Context window', align: 'right', width: '9rem' },
      { key: 'enabled', label: 'Enabled', width: '6rem' },
      { key: 'source', label: 'Source', width: '7rem' },
      { key: 'actions', width: '5rem', align: 'right', ariaLabel: 'Actions' },
    ] satisfies TableHeaderColumn[]
  ).map(column =>
    column.key === 'actions'
      ? column
      : {
          ...column,
          activeDirection: modelSort.key === column.key ? modelSort.direction : null,
          defaultDirection: column.key === 'contextWindow' ? 'desc' : 'asc',
          onSort: () => modelSort.sortBy(column.key as ModelSortKey),
        }
  )

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
        secondaryActions={
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
          </>
        }
        refreshAction={
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--toolbar"
            onClick={() => void onRefresh()}
            disabled={refreshing || isInitialLoad}
            aria-label={refreshing ? 'Refreshing…' : 'Reload models'}
          >
            <IconRefresh className={refreshing ? 'cu-spin' : undefined} width={18} height={18} />
          </button>
        }
        search={
          <SectionSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search models"
            ariaLabel="Search models"
            disabled={isInitialLoad}
          />
        }
        primaryAction={
          <button
            type="button"
            className="cu-btn cu-btn--primary cu-btn--sm"
            onClick={onCreate}
            disabled={isInitialLoad}
          >
            Add model
          </button>
        }
      />
      {navigation}
      <div className="eft-table-viewport cu-table-wrap cu-table-wrap--sticky-header">
        <DataTable className="eft-table cu-table cu-table--header-band cu-llm-model-table">
          <thead>
            <TableHeaderRow columns={modelColumns} />
          </thead>
          <tbody className="cu-llm-model-group">
            {isInitialLoad ? (
              <TableStateRow
                colSpan={modelColumns.length}
                kind="loading"
                message="Loading models…"
              />
            ) : filteredItems.length === 0 ? (
              <TableStateRow
                colSpan={modelColumns.length}
                message={
                  hasActiveFilter
                    ? 'No models match this filter.'
                    : 'No models in the allowlist yet. Add one to let agents and runtime use it.'
                }
              />
            ) : (
              modelSort.sortedRows.map((model: DisplayModel) => (
                <tr key={model.id} className="cu-table__row cu-llm-model-row">
                  <td>
                    <span className="cu-inline-icon-label">
                      <LlmProviderIcon
                        provider={catalogGroupKey(model.provider)}
                        label={getProviderDisplayLabel(catalogGroupKey(model.provider))}
                      />
                      {getProviderDisplayLabel(catalogGroupKey(model.provider))}
                    </span>
                  </td>
                  <td className="cu-px-model">
                    <span className="cu-px-model-content">
                      {model.model}
                      {isUnpricedAllowedModel(model, unpricedKeys) ? (
                        <MissingPriceWarning provider={model.provider} model={model.model} />
                      ) : null}
                    </span>
                  </td>
                  <td>{model.credentialLabel || '—'}</td>
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
                    <>
                      <span
                        className={
                          model.source === 'discovery'
                            ? 'cu-px-badge cu-px-badge--info'
                            : 'cu-px-badge cu-px-badge--off'
                        }
                      >
                        {model.source === 'discovery' ? 'Discovered' : 'Manual'}
                      </span>
                      {model.stale ? (
                        <>
                          {' '}
                          <span className="cu-px-badge cu-px-badge--warn">Stale</span>
                        </>
                      ) : null}
                    </>
                  </td>
                  <td className="cu-px-actions">
                    <RowActionsMenu
                      ariaLabel={`Actions for model ${model.provider}/${model.model}`}
                      horizontalTrigger
                      actions={
                        model.apiKeyRow && model.subscriptionRow
                          ? [
                              {
                                key: 'edit-api-key',
                                label: 'Edit API key',
                                onClick: () => onEdit(model.apiKeyRow!.id),
                              },
                              {
                                key: 'edit-subscription',
                                label: 'Edit subscription',
                                onClick: () => onEdit(model.subscriptionRow!.id),
                              },
                              {
                                key: 'delete-api-key',
                                label:
                                  deletingId === model.apiKeyRow.id
                                    ? 'Deleting…'
                                    : 'Delete API key',
                                danger: true,
                                disabled: deletingId === model.apiKeyRow.id,
                                onClick: () => void onDelete(model.apiKeyRow!),
                              },
                              {
                                key: 'delete-subscription',
                                label:
                                  deletingId === model.subscriptionRow.id
                                    ? 'Deleting…'
                                    : 'Delete subscription',
                                danger: true,
                                disabled: deletingId === model.subscriptionRow.id,
                                onClick: () => void onDelete(model.subscriptionRow!),
                              },
                            ]
                          : [
                              {
                                key: 'edit',
                                label: 'Edit',
                                onClick: () => onEdit(model.id),
                              },
                              {
                                key: 'delete',
                                label: deletingId === model.id ? 'Deleting…' : 'Delete',
                                danger: true,
                                disabled: deletingId === model.id,
                                onClick: () => void onDelete(model),
                              },
                            ]
                      }
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </DataTable>
      </div>
    </div>
  )
}
