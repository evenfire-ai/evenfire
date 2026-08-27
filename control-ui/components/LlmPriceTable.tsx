'use client'

import React, { useMemo, useState } from 'react'
import type { LlmModelPrice, UnpricedModel } from '@lib/api'
import { getProviderDisplayLabel } from '@lib/llm'
import type { LlmPriceTableProps } from './LlmPriceTable.types'
import { LlmProviderIcon } from './LlmProviderIcon'
import { MissingPriceWarning } from './MissingPriceWarning'
import { RowActionsMenu } from './RowActionsMenu'
import { SectionSearchInput } from './SectionSearchInput'
import { IconPrice } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh } from './icons'

const PRICE_COLUMNS: TableHeaderColumn[] = [
  { key: 'provider', label: 'Provider', width: '10%' },
  { key: 'model', label: 'Model', minWidth: '10rem' },
  { key: 'input', label: 'Input', align: 'right', title: 'Price per 1M input tokens' },
  { key: 'output', label: 'Output', align: 'right', title: 'Price per 1M output tokens' },
  {
    key: 'cacheRead',
    label: 'Cache read',
    align: 'right',
    title: 'Price per 1M cache-read tokens',
  },
  {
    key: 'cacheWrite',
    label: 'Cache write',
    align: 'right',
    title: 'Price per 1M cache-write tokens',
  },
  { key: 'currency', label: 'Currency', width: '6rem' },
  { key: 'enabled', label: 'Enabled', width: '6rem' },
  { key: 'actions', width: '5rem', align: 'right', ariaLabel: 'Actions' },
]

// Prices are stored per 1,000,000 tokens. Show up to 6 decimals but trim
// trailing zeros so common round values stay readable.
function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return '-'
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

export function LlmPriceTable({
  items,
  unpricedItems,
  onCreate,
  onAddMissingPrice,
  onEdit,
  onDelete,
  onRefresh,
  deletingId,
  refreshing,
  loading,
}: LlmPriceTableProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const normalizedSearch = searchQuery.trim().toLowerCase()

  const filteredPrices = useMemo(() => {
    if (!normalizedSearch) return items
    return items.filter(price =>
      [price.provider, getProviderDisplayLabel(price.provider), price.model, price.currency]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    )
  }, [items, normalizedSearch])

  const missingPriceItems = useMemo(() => {
    const seen = new Set<string>()
    return unpricedItems.filter(item => {
      const key = `${item.provider ?? ''}/${item.model}`
      if (seen.has(key)) return false
      seen.add(key)
      return !items.some(
        price =>
          price.model === item.model && (item.provider === null || price.provider === item.provider)
      )
    })
  }, [items, unpricedItems])

  const filteredMissingPriceItems = useMemo(() => {
    if (!normalizedSearch) return missingPriceItems
    return missingPriceItems.filter(item =>
      [
        item.provider ?? '',
        item.provider ? getProviderDisplayLabel(item.provider) : 'any provider',
        item.model,
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    )
  }, [missingPriceItems, normalizedSearch])

  const visibleRowCount = filteredPrices.length + filteredMissingPriceItems.length
  const isInitialLoad = Boolean(loading) && items.length === 0

  return (
    <div className="cu-card cu-card--viewport-fill cu-section-card">
      <TablePanelHeader
        title={
          <>
            <IconPrice />
            {isInitialLoad ? 'LLM Prices' : `LLM Prices (${visibleRowCount})`}
          </>
        }
        subtitle="Per-model token prices that back cost-unit budgets. Prices are per 1M tokens."
        actions={
          <>
            <SectionSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search prices"
              ariaLabel="Search prices"
              disabled={isInitialLoad}
            />
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              onClick={() => void onRefresh()}
              disabled={refreshing || isInitialLoad}
              aria-label={refreshing ? 'Refreshing…' : 'Reload prices'}
            >
              <IconRefresh className={refreshing ? 'cu-spin' : undefined} width={18} height={18} />
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={onCreate}
              disabled={isInitialLoad}
            >
              Add price
            </button>
          </>
        }
      />
      {isInitialLoad ? (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={PRICE_COLUMNS} />
            </thead>
            <tbody>
              <SkeletonTableRows columns={PRICE_COLUMNS.length} rows={4} />
            </tbody>
          </table>
        </div>
      ) : visibleRowCount === 0 ? (
        <div className="cu-empty">
          {normalizedSearch
            ? 'No prices match this search.'
            : 'No model prices configured yet. Add one to start tracking cost.'}
        </div>
      ) : (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={PRICE_COLUMNS} />
            </thead>
            <tbody>
              {filteredPrices.map((price: LlmModelPrice) => {
                const isUnpriced = unpricedItems.some(
                  item =>
                    item.model === price.model &&
                    (item.provider === null || price.provider === item.provider)
                )
                const providerLabel = getProviderDisplayLabel(price.provider)
                return (
                  <tr key={price.id} className="cu-table__row">
                    <td>
                      <span className="cu-px-provider">
                        <LlmProviderIcon provider={price.provider} label={providerLabel} />
                        {providerLabel}
                      </span>
                    </td>
                    <td className="cu-px-model">
                      <span className="cu-px-model-content">
                        {price.model}
                        {isUnpriced ? (
                          <MissingPriceWarning
                            provider={price.provider}
                            model={price.model}
                            priceId={price.id}
                          />
                        ) : null}
                      </span>
                    </td>
                    <td className="cu-px-num">{formatPrice(price.input_token_price)}</td>
                    <td className="cu-px-num">{formatPrice(price.output_token_price)}</td>
                    <td className="cu-px-num">{formatPrice(price.cache_read_token_price)}</td>
                    <td className="cu-px-num">{formatPrice(price.cache_write_token_price)}</td>
                    <td>{price.currency}</td>
                    <td>
                      <span
                        className={
                          price.enabled
                            ? 'cu-px-badge cu-px-badge--on'
                            : 'cu-px-badge cu-px-badge--off'
                        }
                      >
                        {price.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </td>
                    <td className="cu-px-actions">
                      <RowActionsMenu
                        ariaLabel={`Actions for price ${price.provider}/${price.model}`}
                        horizontalTrigger
                        actions={[
                          {
                            key: 'edit',
                            label: 'Edit',
                            onClick: () => onEdit(price.id),
                          },
                          {
                            key: 'delete',
                            label: deletingId === price.id ? 'Deleting price…' : 'Delete',
                            danger: true,
                            disabled: deletingId === price.id,
                            onClick: () => void onDelete(price),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                )
              })}
              {filteredMissingPriceItems.map((item: UnpricedModel) => {
                const label = item.provider
                  ? `${getProviderDisplayLabel(item.provider)}/${item.model}`
                  : item.model
                return (
                  <tr
                    key={`missing/${item.provider ?? ''}/${item.model}`}
                    className="cu-table__row cu-px-missing-row"
                  >
                    <td>
                      {item.provider ? (
                        <span className="cu-px-provider">
                          <LlmProviderIcon
                            provider={item.provider}
                            label={getProviderDisplayLabel(item.provider)}
                          />
                          {getProviderDisplayLabel(item.provider)}
                        </span>
                      ) : (
                        'Any provider'
                      )}
                    </td>
                    <td className="cu-px-model">
                      <span className="cu-px-model-content">
                        {item.model}
                        <MissingPriceWarning provider={item.provider} model={item.model} />
                      </span>
                    </td>
                    <td className="cu-px-num">—</td>
                    <td className="cu-px-num">—</td>
                    <td className="cu-px-num">—</td>
                    <td className="cu-px-num">—</td>
                    <td>—</td>
                    <td>
                      <span className="cu-px-badge cu-px-badge--warn">Missing</span>
                    </td>
                    <td className="cu-px-actions">
                      <RowActionsMenu
                        ariaLabel={`Actions for price ${label}`}
                        horizontalTrigger
                        actions={[
                          {
                            key: 'add',
                            label: 'Add price',
                            onClick: () => onAddMissingPrice(item),
                          },
                        ]}
                      />
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
