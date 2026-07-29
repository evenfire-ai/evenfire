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
import type { TableHeaderColumn, TableSortDirection } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconPencil, IconRefresh, IconX } from './icons'
import { SelectInput } from './ui'

type ModelSortKey =
  | 'provider'
  | 'model'
  | 'vendor'
  | 'displayName'
  | 'contextWindow'
  | 'enabled'
  | 'source'
  | 'stale'

// A column may only opt into sorting if its key is one `compareByKey` knows how
// to order — marking `sortable: true` on any other column is a compile error,
// so MODEL_COLUMNS and the comparator cannot drift apart.
type ModelColumn = TableHeaderColumn &
  ({ sortable: true; key: ModelSortKey } | { sortable?: false })

const MODEL_COLUMNS: ModelColumn[] = [
  { key: 'provider', label: 'Provider', width: '10%', sortable: true },
  { key: 'model', label: 'Model', minWidth: '12rem', sortable: true },
  { key: 'vendor', label: 'Vendor', width: '10rem', sortable: true },
  { key: 'displayName', label: 'Display name', minWidth: '10rem', sortable: true },
  {
    key: 'contextWindow',
    label: 'Context window',
    align: 'right',
    width: '9rem',
    sortable: true,
  },
  { key: 'enabled', label: 'Enabled', width: '6rem', sortable: true },
  { key: 'source', label: 'Source', width: '7rem', sortable: true },
  { key: 'stale', label: 'Stale', width: '6rem', sortable: true },
  { key: 'actions', width: '5rem', align: 'right', ariaLabel: 'Actions' },
]

const ALL_PROVIDERS = '__all__'

type EnabledFilter = 'all' | 'enabled' | 'disabled'
type SourceFilter = 'all' | 'manual' | 'discovery'

const SORTABLE_KEYS: ReadonlySet<ModelSortKey> = new Set(
  MODEL_COLUMNS.flatMap(column => (column.sortable ? [column.key] : []))
)

function isModelSortKey(key: string): key is ModelSortKey {
  return (SORTABLE_KEYS as ReadonlySet<string>).has(key)
}

// Rows with no value for the sorted column always sink to the bottom, in both
// directions — flipping the direction must not promote "—" cells to the top.
// Returns null when both sides have a value and the caller must compare them.
function compareBlankLast(aBlank: boolean, bBlank: boolean): number | null {
  if (aBlank && bBlank) return 0
  if (aBlank) return 1
  if (bBlank) return -1
  return null
}

function isBlankText(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === ''
}

// Mirrors `formatContextWindow`, which renders '—' for null/undefined AND for
// any non-finite number — a NaN off the wire must sink with the empty cells,
// not land mid-table.
function isBlankNumber(value: number | null | undefined): boolean {
  return !Number.isFinite(value)
}

function compareByKey(
  a: LlmAllowedModel,
  b: LlmAllowedModel,
  key: ModelSortKey,
  dir: TableSortDirection
): number {
  const sign = dir === 'asc' ? 1 : -1
  switch (key) {
    case 'provider':
      // Sort on the label the operator actually reads, not the raw slug.
      return (
        sign *
        getProviderDisplayLabel(a.provider).localeCompare(getProviderDisplayLabel(b.provider))
      )
    case 'model':
      return sign * a.model.localeCompare(b.model)
    case 'vendor': {
      const blank = compareBlankLast(isBlankText(a.vendor), isBlankText(b.vendor))
      if (blank !== null) return blank
      return sign * String(a.vendor).localeCompare(String(b.vendor))
    }
    case 'displayName': {
      const blank = compareBlankLast(isBlankText(a.display_name), isBlankText(b.display_name))
      if (blank !== null) return blank
      return sign * String(a.display_name).localeCompare(String(b.display_name))
    }
    case 'contextWindow': {
      const blank = compareBlankLast(
        isBlankNumber(a.context_window_tokens),
        isBlankNumber(b.context_window_tokens)
      )
      if (blank !== null) return blank
      return sign * (Number(a.context_window_tokens) - Number(b.context_window_tokens))
    }
    case 'enabled':
      // false < true, so ascending lists Disabled before Enabled.
      return sign * (Number(a.enabled) - Number(b.enabled))
    case 'source':
      // Legacy rows without `source` render as Manual — sort them the same way.
      return sign * (a.source ?? 'manual').localeCompare(b.source ?? 'manual')
    case 'stale':
      return sign * (Number(a.stale === true) - Number(b.stale === true))
    default: {
      // `strict` is off in this project, so a missing case would otherwise
      // return undefined silently. This makes it a compile error.
      const exhaustive: never = key
      return exhaustive
    }
  }
}

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
  // null = untouched, keep the order the API returned.
  const [sortKey, setSortKey] = useState<ModelSortKey | null>(null)
  const [sortDir, setSortDir] = useState<TableSortDirection>('asc')
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

  // Sorting runs on the already-filtered subset, so filters stay applied by
  // construction and the header count keeps tracking `filteredItems`.
  const sortedItems = useMemo(() => {
    if (!sortKey) return filteredItems
    return [...filteredItems].sort((a, b) => {
      const primary = compareByKey(a, b, sortKey, sortDir)
      if (primary !== 0) return primary
      // Deliberate secondary order for rows that tie on the sorted column:
      // provider then model, always ascending, so a tied group still reads
      // top-to-bottom the way the Provider column is labelled. Reuses the
      // provider comparator so the tie-break sorts on the display label
      // ("Anthropic"), not the raw slug ("claude").
      const byProvider = compareByKey(a, b, 'provider', 'asc')
      if (byProvider !== 0) return byProvider
      return a.model.localeCompare(b.model)
    })
  }, [filteredItems, sortKey, sortDir])

  function toggleSort(nextKey: string) {
    if (!isModelSortKey(nextKey)) return
    if (sortKey === nextKey) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(nextKey)
    setSortDir('asc')
  }

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
              <TableHeaderRow
                columns={MODEL_COLUMNS}
                sortKey={sortKey}
                sortDir={sortDir}
                onSortToggle={toggleSort}
              />
            </thead>
            <tbody>
              {sortedItems.map((model: LlmAllowedModel) => (
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
