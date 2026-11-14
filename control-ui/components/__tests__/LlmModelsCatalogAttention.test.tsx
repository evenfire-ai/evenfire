import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CONTROL_ROUTES } from '@constants/routes'
import type { LlmAllowedModel } from '@lib/api'
import {
  deleteLlmModel,
  formatApiError,
  getAdminAttention,
  getLlmModels,
  getUnpricedModels,
  parseAdminAttentionReport,
} from '@lib/api'
import { getProviderDisplayLabel } from '@lib/llm'
import { attentionWireBody, attentionWireBodyOf } from '../../test/fixtures/llmAttention'
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

// Derive the rejected Error from the REAL client error producer (formatApiError,
// lib/api.ts) instead of re-implementing its `.status`/`.code`/`.body` shape by
// hand (T1). A change to how control-ui represents an API error now flows into
// these tests rather than silently diverging from a hand-mirrored copy.
function structuredApiError(status: number, body: Record<string, unknown>): Error {
  const text = JSON.stringify(body)
  const res = new Response(text, { status, headers: { 'content-type': 'application/json' } })
  return formatApiError(res, text)
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
    // Parsed by the real client normalizer, as getAdminAttention does, so the
    // unknown kind takes the production path.
    vi.mocked(getAdminAttention).mockResolvedValue(
      parseAdminAttentionReport({
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
    )

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

// The catalog-flagged kinds (deprecated / stale discovery) carry no references.
// Their feed is the producer-generated wire body (control-api real-PG
// generator), run through the real client parser exactly as getAdminAttention
// does; only the allowlist rows the surface links to are built here, keyed by
// the pairs the wire carries.
describe('catalog attention banner — catalog-flagged kinds', () => {
  type WireItem = ReturnType<typeof attentionWireBody>['items'][number]

  function rowFor(item: WireItem, id: string): LlmAllowedModel {
    return { ...model, id, provider: item.provider, model: item.model }
  }

  function feed(body: unknown) {
    vi.mocked(getAdminAttention).mockResolvedValue(parseAdminAttentionReport(body))
  }

  beforeEach(() => {
    vi.mocked(getUnpricedModels).mockResolvedValue({ rows: [] })
    vi.mocked(deleteLlmModel).mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders a deprecated model with its provider, model id and a review link to its edit page', async () => {
    const body = attentionWireBodyOf('deprecated_model_enabled')
    expect(body.items).toHaveLength(1)
    const [item] = body.items
    vi.mocked(getLlmModels).mockResolvedValue({ rows: [rowFor(item, 'row-deprecated')] })
    feed(body)

    renderSurface()

    const banner = await screen.findByRole('status')
    const label = String(item.displayName ?? item.model)
    const providerLabel = getProviderDisplayLabel(item.provider)
    expect(banner).toHaveTextContent(/1 enabled model is marked deprecated in the provider catalog/)
    expect(banner).toHaveTextContent(
      /disable it, replace it with a newer model, or keep it enabled/
    )
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(banner).toHaveTextContent(`${providerLabel} · ${item.model}`)
    const link = await screen.findByRole('link', {
      name: `Review ${label} (${providerLabel} · ${item.model})`,
    })
    expect(link).toHaveAttribute('href', CONTROL_ROUTES.llmModels.edit('row-deprecated'))
    // No reference list for a kind without references.
    expect(banner).not.toHaveTextContent(/still use it/)
    expect(banner).not.toHaveTextContent(/still referenced/)
  })

  it('renders every stale discovery item with a count and a review link each', async () => {
    const body = attentionWireBodyOf('stale_discovery_enabled')
    expect(body.items).toHaveLength(2)
    vi.mocked(getLlmModels).mockResolvedValue({
      rows: body.items.map((item, index) => rowFor(item, `row-stale-${index}`)),
    })
    feed(body)

    renderSurface()

    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent(
      /2 enabled discovered models are no longer listed in the provider catalog/
    )
    expect(banner).toHaveTextContent(
      /disable it, replace it, or keep it if the provider still serves it/
    )
    for (const [index, item] of body.items.entries()) {
      const label = String(item.displayName ?? item.model)
      const providerLabel = getProviderDisplayLabel(item.provider)
      expect(screen.getByText(label)).toBeInTheDocument()
      const link = await screen.findByRole('link', {
        name: `Review ${label} (${providerLabel} · ${item.model})`,
      })
      expect(link).toHaveAttribute('href', CONTROL_ROUTES.llmModels.edit(`row-stale-${index}`))
    }
    expect(banner).not.toHaveTextContent(/still use it/)
  })

  it('renders all three kinds from the full feed, counting a referenced stale model once and linking it', async () => {
    const body = attentionWireBody()
    const referenced = body.items.find(item => item.kind === 'stale_model_referenced')!
    // The generator's referenced model is also a stale discovery row, so the
    // feed carries that pair twice; the banner must show it once.
    const pair = (item: WireItem) => `${item.provider}/${item.model}`
    expect(
      body.items.filter(
        item => item.kind === 'stale_discovery_enabled' && pair(item) === pair(referenced)
      )
    ).toHaveLength(1)
    const distinctPairs = [...new Set(body.items.map(pair))]
    vi.mocked(getLlmModels).mockResolvedValue({
      rows: distinctPairs.map((key, index) => {
        const item = body.items.find(candidate => pair(candidate) === key)!
        return rowFor(item, `row-${index}`)
      }),
    })
    feed(body)

    renderSurface()

    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent(
      /1 model disappeared from the provider catalog but is still referenced/
    )
    expect(banner).toHaveTextContent(/1 enabled model is marked deprecated/)
    expect(banner).toHaveTextContent(/1 enabled discovered model is no longer listed/)
    const referencedLabel = String(referenced.displayName ?? referenced.model)
    expect(screen.getAllByText(referencedLabel)).toHaveLength(1)
    const hosts = referenced.hostsAffected as Array<{ namespace: string; name: string }>
    expect(screen.getByText(`${hosts[0].namespace}/${hosts[0].name}`)).toBeInTheDocument()
    const providerLabel = getProviderDisplayLabel(referenced.provider)
    const link = await screen.findByRole('link', {
      name: `Review ${referencedLabel} (${providerLabel} · ${referenced.model})`,
    })
    expect(link).toHaveAttribute(
      'href',
      CONTROL_ROUTES.llmModels.edit(`row-${distinctPairs.indexOf(pair(referenced))}`)
    )
  })

  it('renders an item without a link while its allowlist row is not loaded', async () => {
    const body = attentionWireBodyOf('deprecated_model_enabled')
    vi.mocked(getLlmModels).mockResolvedValue({ rows: [] })
    feed(body)

    renderSurface()

    const label = String(body.items[0].displayName ?? body.items[0].model)
    expect(await screen.findByText(label)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^Review / })).not.toBeInTheDocument()
  })

  it('ignores an unknown kind next to the known ones without crashing', async () => {
    const body = attentionWireBodyOf('deprecated_model_enabled')
    vi.mocked(getLlmModels).mockResolvedValue({ rows: [] })
    // A kind a newer backend could add; the generator cannot emit it today.
    feed({
      ...body,
      items: [...body.items, { kind: 'future_kind', provider: 'openai', model: 'gpt-future' }],
    })

    renderSurface()

    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent(/1 enabled model is marked deprecated/)
    expect(screen.queryByText('gpt-future')).not.toBeInTheDocument()
  })

  it('renders no banner when the feed only carries unknown kinds', async () => {
    vi.mocked(getLlmModels).mockResolvedValue({ rows: [model] })
    const report = parseAdminAttentionReport({
      items: [{ kind: 'future_kind', provider: 'openai', model: 'gpt-future' }],
      generatedAt: 'x',
    })
    // The real parser is what keeps an unknown kind out of the banner.
    expect(report.items).toEqual([])
    vi.mocked(getAdminAttention).mockResolvedValue(report)

    renderSurface()

    expect(await screen.findByText('Model catalog')).toBeInTheDocument()
    // Settle the banner's fetch and the state update it causes before asserting.
    await waitFor(() => expect(vi.mocked(getAdminAttention)).toHaveBeenCalled())
    await act(async () => {
      await vi.mocked(getAdminAttention).mock.results[0].value
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
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
  // resolved in-session. A successful mutation bumps refreshSignal → re-fetch,
  // and the banner must reflect the fresh feed. Assert the observable result
  // (the item leaves the operator's view), not the fetch call count: a banner
  // that re-fetches but ignores the new data would pass a call-count check.
  it('drops a resolved item from the banner after a successful delete', async () => {
    vi.mocked(deleteLlmModel).mockResolvedValue(undefined)
    // Mount feed carries a distinct referenced item; the post-delete re-fetch
    // returns it resolved (empty), so the banner must stop showing it. The
    // banner item is deliberately unrelated to the catalog row being deleted.
    vi.mocked(getAdminAttention)
      .mockResolvedValueOnce({
        items: [
          {
            kind: 'stale_model_referenced',
            provider: 'openai',
            model: 'gpt-5-mini',
            displayName: 'GPT-5 Mini',
            hostsAffected: [{ namespace: 'mcp-host', name: 'agent-b', roles: ['primary'] }],
            grantsAffected: [],
          },
        ],
        generatedAt: 'x',
      })
      .mockResolvedValue({ items: [], generatedAt: 'x' })

    renderSurface()

    // The stale item is visible in the banner before any mutation.
    expect(await screen.findByText('GPT-5 Mini')).toBeInTheDocument()
    // Exactly one feed fetch on mount — the banner re-fetches on demand only, so
    // no polling and no double-fetch (a mount-effect regression the observable
    // assertion below would not catch on its own).
    expect(vi.mocked(getAdminAttention)).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Delete claude-haiku-4-5' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    // After the successful delete the banner re-fetches and the resolved item
    // is gone from the operator's view.
    await waitFor(() => {
      expect(screen.queryByText('GPT-5 Mini')).not.toBeInTheDocument()
    })
    // Exactly one additional fetch for the post-mutation refresh — one bump per
    // mutation, not a polling loop.
    expect(vi.mocked(getAdminAttention)).toHaveBeenCalledTimes(2)
  })

  // R3-M1 (T5): the PR body promises a *transient failure* of the post-mutation
  // refetch soft-degrades — the banner clears and hides, and the models surface
  // stays usable (CatalogAttentionBanner.tsx catch -> setItems([])). The sibling
  // test above only covers a second fetch that RESOLVES empty; this covers the
  // rejecting path. Assert the observable outcome (banner gone, catalog still
  // interactive), not the fetch internals (T4).
  it('hides the banner but keeps the surface usable when the post-mutation refetch fails (R3-M1)', async () => {
    vi.mocked(deleteLlmModel).mockResolvedValue(undefined)
    // Mount feed carries a visible item; the post-delete re-fetch REJECTS (a
    // transient attention failure, not a silent abort), so the advisory must
    // soft-degrade to hidden rather than tumble the surface.
    vi.mocked(getAdminAttention)
      .mockResolvedValueOnce({
        items: [
          {
            kind: 'stale_model_referenced',
            provider: 'openai',
            model: 'gpt-5-mini',
            displayName: 'GPT-5 Mini',
            hostsAffected: [{ namespace: 'mcp-host', name: 'agent-b', roles: ['primary'] }],
            grantsAffected: [],
          },
        ],
        generatedAt: 'x',
      })
      .mockRejectedValue(new Error('attention refetch failed'))

    renderSurface()

    // The stale item is visible in the banner before the mutation.
    expect(await screen.findByText('GPT-5 Mini')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete claude-haiku-4-5' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    // The rejected refetch clears the banner: the advisory item leaves the view.
    await waitFor(() => {
      expect(screen.queryByText('GPT-5 Mini')).not.toBeInTheDocument()
    })
    // And nothing else broke — the models surface stays interactive.
    expect(screen.getByText('Model catalog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete claude-haiku-4-5' })).toBeInTheDocument()
  })
})
