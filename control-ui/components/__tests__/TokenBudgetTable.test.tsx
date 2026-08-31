import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { TokenBudget } from '../../lib/api'
import { TokenBudgetTable } from '../TokenBudgetTable'

const budgets: TokenBudget[] = [
  {
    id: 'budget-1',
    name: 'Monthly OpenAI cap',
    enabled: true,
    scope: { provider: ['openai'], team_id: ['team-1'] },
    unit: 'cost',
    currency: 'USD',
    limit_amount: 100,
    period: 'monthly',
    timezone: 'UTC',
    min_start_amount: 0,
    max_task_amount: null,
    enforcement: 'warn',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    spent: 25,
    remaining: 75,
    unpriced: [],
  },
]

function renderTable(overrides: Partial<React.ComponentProps<typeof TokenBudgetTable>> = {}) {
  return render(
    <TokenBudgetTable
      items={budgets}
      lookups={{ team: { 'team-1': 'Acme' }, user: {} }}
      onCreate={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onToggle={vi.fn().mockResolvedValue(undefined)}
      onRefresh={vi.fn()}
      deletingId={null}
      togglingId={null}
      refreshing={false}
      {...overrides}
    />
  )
}

describe('TokenBudgetTable', () => {
  it('navigates budget rows by pointer and keyboard while isolating row controls', () => {
    const onEdit = vi.fn()
    const onToggle = vi.fn().mockResolvedValue(undefined)
    renderTable({ onEdit, onToggle })

    const row = screen.getByText('Monthly OpenAI cap').closest('tr')
    expect(row).toHaveAttribute('tabindex', '0')
    fireEvent.click(row!)
    fireEvent.keyDown(row!, { key: 'Enter' })
    fireEvent.keyDown(row!, { key: ' ' })
    expect(onEdit).toHaveBeenCalledTimes(3)

    fireEvent.click(screen.getByRole('button', { name: 'Disable budget Monthly OpenAI cap' }))
    fireEvent.click(screen.getByRole('button', { name: 'Actions for budget Monthly OpenAI cap' }))
    expect(onToggle).toHaveBeenCalledWith(budgets[0])
    expect(onEdit).toHaveBeenCalledTimes(3)
  })

  it('renders a budget row with readable scope, unit, and period', () => {
    renderTable()
    expect(screen.getByText('Monthly OpenAI cap')).toBeInTheDocument()
    // provider resolves to its display label, team_id resolves via lookups.
    expect(screen.getByText('OpenAI')).toBeInTheDocument()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('Cost')).toBeInTheDocument()
    expect(screen.getByText('Monthly')).toBeInTheDocument()
  })

  it('renders "Global" for an empty scope', () => {
    const global: TokenBudget = { ...budgets[0], id: 'budget-2', scope: {} }
    renderTable({ items: [global] })
    expect(screen.getByText('Global')).toBeInTheDocument()
  })

  it('shows the spent/limit progress in the budget currency', () => {
    renderTable()
    // Both spent ($25) and limit ($100) are formatted as currency.
    expect(screen.getByText(content => content.includes('25'))).toBeInTheDocument()
    expect(screen.getByText(content => content.includes('100'))).toBeInTheDocument()
  })

  it('invokes edit, delete, and toggle with the row', () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const onToggle = vi.fn().mockResolvedValue(undefined)
    renderTable({ onEdit, onDelete, onToggle })

    fireEvent.click(screen.getByRole('button', { name: 'Actions for budget Monthly OpenAI cap' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledWith('budget-1')

    fireEvent.click(screen.getByRole('button', { name: 'Actions for budget Monthly OpenAI cap' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith(budgets[0])

    fireEvent.click(screen.getByRole('button', { name: 'Disable budget Monthly OpenAI cap' }))
    expect(onToggle).toHaveBeenCalledWith(budgets[0])
  })

  it('filters rows by the search query', () => {
    renderTable()
    fireEvent.change(screen.getByLabelText('Search budgets'), { target: { value: 'tokens-only' } })
    expect(screen.queryByText('Monthly OpenAI cap')).not.toBeInTheDocument()
    expect(screen.getByText('No budgets match this search.')).toBeInTheDocument()
  })
})
