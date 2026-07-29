import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { LlmAllowedModel } from '../../lib/api'
import { LlmModelTable } from '../LlmModelTable'

const baseModel: LlmAllowedModel = {
  id: 'model-1',
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  vendor: 'Anthropic',
  display_name: 'Claude Sonnet 4.6',
  context_window_tokens: 200000,
  enabled: true,
  source: 'manual',
  stale: false,
  discovered_at: null,
  last_seen_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

function renderTable(items: LlmAllowedModel[]) {
  return render(
    <LlmModelTable
      items={items}
      unpricedKeys={new Set()}
      onCreate={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onRefresh={vi.fn()}
      deletingId={null}
      refreshing={false}
      loading={false}
    />
  )
}

describe('LlmModelTable catalog-lifecycle columns', () => {
  it('shows the Discovered badge for a discovery-sourced row', () => {
    renderTable([{ ...baseModel, source: 'discovery' }])
    expect(screen.getByText('Discovered')).toBeInTheDocument()
    expect(screen.queryByText('Manual')).not.toBeInTheDocument()
  })

  it('shows the Stale badge only when stale is true', () => {
    // 'Stale' is also the column header, so scope the assertion to the badge.
    renderTable([{ ...baseModel, id: 'm-stale', source: 'discovery', stale: true }])
    expect(screen.getByText('Stale', { selector: '.cu-px-badge--warn' })).toBeInTheDocument()
  })

  it('omits the Stale badge when stale is false', () => {
    renderTable([baseModel])
    expect(screen.queryByText('Stale', { selector: '.cu-px-badge--warn' })).toBeNull()
  })

  it('defaults a legacy row without source/stale to Manual and not stale', () => {
    // Simulate a pre-migration API row that omits the new catalog fields.
    const legacy = {
      id: 'legacy-1',
      provider: 'openai',
      model: 'gpt-4o',
      vendor: null,
      display_name: null,
      context_window_tokens: null,
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    } as LlmAllowedModel
    renderTable([legacy])
    expect(screen.getByText('Manual', { selector: '.cu-px-badge' })).toBeInTheDocument()
    expect(screen.queryByText('Discovered')).not.toBeInTheDocument()
    expect(screen.queryByText('Stale', { selector: '.cu-px-badge--warn' })).toBeNull()
  })
})

describe('LlmModelTable filters', () => {
  const enabledModel: LlmAllowedModel = {
    ...baseModel,
    id: 'm-enabled',
    model: 'claude-enabled',
    enabled: true,
    source: 'manual',
  }
  const disabledModel: LlmAllowedModel = {
    ...baseModel,
    id: 'm-disabled',
    model: 'claude-disabled',
    enabled: false,
    source: 'discovery',
  }

  it('filters by enabled state', () => {
    renderTable([enabledModel, disabledModel])
    expect(screen.getByText('claude-enabled')).toBeInTheDocument()
    expect(screen.getByText('claude-disabled')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter by enabled state'), {
      target: { value: 'disabled' },
    })
    expect(screen.queryByText('claude-enabled')).not.toBeInTheDocument()
    expect(screen.getByText('claude-disabled')).toBeInTheDocument()
  })

  it('filters by source when both kinds are present', () => {
    renderTable([enabledModel, disabledModel])
    fireEvent.change(screen.getByLabelText('Filter by source'), {
      target: { value: 'discovery' },
    })
    expect(screen.queryByText('claude-enabled')).not.toBeInTheDocument()
    expect(screen.getByText('claude-disabled')).toBeInTheDocument()
  })

  it('hides the source filter when only one source is present', () => {
    renderTable([enabledModel])
    expect(screen.queryByLabelText('Filter by source')).toBeNull()
  })

  it('shows the filtered empty state when no row matches', () => {
    renderTable([enabledModel])
    fireEvent.change(screen.getByLabelText('Filter by enabled state'), {
      target: { value: 'disabled' },
    })
    expect(screen.getByText('No models match this filter.')).toBeInTheDocument()
  })
})

describe('LlmModelTable sorting', () => {
  // Reads the rendered order of the Model column (tbody only).
  function rowModels(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('.cu-px-model')).map(cell =>
      (cell.textContent ?? '').trim()
    )
  }

  function sortButton(column: string) {
    return screen.getByRole('button', { name: new RegExp(`^Sort by ${column} `) })
  }

  const modelC: LlmAllowedModel = { ...baseModel, id: 'm-c', model: 'ccc' }
  const modelA: LlmAllowedModel = { ...baseModel, id: 'm-a', model: 'aaa' }
  const modelB: LlmAllowedModel = { ...baseModel, id: 'm-b', model: 'bbb' }

  it('keeps the server order until a header is clicked', () => {
    const { container } = renderTable([modelC, modelA, modelB])
    expect(rowModels(container)).toEqual(['ccc', 'aaa', 'bbb'])
    // Nothing is announced as sorted before the first click.
    expect(container.querySelector('th[aria-sort]')).toBeNull()
  })

  it('sorts ascending on the first click and inverts on the second', () => {
    const { container } = renderTable([modelC, modelA, modelB])

    fireEvent.click(sortButton('model'))
    expect(rowModels(container)).toEqual(['aaa', 'bbb', 'ccc'])
    expect(container.querySelector('th[aria-sort]')?.getAttribute('aria-sort')).toBe('ascending')

    fireEvent.click(sortButton('model'))
    expect(rowModels(container)).toEqual(['ccc', 'bbb', 'aaa'])
    expect(container.querySelector('th[aria-sort]')?.getAttribute('aria-sort')).toBe('descending')
  })

  it('switches to ascending when a different column becomes the sort key', () => {
    const { container } = renderTable([
      { ...baseModel, id: 'm-1', model: 'aaa', context_window_tokens: 300 },
      { ...baseModel, id: 'm-2', model: 'bbb', context_window_tokens: 100 },
      { ...baseModel, id: 'm-3', model: 'ccc', context_window_tokens: 200 },
    ])

    fireEvent.click(sortButton('model'))
    fireEvent.click(sortButton('model'))
    expect(rowModels(container)).toEqual(['ccc', 'bbb', 'aaa'])

    fireEvent.click(sortButton('context window'))
    expect(rowModels(container)).toEqual(['bbb', 'ccc', 'aaa'])
  })

  it('sorts only the filtered subset and keeps the filter applied', () => {
    const { container } = renderTable([
      { ...baseModel, id: 'm-1', model: 'zzz-on', enabled: true },
      { ...baseModel, id: 'm-2', model: 'mmm-off', enabled: false },
      { ...baseModel, id: 'm-3', model: 'aaa-on', enabled: true },
    ])

    fireEvent.change(screen.getByLabelText('Filter by enabled state'), {
      target: { value: 'enabled' },
    })
    fireEvent.click(sortButton('model'))

    expect(rowModels(container)).toEqual(['aaa-on', 'zzz-on'])
    expect(screen.queryByText('mmm-off')).not.toBeInTheDocument()
  })

  it('keeps the active sort when a filter changes', () => {
    const { container } = renderTable([
      { ...baseModel, id: 'm-1', model: 'zzz', enabled: true },
      { ...baseModel, id: 'm-2', model: 'aaa', enabled: true },
      { ...baseModel, id: 'm-3', model: 'mmm', enabled: false },
    ])

    fireEvent.click(sortButton('model'))
    fireEvent.click(sortButton('model'))
    expect(rowModels(container)).toEqual(['zzz', 'mmm', 'aaa'])

    fireEvent.change(screen.getByLabelText('Filter by enabled state'), {
      target: { value: 'enabled' },
    })
    // Still descending — narrowing the set must not reset the sort.
    expect(rowModels(container)).toEqual(['zzz', 'aaa'])
    expect(container.querySelector('th[aria-sort]')?.getAttribute('aria-sort')).toBe('descending')
  })

  it.each([
    ['vendor', 'vendor'] as const,
    ['display name', 'display_name'] as const,
    ['context window', 'context_window_tokens'] as const,
  ])('keeps rows with no %s last in both directions', (columnLabel, field) => {
    const withValue = field === 'context_window_tokens' ? 1000 : 'aaa'
    const withHigherValue = field === 'context_window_tokens' ? 2000 : 'zzz'
    const { container } = renderTable([
      { ...baseModel, id: 'm-1', model: 'low', [field]: withValue },
      { ...baseModel, id: 'm-2', model: 'none', [field]: null },
      { ...baseModel, id: 'm-3', model: 'high', [field]: withHigherValue },
    ])

    fireEvent.click(sortButton(columnLabel))
    expect(rowModels(container)).toEqual(['low', 'high', 'none'])

    fireEvent.click(sortButton(columnLabel))
    expect(rowModels(container)).toEqual(['high', 'low', 'none'])
  })

  it('does not turn the Actions column into a sort control', () => {
    renderTable([baseModel])
    expect(screen.queryByRole('button', { name: /^Sort by actions/ })).toBeNull()
  })
})
