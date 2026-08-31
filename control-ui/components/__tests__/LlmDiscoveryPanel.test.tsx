import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import type { LlmAllowedModel } from '../../lib/api'
import { LlmDiscoveryPanel } from '../LlmDiscoveryPanel'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    deleteLlmModel: vi.fn(),
    getDiscoveryStatus: vi.fn(),
    syncDiscovery: vi.fn(),
    updateLlmModel: vi.fn(),
  }
})

const reviewModel: LlmAllowedModel = {
  id: 'review-openai',
  provider: 'openai',
  model: 'gpt-5',
  vendor: 'OpenAI',
  display_name: 'GPT-5',
  context_window_tokens: 400000,
  enabled: false,
  source: 'discovery',
  stale: false,
  discovered_at: '2026-01-01T00:00:00.000Z',
  last_seen_at: '2026-01-02T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
}

const staleModel: LlmAllowedModel = {
  ...reviewModel,
  id: 'stale-anthropic',
  provider: 'claude',
  model: 'claude-retired',
  vendor: 'Anthropic',
  enabled: true,
  stale: true,
}

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

beforeEach(() => {
  vi.mocked(api.getDiscoveryStatus).mockResolvedValue({
    ranAt: '2026-07-29T12:00:00.000Z',
    source: 'live',
    added: 3,
    updated: 14,
    staled: 1,
  })
  vi.mocked(api.updateLlmModel).mockResolvedValue(reviewModel)
  vi.mocked(api.syncDiscovery).mockResolvedValue({
    fetchedAt: '2026-07-29T12:59:59.000Z',
    ranAt: '2026-07-29T13:00:00.000Z',
    source: 'live',
    added: 2,
    updated: 12,
    staled: 0,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('LlmDiscoveryPanel merged lifecycle workflow', () => {
  it('shows review records with provider identity and excludes stale rows', async () => {
    render(
      <LlmDiscoveryPanel
        items={[reviewModel, staleModel]}
        loading={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    )

    expect(screen.getByText('LLM Models')).toBeInTheDocument()
    expect(screen.getByText(/Newly synced models land here disabled/)).toBeInTheDocument()

    expect(screen.getByRole('columnheader', { name: /Provider/i })).toBeInTheDocument()
    expect(screen.getByText('gpt-5')).toBeInTheDocument()
    expect(screen.queryByText('claude-retired')).toBeNull()
    expect(screen.queryByRole('button', { name: /Expand .* review models/ })).toBeNull()

    await waitFor(() => expect(screen.getByText('Live catalog')).toBeInTheDocument())
    expect(screen.getByText('+3 new')).toBeInTheDocument()
    expect(screen.getByText('14 refreshed')).toBeInTheDocument()
    expect(screen.getByText('1 stale')).toBeInTheDocument()
  })

  it('enables a reviewed row and refreshes the shared inventory', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    render(<LlmDiscoveryPanel items={[reviewModel]} loading={false} onRefresh={onRefresh} />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))

    await waitFor(() =>
      expect(api.updateLlmModel).toHaveBeenCalledWith('review-openai', { enabled: true })
    )
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('does not render a dedicated stale-model management section', () => {
    render(
      <LlmDiscoveryPanel
        items={[reviewModel, staleModel]}
        loading={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    )

    expect(screen.queryByText(/Stale models/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Anthropic stale models/ })).toBeNull()
  })

  it('keeps the sync status when an older mount-time status request resolves afterwards', async () => {
    let resolveInitialStatus!: (value: Awaited<ReturnType<typeof api.getDiscoveryStatus>>) => void
    vi.mocked(api.getDiscoveryStatus).mockReset()
    vi.mocked(api.getDiscoveryStatus).mockReturnValueOnce(
      new Promise(resolve => {
        resolveInitialStatus = resolve
      })
    )
    const onRefresh = vi.fn().mockResolvedValue(undefined)

    render(<LlmDiscoveryPanel items={[reviewModel]} loading={false} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sync catalog' }))

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect(screen.getByText('+2 new')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reload discovery review' })).toBeEnabled()
    )

    resolveInitialStatus({
      ranAt: '2026-07-01T00:00:00.000Z',
      source: 'vendored',
      added: 99,
      updated: 99,
      staled: 99,
    })

    await waitFor(() => expect(screen.getByText('+2 new')).toBeInTheDocument())
    expect(screen.queryByText('+99 new')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reload discovery review' })).toBeEnabled()
  })
})

describe('LlmDiscoveryPanel sorting', () => {
  function rowOrder(): string[] {
    const rows = document.querySelectorAll('tr.cu-llm-model-row')
    return Array.from(rows).map(row => {
      const cell = row.querySelector('td.cu-px-model')
      return cell?.textContent?.trim() ?? ''
    })
  }

  function expandOpenAi() {
    // Review rows are always visible; retained as a no-op for the sorting tests.
  }

  const discoveryModel = (overrides: Partial<LlmAllowedModel>): LlmAllowedModel => ({
    ...reviewModel,
    id: overrides.id ?? reviewModel.id,
    enabled: false,
    source: 'discovery',
    stale: false,
    ...overrides,
  })

  it('keeps the static LLM Models title for the discovery panel', () => {
    render(
      <LlmDiscoveryPanel
        items={[reviewModel]}
        loading={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expect(screen.getByRole('heading', { name: /LLM Models/ })).toBeInTheDocument()
  })

  it('sorts queued models by model name ascending when clicked', () => {
    const alpha = discoveryModel({ id: 'a', model: 'alpha' })
    const bravo = discoveryModel({ id: 'b', model: 'bravo' })
    const charlie = discoveryModel({ id: 'c', model: 'charlie' })
    render(
      <LlmDiscoveryPanel
        items={[charlie, alpha, bravo]}
        loading={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expandOpenAi()

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Model ascending' }))

    expect(rowOrder()).toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('sorts context window descending by default and pushes null values to the end', () => {
    const small = discoveryModel({ id: 's', model: 'small', context_window_tokens: 8_000 })
    const large = discoveryModel({ id: 'l', model: 'large', context_window_tokens: 1_000_000 })
    const unknown = discoveryModel({ id: 'u', model: 'unknown', context_window_tokens: null })
    render(
      <LlmDiscoveryPanel
        items={[small, large, unknown]}
        loading={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expandOpenAi()

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Context window descending' }))

    expect(rowOrder()).toEqual(['large', 'small', 'unknown'])
  })
})
