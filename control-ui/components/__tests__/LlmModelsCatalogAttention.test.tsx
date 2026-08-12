import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LlmAllowedModel } from '@lib/api'
import { deleteLlmModel, getAdminAttention, getLlmModels, getUnpricedModels } from '@lib/api'
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
// A trimmed catalog table that just exposes the per-row delete trigger so the
// 409 impact/force flow can be driven end to end through the real surface.
vi.mock('@components/LlmModelTable', () => ({
  LlmModelTable: ({
    items,
    onDelete,
  }: {
    items: LlmAllowedModel[]
    onDelete: (model: LlmAllowedModel) => void
  }) => (
    <div>
      Model catalog
      {items.map(model => (
        <button key={model.id} type="button" onClick={() => onDelete(model)}>
          Delete {model.model}
        </button>
      ))}
    </div>
  ),
}))
vi.mock('@lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/api')>()
  return {
    ...actual,
    getLlmModels: vi.fn(),
    getUnpricedModels: vi.fn(),
    getAdminAttention: vi.fn(),
    deleteLlmModel: vi.fn(),
  }
})

// Mirrors the Error shape lib/api.ts formatApiError produces: message plus the
// preserved structured `.status`/`.code`/`.body` the typed helpers read.
function structuredApiError(status: number, body: Record<string, unknown>): Error {
  const error = new Error(`${status} Conflict - ${String(body.error)}`)
  ;(error as Error & { status?: number }).status = status
  ;(error as Error & { code?: string }).code = String(body.error)
  ;(error as Error & { body?: unknown }).body = body
  return error
}

const model: LlmAllowedModel = {
  id: 'model-1',
  provider: 'claude',
  model: 'claude-haiku-4-5',
  vendor: 'Anthropic',
  display_name: 'Claude Haiku',
  context_window_tokens: null,
  enabled: true,
  source: 'discovery',
  stale: true,
  discovered_at: null,
  last_seen_at: null,
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

describe('catalog attention banner', () => {
  beforeEach(() => {
    vi.mocked(getLlmModels).mockResolvedValue({ rows: [model] })
    vi.mocked(getUnpricedModels).mockResolvedValue({ rows: [] })
    vi.mocked(deleteLlmModel).mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('lists stale-but-referenced items and ignores an unknown kind without crashing', async () => {
    vi.mocked(getAdminAttention).mockResolvedValue({
      items: [
        {
          kind: 'stale_model_referenced',
          provider: 'claude',
          model: 'claude-haiku-4-5',
          displayName: 'Claude Haiku',
          hostsAffected: [{ namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] }],
          grantsAffected: [
            {
              id: 'g1',
              recipeNamespace: 'sandbox-recipes',
              recipeName: 'nightly-summary',
              capabilityFamily: 'promptBridge',
            },
          ],
        },
        // Unknown future kind: must be silently ignored, never throw.
        {
          kind: 'future_kind',
          provider: 'openai',
          model: 'gpt-5',
          hostsAffected: [],
          grantsAffected: [],
        },
      ],
      generatedAt: '2026-08-12T00:00:00.000Z',
    })

    renderSurface()

    expect(await screen.findByText('Claude Haiku')).toBeInTheDocument()
    expect(screen.getByText('mcp-host/agent-a')).toBeInTheDocument()
    expect(screen.getByText(/promptBridge/)).toBeInTheDocument()
    expect(screen.getByText('sandbox-recipes/nightly-summary')).toBeInTheDocument()
    // The unknown-kind item contributes nothing to the banner.
    expect(screen.queryByText('gpt-5')).not.toBeInTheDocument()
  })

  it('renders no banner for an empty feed', async () => {
    vi.mocked(getAdminAttention).mockResolvedValue({ items: [], generatedAt: 'x' })

    renderSurface()

    expect(await screen.findByText('Model catalog')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('falls back to the model id when displayName is absent', async () => {
    vi.mocked(getAdminAttention).mockResolvedValue({
      items: [
        {
          kind: 'stale_model_referenced',
          provider: 'openai',
          model: 'gpt-5-mini',
          hostsAffected: [{ namespace: 'mcp-host', name: 'agent-b', roles: ['fallback'] }],
          grantsAffected: [],
        },
      ],
      generatedAt: 'x',
    })

    renderSurface()

    expect(await screen.findByText('gpt-5-mini')).toBeInTheDocument()
  })
})

describe('delete impact gate (409 model_in_use → force)', () => {
  beforeEach(() => {
    vi.mocked(getLlmModels).mockResolvedValue({ rows: [model] })
    vi.mocked(getUnpricedModels).mockResolvedValue({ rows: [] })
    vi.mocked(getAdminAttention).mockResolvedValue({ items: [], generatedAt: 'x' })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the impact and retries with ?force after the operator confirms', async () => {
    vi.mocked(deleteLlmModel)
      .mockRejectedValueOnce(
        structuredApiError(409, {
          error: 'model_in_use',
          message: 'still referenced',
          impact: {
            provider: 'claude',
            model: 'claude-haiku-4-5',
            hostsAffected: [{ namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] }],
            grantsAffected: [
              {
                id: 'g1',
                recipeNamespace: 'sandbox-recipes',
                recipeName: 'nightly-summary',
                capabilityFamily: 'promptBridge',
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(undefined)

    renderSurface()

    fireEvent.click(await screen.findByRole('button', { name: 'Delete claude-haiku-4-5' }))
    // First confirm: the ordinary delete prompt.
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    // Impact confirm: shows the stranded references before forcing.
    expect(await screen.findByRole('button', { name: 'Remove anyway' })).toBeInTheDocument()
    expect(screen.getByText('mcp-host/agent-a')).toBeInTheDocument()
    expect(screen.getByText(/promptBridge/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove anyway' }))

    await waitFor(() => {
      expect(vi.mocked(deleteLlmModel)).toHaveBeenCalledTimes(2)
    })
    // First attempt without force, retry with { force: true }.
    expect(vi.mocked(deleteLlmModel).mock.calls[0]).toEqual(['model-1', {}])
    expect(vi.mocked(deleteLlmModel).mock.calls[1]).toEqual(['model-1', { force: true }])
  })

  it('does not force when the operator cancels the impact confirm', async () => {
    vi.mocked(deleteLlmModel).mockRejectedValueOnce(
      structuredApiError(409, {
        error: 'model_in_use',
        message: 'still referenced',
        impact: {
          provider: 'claude',
          model: 'claude-haiku-4-5',
          hostsAffected: [{ namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] }],
          grantsAffected: [],
        },
      })
    )

    renderSurface()

    fireEvent.click(await screen.findByRole('button', { name: 'Delete claude-haiku-4-5' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Remove anyway' })).not.toBeInTheDocument()
    })
    expect(vi.mocked(deleteLlmModel)).toHaveBeenCalledTimes(1)
  })

  // L1: the advisory banner must not keep showing an item the operator just
  // resolved in-session. A successful mutation bumps refreshSignal → re-fetch.
  it('re-fetches the attention feed after a successful delete', async () => {
    vi.mocked(deleteLlmModel).mockResolvedValue(undefined)

    renderSurface()

    await screen.findByText('Model catalog')
    // One fetch on mount, before any mutation.
    await waitFor(() => expect(vi.mocked(getAdminAttention)).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Delete claude-haiku-4-5' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    // The successful delete triggers a second, on-demand fetch (no polling).
    await waitFor(() => expect(vi.mocked(getAdminAttention)).toHaveBeenCalledTimes(2))
  })
})
