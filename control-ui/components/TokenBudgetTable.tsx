'use client'

import React, { useMemo, useState } from 'react'
import { DataTable } from '@clerum/frontend-table-system'
import type { TokenBudget } from '@lib/api'
import {
  budgetProgressPercent,
  enforcementLabel,
  formatBudgetAmount,
  formatBudgetScope,
  periodLabel,
} from '@lib/budgets'
import { RowActionsMenu } from './RowActionsMenu'
import { SectionSearchInput } from './SectionSearchInput'
import { IconBudget } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import type { TokenBudgetTableProps } from './TokenBudgetTable.types'
import { IconRefresh } from './icons'

const BUDGET_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name', minWidth: '9rem' },
  { key: 'scope', label: 'Scope', minWidth: '12rem' },
  { key: 'unit', label: 'Unit', width: '6rem' },
  { key: 'period', label: 'Period', width: '7rem' },
  { key: 'progress', label: 'Spent / Limit', minWidth: '12rem' },
  {
    key: 'enforcement',
    label: 'Mode',
    width: '5.5rem',
    title: 'Block denies tasks over the limit; Warn only observes',
  },
  { key: 'enabled', label: 'Enabled', width: '6rem' },
  { key: 'actions', width: '8rem', align: 'right', ariaLabel: 'Actions' },
]

export function TokenBudgetTable({
  items,
  lookups,
  onCreate,
  onEdit,
  onDelete,
  onToggle,
  onRefresh,
  deletingId,
  togglingId,
  refreshing,
  loading,
}: TokenBudgetTableProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const normalizedSearch = searchQuery.trim().toLowerCase()

  const filteredItems = useMemo(() => {
    if (!normalizedSearch) return items
    return items.filter(budget => {
      const scopeText = formatBudgetScope(budget.scope, lookups)
        .map(segment => `${segment.label} ${segment.values.join(' ')}`)
        .join(' ')
      return [budget.name, budget.unit, budget.period, scopeText]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    })
  }, [items, lookups, normalizedSearch])

  const isInitialLoad = Boolean(loading) && items.length === 0

  return (
    <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
      <TablePanelHeader
        title={
          <>
            <IconBudget />
            {isInitialLoad ? 'Token Budgets' : `Token Budgets (${filteredItems.length})`}
          </>
        }
        subtitle="Spend caps per dimension, shown against live usage. P0c runs in observation mode (warn)."
        actions={
          <>
            <SectionSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search budgets"
              ariaLabel="Search budgets"
              disabled={isInitialLoad}
            />
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              onClick={() => void onRefresh()}
              disabled={refreshing || isInitialLoad}
              aria-label={refreshing ? 'Refreshing…' : 'Reload budgets'}
            >
              <IconRefresh className={refreshing ? 'cu-spin' : undefined} width={18} height={18} />
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={onCreate}
              disabled={isInitialLoad}
            >
              New budget
            </button>
          </>
        }
      />
      {isInitialLoad ? (
        <div className="eft-table-viewport cu-table-wrap">
          <DataTable className="eft-table cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={BUDGET_COLUMNS} />
            </thead>
            <tbody>
              <SkeletonTableRows columns={BUDGET_COLUMNS.length} rows={4} />
            </tbody>
          </DataTable>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="cu-empty">
          {normalizedSearch
            ? 'No budgets match this search.'
            : 'No token budgets defined yet. Create one to start tracking spend against a limit.'}
        </div>
      ) : (
        <div className="eft-table-viewport cu-table-wrap">
          <DataTable className="eft-table cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={BUDGET_COLUMNS} />
            </thead>
            <tbody>
              {filteredItems.map((budget: TokenBudget) => (
                <BudgetRow
                  key={budget.id}
                  budget={budget}
                  lookups={lookups}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onToggle={onToggle}
                  deleting={deletingId === budget.id}
                  toggling={togglingId === budget.id}
                />
              ))}
            </tbody>
          </DataTable>
        </div>
      )}
    </div>
  )
}

function BudgetRow({
  budget,
  lookups,
  onEdit,
  onDelete,
  onToggle,
  deleting,
  toggling,
}: {
  budget: TokenBudget
  lookups: TokenBudgetTableProps['lookups']
  onEdit: (id: string) => void
  onDelete: (budget: TokenBudget) => Promise<void>
  onToggle: (budget: TokenBudget) => Promise<void>
  deleting: boolean
  toggling: boolean
}) {
  const segments = formatBudgetScope(budget.scope, lookups)
  const spent = budget.spent ?? 0
  const limit = budget.limit_amount
  const pct = budgetProgressPercent(spent, limit)
  const over = spent > limit && limit > 0
  const spentText = formatBudgetAmount(spent, budget.unit, budget.currency)
  const limitText = formatBudgetAmount(limit, budget.unit, budget.currency)

  return (
    <tr className="cu-table__row">
      <td className="cu-tb-name">{budget.name}</td>
      <td>
        {segments.length === 0 ? (
          <span className="cu-tb-scope-global">Global</span>
        ) : (
          <span className="cu-tb-scope">
            {segments.map(segment => (
              <span key={segment.key} className="cu-tb-scope-chip">
                <span className="cu-tb-scope-chip__key">{segment.label}</span>
                <span className="cu-tb-scope-chip__val">{segment.values.join(', ')}</span>
              </span>
            ))}
          </span>
        )}
      </td>
      <td>
        <span className="cu-tb-unit">{budget.unit === 'cost' ? 'Cost' : 'Tokens'}</span>
      </td>
      <td>{periodLabel(budget.period)}</td>
      <td>
        <div className="cu-tb-progress" title={`${spentText} of ${limitText}`}>
          <div className="cu-tb-progress__bar" aria-hidden="true">
            <div
              className={
                over ? 'cu-tb-progress__fill cu-tb-progress__fill--over' : 'cu-tb-progress__fill'
              }
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="cu-tb-progress__label">
            <span
              className={
                over ? 'cu-tb-progress__spent cu-tb-progress__spent--over' : 'cu-tb-progress__spent'
              }
            >
              {spentText}
            </span>
            <span className="cu-tb-progress__sep"> / </span>
            <span>{limitText}</span>
          </div>
        </div>
      </td>
      <td>
        <span
          className={
            budget.enforcement === 'block'
              ? 'cu-tb-enforce cu-tb-enforce--block'
              : 'cu-tb-enforce cu-tb-enforce--warn'
          }
          title={
            budget.enforcement === 'block'
              ? 'Block — denies tasks once over the limit'
              : 'Warn — observation only, never denies'
          }
        >
          {enforcementLabel(budget.enforcement)}
        </span>
      </td>
      <td>
        <button
          type="button"
          className={
            budget.enabled ? 'cu-tb-badge cu-tb-badge--on' : 'cu-tb-badge cu-tb-badge--off'
          }
          onClick={() => void onToggle(budget)}
          disabled={toggling}
          aria-pressed={budget.enabled}
          aria-label={
            budget.enabled ? `Disable budget ${budget.name}` : `Enable budget ${budget.name}`
          }
          title={budget.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
        >
          {budget.enabled ? 'Enabled' : 'Disabled'}
        </button>
      </td>
      <td className="cu-tb-actions">
        <RowActionsMenu
          ariaLabel={`Actions for budget ${budget.name}`}
          horizontalTrigger
          actions={[
            {
              key: 'edit',
              label: 'Edit',
              onClick: () => onEdit(budget.id),
            },
            {
              key: 'delete',
              label: deleting ? 'Deleting…' : 'Delete',
              danger: true,
              disabled: deleting,
              onClick: () => void onDelete(budget),
            },
          ]}
        />
      </td>
    </tr>
  )
}
