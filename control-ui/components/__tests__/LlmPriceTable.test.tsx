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
      onCreate={vi.fn()}
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

    fireEvent.click(screen.getByRole('button', { name: 'Edit price claude/claude-sonnet-4-6' }))
    expect(onEdit).toHaveBeenCalledWith('price-1')

    fireEvent.click(screen.getByRole('button', { name: 'Delete price claude/claude-sonnet-4-6' }))
    expect(onDelete).toHaveBeenCalledWith(prices[0])
  })

  it('filters rows by the search query', () => {
    renderTable()
    fireEvent.change(screen.getByLabelText('Search prices'), { target: { value: 'openai' } })
    expect(screen.queryByText('claude-sonnet-4-6')).not.toBeInTheDocument()
    expect(screen.getByText('No prices match this search.')).toBeInTheDocument()
  })

  it('renders the banner slot inside the card, after the panel header (not above it)', () => {
    const { container } = renderTable({
      banner: <div data-testid="unpriced-banner">2 models have no price</div>,
    })
    const card = container.querySelector('.cu-card')
    const slot = container.querySelector('.cu-px-unpriced-slot')
    // The banner lives in the in-card slot so it can't push the page layout.
    expect(slot).not.toBeNull()
    expect(card?.contains(slot as Node)).toBe(true)
    expect(slot?.querySelector('[data-testid="unpriced-banner"]')).not.toBeNull()
    // Slot must come after the sticky panel header inside the card.
    const head = card?.querySelector('.cu-table-panel__head') as HTMLElement
    expect(
      head.compareDocumentPosition(slot as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('omits the banner slot when no banner is provided', () => {
    const { container } = renderTable()
    expect(container.querySelector('.cu-px-unpriced-slot')).toBeNull()
  })
})
