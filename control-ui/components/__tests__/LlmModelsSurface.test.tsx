import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { LlmAllowedModel } from '@lib/api'
import { getLlmModels, getUnpricedModels } from '@lib/api'
import { loadCodexSubscriptionCapability } from '@lib/codexSubscriptionFeature'
import { LlmModelsSurface } from '../LlmModelsSurface'
import { ToastProvider } from '../Toast'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({ authState: { isLoggedIn: true, isLoading: false } }),
}))
vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@components/LlmDiscoveryPanel', () => ({
  LlmDiscoveryPanel: ({ items, loading }: { items: LlmAllowedModel[]; loading: boolean }) => (
    <div>{loading ? 'Loading discovery models' : `Discovery models: ${items.length}`}</div>
  ),
}))
vi.mock('@components/LlmModelTable', () => ({
  LlmModelTable: () => <div>Model catalog</div>,
}))
vi.mock('@lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/api')>()
  return { ...actual, getLlmModels: vi.fn(), getUnpricedModels: vi.fn() }
})

vi.mock('@lib/codexSubscriptionFeature', () => ({
  loadCodexSubscriptionCapability: vi.fn(),
  isCodexSubscriptionUiEnabled: (capability: { enabled?: boolean } | null) =>
    capability?.enabled === true,
}))

const model: LlmAllowedModel = {
  id: 'model-1',
  provider: 'openai',
  model: 'gpt-5',
  vendor: 'OpenAI',
  display_name: 'GPT-5',
  context_window_tokens: null,
  enabled: false,
  source: 'discovery',
  stale: false,
  discovered_at: null,
  last_seen_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

describe('LlmModelsSurface', () => {
  beforeEach(() => {
    vi.mocked(getLlmModels).mockResolvedValue({ rows: [model] })
    vi.mocked(getUnpricedModels).mockReturnValue(
      new Promise<Awaited<ReturnType<typeof getUnpricedModels>>>(() => undefined)
    )
    vi.mocked(loadCodexSubscriptionCapability).mockResolvedValue({ enabled: false })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders discovery inventory without requesting the catalog-only pricing endpoint', async () => {
    render(
      <ToastProvider>
        <LlmModelsSurface activeTab="discovery" />
      </ToastProvider>
    )

    expect(await screen.findByText('Discovery models: 1')).toBeInTheDocument()
    expect(getUnpricedModels).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'Codex subscription' })).not.toBeInTheDocument()
  })

  it('hides the Codex subscription deep link when Control API capability is absent', async () => {
    render(
      <ToastProvider>
        <LlmModelsSurface activeTab="catalog" />
      </ToastProvider>
    )

    expect(await screen.findByText('Model catalog')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Codex subscription' })).not.toBeInTheDocument()
  })

  it('shows the Codex subscription deep link only after Control API proves the flag', async () => {
    vi.mocked(loadCodexSubscriptionCapability).mockResolvedValue({ enabled: true })
    render(
      <ToastProvider>
        <LlmModelsSurface activeTab="catalog" />
      </ToastProvider>
    )

    const link = await screen.findByRole('link', { name: 'Codex subscription' })
    expect(link).toHaveAttribute('href', '/llm-models/providers/codex-subscription')
    expect(screen.getByTestId('codex-subscription-catalog-link')).toBeInTheDocument()
  })
})
