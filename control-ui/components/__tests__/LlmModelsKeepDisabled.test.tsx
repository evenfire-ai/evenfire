import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LlmAllowedModel } from '@lib/api'
import {
  formatApiError,
  getAdminAttention,
  getLlmModels,
  getUnpricedModels,
  updateLlmModel,
} from '@lib/api'
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
  LlmDiscoveryPanel: () => <div>Discovery</div>,
}))
vi.mock('@lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/api')>()
  return {
    ...actual,
    getLlmModels: vi.fn(),
    getUnpricedModels: vi.fn(),
    getAdminAttention: vi.fn(),
    updateLlmModel: vi.fn(),
  }
})

function structuredApiError(status: number, body: Record<string, unknown>): Error {
  const text = JSON.stringify(body)
  const res = new Response(text, { status, headers: { 'content-type': 'application/json' } })
  return formatApiError(res, text)
}

const pruned: LlmAllowedModel = {
  id: 'pruned',
  provider: 'claude',
  model: 'claude-old',
  vendor: 'Anthropic',
  display_name: null,
  context_window_tokens: null,
  enabled: false,
  source: 'discovery',
  stale: true,
  discovered_at: null,
  last_seen_at: null,
  auto_disabled_at: '2026-11-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

function renderSurface() {
  return render(
    <ToastProvider>
      <LlmModelsSurface activeTab="catalog" />
    </ToastProvider>
  )
}

async function keepDisabled() {
  fireEvent.click(await screen.findByRole('button', { name: 'Expand Anthropic models' }))
  fireEvent.click(screen.getByRole('button', { name: 'Actions for model claude/claude-old' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Keep disabled' }))
}

describe('Keep disabled on a row the catalog sync turned off', () => {
  beforeEach(() => {
    vi.mocked(getUnpricedModels).mockResolvedValue({ rows: [] })
    vi.mocked(getAdminAttention).mockResolvedValue({ items: [], generatedAt: 'x' })
    // control-api clears the timestamp when the operator takes the decision.
    let current = pruned
    vi.mocked(getLlmModels).mockImplementation(async () => ({ rows: [current] }))
    vi.mocked(updateLlmModel).mockImplementation(async () => {
      current = { ...pruned, auto_disabled_at: null }
      return current
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('pins the row off and refreshes the list, which drops the marker', async () => {
    renderSurface()
    await keepDisabled()

    await waitFor(() =>
      expect(screen.queryByText('Turned off by catalog sync')).not.toBeInTheDocument()
    )
    expect(vi.mocked(updateLlmModel)).toHaveBeenCalledWith(
      'pruned',
      { enabled: false, pinEnabled: true },
      {}
    )
    expect(vi.mocked(getLlmModels)).toHaveBeenCalledTimes(2)
  })

  it('confirms the impact and forces when the sync turned the row back on meanwhile', async () => {
    vi.mocked(updateLlmModel)
      .mockRejectedValueOnce(
        structuredApiError(409, {
          error: 'model_in_use',
          message: 'still referenced',
          impact: {
            provider: 'claude',
            model: 'claude-old',
            hostsAffected: [{ namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] }],
            grantsAffected: [],
          },
        })
      )
      .mockResolvedValueOnce({ ...pruned, auto_disabled_at: null })

    renderSurface()
    await keepDisabled()

    fireEvent.click(await screen.findByRole('button', { name: 'Disable anyway' }))

    await waitFor(() => expect(vi.mocked(updateLlmModel)).toHaveBeenCalledTimes(2))
    expect(vi.mocked(updateLlmModel).mock.calls[1]).toEqual([
      'pruned',
      { enabled: false, pinEnabled: true },
      { force: true },
    ])
  })
})
