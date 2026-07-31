import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { LlmAllowedModel } from '@lib/api'
import { getLlmModels, getUnpricedModels } from '@lib/api'
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
  })
})
