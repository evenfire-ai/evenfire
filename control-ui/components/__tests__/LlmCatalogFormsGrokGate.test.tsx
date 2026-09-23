import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import type { LlmAllowedModel, LlmModelPrice, TokenBudget } from '@lib/api'
import { loadGrokSubscriptionCapability } from '@lib/grokSubscriptionFeature'
import { LlmModelForm } from '../LlmModelForm'
import { LlmPriceForm } from '../LlmPriceForm'
import { TokenBudgetForm } from '../TokenBudgetForm'

// B-M7: the allowlist, price and budget forms list every runtime provider id.
// grok-subscription must stay hidden until the Control API Grok capability
// probe proves the flag on, while a saved Grok value stays visible "(disabled)".

vi.mock('@lib/grokSubscriptionFeature', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/grokSubscriptionFeature')>()
  return { ...actual, loadGrokSubscriptionCapability: vi.fn() }
})

vi.mock('@lib/hooks/useLlmAllowedModels', () => ({
  useLlmAllowedModels: () => ({ models: [], loading: false, error: '' }),
}))

vi.mock('@lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/api')>()
  return {
    ...actual,
    getAdminTeams: vi.fn().mockResolvedValue({ items: [] }),
    getAdminUsers: vi.fn().mockResolvedValue({ items: [] }),
    getHosts: vi.fn().mockResolvedValue({ items: [] }),
    getRecipeSecrets: vi.fn().mockResolvedValue({ items: [] }),
    getLlmPrices: vi.fn().mockResolvedValue({ rows: [] }),
  }
})

const GROK = 'grok-subscription'
const CODEX = 'codex-subscription'
const noop = () => undefined

const grokModel = {
  id: 'model-grok',
  provider: GROK,
  model: 'grok-4.6',
  vendor: 'xAI',
  display_name: null,
  context_window_tokens: null,
  enabled: true,
  source: 'discovery',
  stale: false,
  discovered_at: null,
  last_seen_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as LlmAllowedModel

const grokPrice = {
  id: 'price-grok',
  provider: GROK,
  model: 'grok-4.6',
  input_token_price: 0,
  output_token_price: 0,
  cache_read_token_price: 0,
  cache_write_token_price: 0,
  currency: 'USD',
  enabled: true,
} as unknown as LlmModelPrice

const grokBudget = {
  id: 'budget-grok',
  name: 'Grok cap',
  enabled: true,
  scope: { provider: [GROK] },
  unit: 'tokens',
  currency: null,
  limit_amount: 1000,
  period: 'monthly',
  timezone: 'UTC',
  min_start_amount: 0,
  max_task_amount: null,
  enforcement: 'warn',
} as unknown as TokenBudget

function optionValues(select: HTMLElement): string[] {
  return within(select)
    .getAllByRole('option')
    .map(option => (option as HTMLOptionElement).value)
}

function flushProbe() {
  return waitFor(() => expect(loadGrokSubscriptionCapability).toHaveBeenCalled())
}

type SelectForm = {
  name: string
  selectId: string
  renderCreate: () => void
  renderSavedGrok: () => void
}

const selectForms: SelectForm[] = [
  {
    name: 'LlmModelForm',
    selectId: 'llm-model-provider',
    renderCreate: () =>
      render(<LlmModelForm mode="create" saving={false} onSubmit={noop} onCancel={noop} />),
    renderSavedGrok: () =>
      render(
        <LlmModelForm
          mode="edit"
          initial={grokModel}
          saving={false}
          onSubmit={noop}
          onCancel={noop}
        />
      ),
  },
  {
    name: 'LlmPriceForm',
    selectId: 'llm-price-provider',
    renderCreate: () =>
      render(<LlmPriceForm mode="create" saving={false} onSubmit={noop} onCancel={noop} />),
    renderSavedGrok: () =>
      render(
        <LlmPriceForm
          mode="edit"
          initial={grokPrice}
          saving={false}
          onSubmit={noop}
          onCancel={noop}
        />
      ),
  },
]

beforeEach(() => {
  vi.mocked(loadGrokSubscriptionCapability).mockResolvedValue({ enabled: false })
})

afterEach(() => {
  cleanup()
  vi.mocked(loadGrokSubscriptionCapability).mockReset()
})

describe.each(selectForms)('$name Grok capability gate', form => {
  function providerSelect(): HTMLSelectElement {
    return document.getElementById(form.selectId) as HTMLSelectElement
  }

  it('hides grok-subscription when the probe reports disabled and keeps Codex', async () => {
    form.renderCreate()
    await flushProbe()
    await Promise.resolve()
    const values = optionValues(providerSelect())
    expect(values).not.toContain(GROK)
    expect(values).toContain(CODEX)
    expect(values).toContain('openai')
  })

  it('fails closed (no Grok option) when the probe throws', async () => {
    vi.mocked(loadGrokSubscriptionCapability).mockRejectedValue(new Error('probe boom'))
    form.renderCreate()
    await flushProbe()
    await Promise.resolve()
    expect(optionValues(providerSelect())).not.toContain(GROK)
  })

  it('offers grok-subscription once the probe reports enabled', async () => {
    vi.mocked(loadGrokSubscriptionCapability).mockResolvedValue({ enabled: true })
    form.renderCreate()
    await waitFor(() => expect(optionValues(providerSelect())).toContain(GROK))
    const grokOption = within(providerSelect())
      .getAllByRole('option')
      .find(option => (option as HTMLOptionElement).value === GROK)
    expect(grokOption?.textContent).not.toMatch(/disabled|unrecognized/)
  })

  it('keeps a saved Grok provider selected and labelled "(disabled)" while the flag is off', async () => {
    form.renderSavedGrok()
    await flushProbe()
    await Promise.resolve()
    const select = providerSelect()
    expect(select.value).toBe(GROK)
    const grokOptions = within(select)
      .getAllByRole('option')
      .filter(option => (option as HTMLOptionElement).value === GROK)
    expect(grokOptions).toHaveLength(1)
    expect(grokOptions[0]).toHaveTextContent(/\(disabled\)$/)
    expect(select).not.toHaveTextContent(/unrecognized/)
  })
})

describe('TokenBudgetForm Grok capability gate', () => {
  function addProviderSelect(): HTMLElement {
    return screen.getByRole('combobox', { name: 'Add Provider to scope' })
  }

  it('hides grok-subscription from the provider scope when the probe reports disabled', async () => {
    render(<TokenBudgetForm mode="create" saving={false} onSubmit={noop} onCancel={noop} />)
    await flushProbe()
    await Promise.resolve()
    const values = optionValues(addProviderSelect())
    expect(values).not.toContain(GROK)
    expect(values).toContain(CODEX)
  })

  it('offers grok-subscription in the provider scope once the probe reports enabled', async () => {
    vi.mocked(loadGrokSubscriptionCapability).mockResolvedValue({ enabled: true })
    render(<TokenBudgetForm mode="create" saving={false} onSubmit={noop} onCancel={noop} />)
    await waitFor(() => expect(optionValues(addProviderSelect())).toContain(GROK))
  })

  it('shows a saved Grok scope value as "(disabled)" while the flag is off', async () => {
    render(
      <TokenBudgetForm
        mode="edit"
        initial={grokBudget}
        saving={false}
        onSubmit={noop}
        onCancel={noop}
      />
    )
    await flushProbe()
    await Promise.resolve()
    expect(screen.getByText('xAI Grok Subscription (disabled)')).toBeInTheDocument()
    expect(optionValues(addProviderSelect())).not.toContain(GROK)
  })
})
