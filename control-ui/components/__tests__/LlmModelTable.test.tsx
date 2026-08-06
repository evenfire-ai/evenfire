import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function renderTable(items: LlmAllowedModel[], unpricedKeys = new Set<string>()) {
  return render(
    <LlmModelTable
      items={items}
      unpricedKeys={unpricedKeys}
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

function expandAnthropicModels() {
  fireEvent.click(screen.getByRole('button', { name: 'Expand Anthropic models' }))
}

describe('LlmModelTable catalog-lifecycle columns', () => {
  it('shows the Discovered badge for a discovery-sourced row', () => {
    renderTable([{ ...baseModel, source: 'discovery' }])
    expandAnthropicModels()
    expect(screen.getByText('Discovered')).toBeInTheDocument()
    expect(screen.queryByText('Manual')).not.toBeInTheDocument()
  })

  it('shows the Stale badge only when stale is true', () => {
    // 'Stale' is also the column header, so scope the assertion to the badge.
    renderTable([{ ...baseModel, id: 'm-stale', source: 'discovery', stale: true }])
    expandAnthropicModels()
    expect(screen.getByText('Stale', { selector: '.cu-px-badge--warn' })).toBeInTheDocument()
  })

  it('omits the Stale badge when stale is false', () => {
    renderTable([baseModel])
    expandAnthropicModels()
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
    fireEvent.click(screen.getByRole('button', { name: 'Expand OpenAI models' }))
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
    expandAnthropicModels()
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
    expandAnthropicModels()
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

  it('clears a selected provider when that provider disappears', async () => {
    const openAiModel = {
      ...enabledModel,
      id: 'openai-model',
      provider: 'openai',
      model: 'gpt-5',
      vendor: 'OpenAI',
      display_name: 'GPT-5',
    }
    const view = renderTable([enabledModel, openAiModel])

    fireEvent.click(screen.getByRole('button', { name: 'Filter by provider' }))
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI' }))
    expect(screen.getByText('gpt-5')).toBeInTheDocument()

    view.rerender(
      <LlmModelTable
        items={[enabledModel]}
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

    await waitFor(() => {
      expect(screen.queryByLabelText('Filter by provider')).toBeNull()
      expect(screen.getByRole('button', { name: 'Expand Anthropic models' })).toBeInTheDocument()
    })
    expect(screen.queryByText('No models match this filter.')).toBeNull()
  })

  it('clears a selected provider that disappears while other providers remain', async () => {
    const openAiModel = {
      ...enabledModel,
      id: 'openai-model',
      provider: 'openai',
      model: 'gpt-5',
      vendor: 'OpenAI',
      display_name: 'GPT-5',
    }
    const googleModel = {
      ...enabledModel,
      id: 'google-model',
      provider: 'google',
      model: 'gemini-2.5-pro',
      vendor: 'Google',
      display_name: 'Gemini 2.5 Pro',
    }
    const view = renderTable([enabledModel, openAiModel, googleModel])

    fireEvent.click(screen.getByRole('button', { name: 'Filter by provider' }))
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI' }))

    view.rerender(
      <LlmModelTable
        items={[enabledModel, googleModel]}
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

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Filter by provider' })).toHaveTextContent(
        'All providers'
      )
    })
    expect(screen.queryByText('No models match this filter.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand Anthropic models' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand Google models' })).toBeInTheDocument()
  })

  it('shows the filtered empty state when no row matches', () => {
    renderTable([enabledModel])
    fireEvent.change(screen.getByLabelText('Filter by enabled state'), {
      target: { value: 'disabled' },
    })
    expect(screen.getByText('No models match this filter.')).toBeInTheDocument()
  })
})

describe('LlmModelTable provider groups', () => {
  const openAiModel: LlmAllowedModel = {
    ...baseModel,
    id: 'openai-model',
    provider: 'openai',
    model: 'gpt-5',
    vendor: 'OpenAI',
    display_name: 'GPT-5',
  }

  it('starts with compact provider summaries and expands groups independently', () => {
    renderTable([baseModel, openAiModel])

    expect(screen.getByRole('button', { name: 'Expand Anthropic models' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.getByRole('button', { name: 'Expand OpenAI models' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByText('claude-sonnet-4-6')).toBeNull()
    expect(screen.queryByText('gpt-5')).toBeNull()

    expandAnthropicModels()

    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument()
    expect(screen.queryByText('gpt-5')).toBeNull()
    expect(screen.getByRole('button', { name: 'Collapse Anthropic models' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('surfaces stale counts in the collapsed provider summary', () => {
    renderTable([{ ...baseModel, source: 'discovery', stale: true }])

    expect(screen.getByRole('button', { name: 'Expand Anthropic models' })).toHaveTextContent(
      '1 stale'
    )
  })

  it('opens matching groups while searching and shows the match count', () => {
    renderTable([
      baseModel,
      openAiModel,
      {
        ...openAiModel,
        id: 'openai-model-2',
        model: 'o3',
        display_name: 'O3',
      },
    ])

    fireEvent.change(screen.getByLabelText('Search models'), {
      target: { value: 'gpt-5' },
    })

    expect(screen.getByText('gpt-5')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Anthropic models/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Collapse OpenAI models' })).toHaveTextContent(
      '2 models'
    )
    expect(screen.getByRole('button', { name: 'Collapse OpenAI models' })).toHaveTextContent(
      '1 matching'
    )
  })

  it('opens a provider selected from the provider filter', () => {
    renderTable([baseModel, openAiModel])

    fireEvent.click(screen.getByRole('button', { name: 'Filter by provider' }))
    const openAiOption = screen.getByRole('option', { name: 'OpenAI' })
    expect(openAiOption.querySelector('img')).toHaveAttribute('src', '/provider-icons/openai.svg')
    fireEvent.click(openAiOption)

    expect(screen.getByText('gpt-5')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filter by provider' })).toHaveTextContent('OpenAI')
    expect(
      screen.getByRole('button', { name: 'Filter by provider' }).querySelector('img')
    ).toHaveAttribute('src', '/provider-icons/openai.svg')
    expect(screen.queryByRole('button', { name: /Anthropic models/ })).toBeNull()
  })

  it('shows missing-price details and a prefilled CTA only on the affected row', () => {
    renderTable([baseModel, openAiModel], new Set(['claude/claude-sonnet-4-6']))
    expandAnthropicModels()

    expect(
      screen.getByRole('button', {
        name: 'Anthropic/claude-sonnet-4-6 has no enabled price',
      })
    ).toBeVisible()
    expect(screen.getByRole('note')).toHaveTextContent('No enabled price')
    expect(screen.getByRole('note')).toHaveTextContent(
      'Cost budgets may under-count spend for this model.'
    )
    expect(screen.getByRole('link', { name: 'Add price' })).toHaveAttribute(
      'href',
      '/cost-and-usage/llm-prices/new?provider=claude&model=claude-sonnet-4-6'
    )
    expect(screen.queryByText(/allowed models? have no enabled price/i)).toBeNull()
  })
})

describe('LlmModelTable sorting', () => {
  const newModel = (overrides: Partial<LlmAllowedModel>): LlmAllowedModel => ({
    ...baseModel,
    id: overrides.id ?? baseModel.id,
    ...overrides,
  })

  function expandedRowOrder(): string[] {
    const rows = document.querySelectorAll('tr.cu-llm-model-row')
    return Array.from(rows).map(row => {
      const cell = row.querySelector('td.cu-px-model')
      return cell?.textContent?.trim() ?? ''
    })
  }

  it('keeps the static LLM Models title regardless of filters', () => {
    renderTable([baseModel])
    expect(document.querySelector('.cu-panel-title')?.textContent).toContain('LLM Models')
  })

  it('sorts models inside a provider group by model name when ascending', () => {
    const alpha = newModel({ id: 'a', model: 'alpha', display_name: 'Alpha' })
    const bravo = newModel({ id: 'b', model: 'bravo', display_name: 'Bravo' })
    const charlie = newModel({ id: 'c', model: 'charlie', display_name: 'Charlie' })
    renderTable([charlie, alpha, bravo])
    expandAnthropicModels()

    fireEvent.click(screen.getByRole('button', { name: 'Sort by model ascending' }))

    expect(expandedRowOrder()).toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('toggles a sort header to descending on the second click', () => {
    const alpha = newModel({ id: 'a', model: 'alpha' })
    const bravo = newModel({ id: 'b', model: 'bravo' })
    renderTable([alpha, bravo])
    expandAnthropicModels()

    const modelSort = screen.getByRole('button', { name: 'Sort by model ascending' })
    fireEvent.click(modelSort)
    expect(expandedRowOrder()).toEqual(['alpha', 'bravo'])

    fireEvent.click(screen.getByRole('button', { name: 'Sort by model descending' }))
    expect(expandedRowOrder()).toEqual(['bravo', 'alpha'])
  })

  it('sorts context window descending by default and pushes null values to the end', () => {
    const small = newModel({ id: 's', model: 'small', context_window_tokens: 8_000 })
    const large = newModel({ id: 'l', model: 'large', context_window_tokens: 1_000_000 })
    const unknown = newModel({ id: 'u', model: 'unknown', context_window_tokens: null })
    renderTable([small, large, unknown])
    expandAnthropicModels()

    fireEvent.click(screen.getByRole('button', { name: 'Sort by context window descending' }))

    expect(expandedRowOrder()).toEqual(['large', 'small', 'unknown'])
  })

  it('resets to the natural default direction when switching sort columns', () => {
    const alpha = newModel({ id: 'a', model: 'alpha', context_window_tokens: 100 })
    const bravo = newModel({ id: 'b', model: 'bravo', context_window_tokens: 200 })
    renderTable([alpha, bravo])
    expandAnthropicModels()

    // Model asc (default for text columns).
    fireEvent.click(screen.getByRole('button', { name: 'Sort by model ascending' }))
    expect(expandedRowOrder()).toEqual(['alpha', 'bravo'])

    // Switching to context window uses its natural default (descending) — not
    // the previous direction — so the operator gets the most useful ordering.
    fireEvent.click(screen.getByRole('button', { name: 'Sort by context window descending' }))
    expect(expandedRowOrder()).toEqual(['bravo', 'alpha'])
  })
})
