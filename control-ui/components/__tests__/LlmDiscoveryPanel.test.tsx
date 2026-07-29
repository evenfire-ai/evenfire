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
  it('keeps discovery review and stale models visually distinct and grouped by provider', async () => {
    render(
      <LlmDiscoveryPanel
        items={[reviewModel, staleModel]}
        loading={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    )

    expect(screen.getByText('Discovery review (1)')).toBeInTheDocument()
    expect(screen.getByText('Stale models (1)')).toBeInTheDocument()
    expect(screen.getByText(/Newly synced models land here disabled/)).toBeInTheDocument()
    expect(screen.getByText(/never auto-disabled or auto-removed/)).toBeInTheDocument()

    const reviewGroup = screen.getByRole('button', { name: 'Expand OpenAI review models' })
    const staleGroup = screen.getByRole('button', { name: 'Expand Anthropic stale models' })
    expect(reviewGroup).toHaveAttribute('aria-expanded', 'false')
    expect(staleGroup).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('gpt-5')).toBeNull()
    expect(screen.queryByText('claude-retired')).toBeNull()

    fireEvent.click(reviewGroup)
    expect(screen.getByText('gpt-5')).toBeInTheDocument()
    expect(screen.queryByText('claude-retired')).toBeNull()

    await waitFor(() => expect(screen.getByText('Live catalog')).toBeInTheDocument())
    expect(screen.getByText('+3 new')).toBeInTheDocument()
    expect(screen.getByText('14 refreshed')).toBeInTheDocument()
    expect(screen.getByText('1 stale')).toBeInTheDocument()
  })

  it('enables a reviewed row and refreshes the shared inventory', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    render(<LlmDiscoveryPanel items={[reviewModel]} loading={false} onRefresh={onRefresh} />)

    fireEvent.click(screen.getByRole('button', { name: 'Expand OpenAI review models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))

    await waitFor(() =>
      expect(api.updateLlmModel).toHaveBeenCalledWith('review-openai', { enabled: true })
    )
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('always renders an explicit empty stale state', () => {
    render(
      <LlmDiscoveryPanel
        items={[reviewModel]}
        loading={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    )

    expect(screen.getByText('Stale models (0)')).toBeInTheDocument()
    expect(
      screen.getByText('No stale models. Every discovered row was present in the latest live sync.')
    ).toBeInTheDocument()
  })
})
