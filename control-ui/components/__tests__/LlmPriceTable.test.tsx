import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { LlmModelPrice } from '../../lib/api'
import { LlmPriceTable } from '../LlmPriceTable'

const prices: LlmModelPrice[] = [
  {
    id: 'price-1',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    input_token_price: 3,
    output_token_price: 15,
    cache_read_token_price: 0.3,
    cache_write_token_price: 3.75,
    currency: 'USD',
    effective_from: '2026-01-01T00:00:00.000Z',
    enabled: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
]

function renderTable(overrides: Partial<React.ComponentProps<typeof LlmPriceTable>> = {}) {
  return render(
    <LlmPriceTable
      items={prices}
      unpricedItems={[]}
      onCreate={vi.fn()}
      onAddMissingPrice={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onRefresh={vi.fn()}
      deletingId={null}
      refreshing={false}
      {...overrides}
    />
  )
}

describe('LlmPriceTable', () => {
  it('navigates priced rows by pointer and keyboard without activating from the menu trigger', () => {
    const onEdit = vi.fn()
    renderTable({ onEdit })

    const row = screen.getByText('claude-sonnet-4-6').closest('tr')
    expect(row).toHaveAttribute('tabindex', '0')
    fireEvent.click(row!)
    fireEvent.keyDown(row!, { key: 'Enter' })
    fireEvent.keyDown(row!, { key: ' ' })
    expect(onEdit).toHaveBeenCalledTimes(3)

    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for price claude/claude-sonnet-4-6' })
    )
    expect(onEdit).toHaveBeenCalledTimes(3)
  })

  it('renders a priced row with the provider label and prices', () => {
    renderTable()
    expect(screen.getByText('Anthropic')).toBeInTheDocument()
    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument()
    expect(screen.getByText('USD')).toBeInTheDocument()
  })

  it('shows an unrecognized provider verbatim instead of mislabeling it', () => {
    // A provider id NOT in the canonical registry (R6 expanded it to 21, so use
    // a clearly-fictitious id) must render verbatim, never mislabeled.
    const unknown: LlmModelPrice = { ...prices[0], id: 'price-2', provider: 'acme-labs' }
    renderTable({ items: [unknown] })
    expect(screen.getByText('acme-labs')).toBeInTheDocument()
    expect(screen.queryByText('OpenAI')).not.toBeInTheDocument()
  })

  it('invokes edit and delete with the row id', () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    renderTable({ onEdit, onDelete })

    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for price claude/claude-sonnet-4-6' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledWith('price-1')

    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for price claude/claude-sonnet-4-6' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith(prices[0])
  })

  it('filters rows by the search query', () => {
    renderTable()
    fireEvent.change(screen.getByLabelText('Search prices'), { target: { value: 'openai' } })
    expect(screen.queryByText('claude-sonnet-4-6')).not.toBeInTheDocument()
    expect(screen.getByText('No prices match this search.')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /provider/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /model/i })).toBeInTheDocument()
  })

  it('renders an unpriced model as a compact missing row with an add-price warning', () => {
    const onAddMissingPrice = vi.fn()
    renderTable({
      unpricedItems: [{ provider: 'openai', model: 'gpt-5' }],
      onAddMissingPrice,
    })

    expect(screen.getByText('gpt-5')).toBeInTheDocument()
    expect(screen.getByText('Missing')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'OpenAI/gpt-5 has no enabled price' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Add price' })).toHaveAttribute(
      'href',
      '/cost-and-usage/llm-prices/new?provider=openai&model=gpt-5'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for price OpenAI/gpt-5' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add price' }))
    expect(onAddMissingPrice).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5' })
  })

  it('decorates an existing unpriced price row without duplicating it', () => {
    renderTable({
      unpricedItems: [{ provider: 'claude', model: 'claude-sonnet-4-6' }],
    })

    expect(screen.getAllByText('claude-sonnet-4-6')).toHaveLength(1)
    expect(
      screen.getByRole('button', {
        name: 'Anthropic/claude-sonnet-4-6 has no enabled price',
      })
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'Review price' })).toHaveAttribute(
      'href',
      '/cost-and-usage/llm-prices/price-1/edit'
    )
    expect(screen.queryByText('Missing')).toBeNull()
  })

  it('supports an unpriced model without a specific provider', () => {
    renderTable({
      items: [],
      unpricedItems: [{ provider: null, model: 'shared-model' }],
    })

    expect(screen.getByText('Any provider')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add price' })).toHaveAttribute(
      'href',
      '/cost-and-usage/llm-prices/new?model=shared-model'
    )
  })

  it('sorts priced and missing rows as one global result set', () => {
    renderTable({
      items: [{ ...prices[0], provider: 'acme-labs', model: 'configured-model' }],
      unpricedItems: [{ provider: 'openai', model: 'missing-model' }],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Provider descending' }))

    const rows = screen.getByRole('table').querySelectorAll('tbody tr')
    expect(rows[0]).toHaveTextContent('OpenAI')
    expect(rows[1]).toHaveTextContent('acme-labs')
  })
})
