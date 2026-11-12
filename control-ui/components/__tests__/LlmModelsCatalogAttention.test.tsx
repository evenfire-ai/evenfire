import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

// The banner shares `role="status"` with the success toast a delete shows, so it
// is located by its own text, never by the bare role.
const BANNER_TEXT = /Models need review/

/** The banner's message `<span>`, once the feed has landed. */
function findBannerMessage() {
  return screen.findByText(BANNER_TEXT)
}

/** The detail lives only in the dialog, which exists only after `Review models`. */
async function openReview() {
  fireEvent.click(await screen.findByRole('button', { name: 'Review models' }))
  return screen.findByRole('dialog')
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

    const dialog = await openReview()
    expect(within(dialog).getByText('Claude Haiku')).toBeInTheDocument()
    expect(within(dialog).getByText('mcp-host/agent-a')).toBeInTheDocument()
    expect(within(dialog).getByText(/promptBridge/)).toBeInTheDocument()
    expect(within(dialog).getByText('sandbox-recipes/nightly-summary')).toBeInTheDocument()
    // The unknown-kind item contributes nothing, checked where the rows render.
    expect(within(dialog).queryByText('gpt-5')).not.toBeInTheDocument()
  })

  it('renders no banner for an empty feed', async () => {
    vi.mocked(getAdminAttention).mockResolvedValue({ items: [], generatedAt: 'x' })

    renderSurface()

    expect(await screen.findByText('Model catalog')).toBeInTheDocument()
    await waitFor(() => expect(vi.mocked(getAdminAttention)).toHaveBeenCalled())
    await act(async () => {
      await vi.mocked(getAdminAttention).mock.results[0].value
    })
    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument()
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

    const dialog = await openReview()
    expect(within(dialog).getByText('gpt-5-mini')).toBeInTheDocument()
  })
})

// The deprecated kind. Its feed is the producer-generated wire body (control-api
// real-PG generator), run through the real client parser exactly as
// getAdminAttention does; only the allowlist rows the surface links to are built
// here, keyed by the pairs the wire carries. The producer no longer emits
// `stale_discovery_enabled` (a stale model nobody uses needs no decision), so
// that group has no producer-derived feed left to render.
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

    const dialog = await openReview()
    const label = String(item.displayName ?? item.model)
    const providerLabel = getProviderDisplayLabel(item.provider)
    expect(dialog).toHaveTextContent(/1 enabled model is marked deprecated in the provider catalog/)
    expect(dialog).toHaveTextContent(
      /disable it, replace it with a newer model, or keep it enabled/
    )
    const link = await within(dialog).findByRole('link', {
      name: `Review ${label} (${providerLabel} · ${item.model})`,
    })
    expect(link).toHaveAttribute('href', CONTROL_ROUTES.llmModels.edit('row-deprecated'))
    // Provider and model sit in their own cells of the item's row.
    const cells = within(link.closest('tr')!).getAllByRole('cell')
    expect(cells[0]).toHaveTextContent(providerLabel)
    expect(cells[1]).toHaveTextContent(label)
    expect(cells[1]).toHaveTextContent(item.model)
    // No reference column for a kind without references.
    expect(within(dialog).queryByRole('columnheader', { name: 'Used by' })).not.toBeInTheDocument()
  })

  it('renders both kinds from the full feed, each stale item with its Hosts and a link', async () => {
    const body = attentionWireBody()
    const referenced = body.items.filter(item => item.kind === 'stale_model_referenced')
    expect(referenced).toHaveLength(2)
    expect(body.items.map(item => item.kind)).not.toContain('stale_discovery_enabled')
    const pair = (item: WireItem) => `${item.provider}/${item.model}`
    const distinctPairs = [...new Set(body.items.map(pair))]
    vi.mocked(getLlmModels).mockResolvedValue({
      rows: distinctPairs.map((key, index) => {
        const item = body.items.find(candidate => pair(candidate) === key)!
        return rowFor(item, `row-${index}`)
      }),
    })
    feed(body)

    renderSurface()

    const dialog = await openReview()
    expect(dialog).toHaveTextContent(
      /2 models disappeared from the provider catalog but are still referenced/
    )
    expect(dialog).toHaveTextContent(/1 enabled model is marked deprecated/)
    expect(dialog).not.toHaveTextContent(/no longer listed/)
    for (const item of referenced) {
      const label = String(item.displayName ?? item.model)
      const link = await within(dialog).findByRole('link', {
        name: `Review ${label} (${getProviderDisplayLabel(item.provider)} · ${item.model})`,
      })
      expect(link).toHaveAttribute(
        'href',
        CONTROL_ROUTES.llmModels.edit(`row-${distinctPairs.indexOf(pair(item))}`)
      )
      const hosts = item.hostsAffected as Array<{ namespace: string; name: string }>
      expect(
        within(link.closest('tr')!).getByText(`${hosts[0].namespace}/${hosts[0].name}`)
      ).toBeInTheDocument()
    }
  })

  it('renders an item without a link while its allowlist row is not loaded', async () => {
    const body = attentionWireBodyOf('deprecated_model_enabled')
    vi.mocked(getLlmModels).mockResolvedValue({ rows: [] })
    feed(body)

    renderSurface()

    const dialog = await openReview()
    const label = String(body.items[0].displayName ?? body.items[0].model)
    expect(within(dialog).getByText(label)).toBeInTheDocument()
    expect(within(dialog).queryByRole('link', { name: /^Review / })).not.toBeInTheDocument()
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

    const dialog = await openReview()
    expect(dialog).toHaveTextContent(/1 enabled model is marked deprecated/)
    expect(within(dialog).queryByText('gpt-future')).not.toBeInTheDocument()
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
    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument()
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
      .mockResolvedValueOnce(
        parseAdminAttentionReport(attentionWireBodyOf('stale_model_referenced'))
      )
      .mockResolvedValue({ items: [], generatedAt: 'x' })

    renderSurface()

    // The stale item is counted in the banner before any mutation.
    expect(await findBannerMessage()).toHaveTextContent('2 still referenced')
    // Exactly one feed fetch on mount — the banner re-fetches on demand only, so
    // no polling and no double-fetch (a mount-effect regression the observable
    // assertion below would not catch on its own).
    expect(vi.mocked(getAdminAttention)).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Delete claude-haiku-4-5' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    // After the successful delete the banner re-fetches and the resolved item
    // is gone from the operator's view.
    await waitFor(() => {
      expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument()
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
      .mockResolvedValueOnce(
        parseAdminAttentionReport(attentionWireBodyOf('stale_model_referenced'))
      )
      .mockRejectedValue(new Error('attention refetch failed'))

    renderSurface()

    // The stale item is counted in the banner before the mutation.
    expect(await findBannerMessage()).toHaveTextContent('2 still referenced')

    fireEvent.click(screen.getByRole('button', { name: 'Delete claude-haiku-4-5' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    // The rejected refetch clears the banner: the advisory item leaves the view.
    await waitFor(() => {
      expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument()
    })
    // And nothing else broke — the models surface stays interactive.
    expect(screen.getByText('Model catalog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete claude-haiku-4-5' })).toBeInTheDocument()
  })
})

// The compact banner: one line of counts, the detail in a dialog. Every feed is
// the producer-generated wire body run through the real client parser.
describe('catalog attention banner — one line plus review dialog', () => {
  type WireItem = ReturnType<typeof attentionWireBody>['items'][number]
  const pair = (item: WireItem) => `${item.provider}/${item.model}`

  /** One allowlist row per distinct pair of the body, so every item links. */
  function rowsFor(body: ReturnType<typeof attentionWireBody>): LlmAllowedModel[] {
    const pairs = [...new Set(body.items.map(pair))]
    return pairs.map((key, index) => {
      const item = body.items.find(candidate => pair(candidate) === key)!
      return { ...model, id: `row-${index}`, provider: item.provider, model: item.model }
    })
  }

  function rowIdOf(body: ReturnType<typeof attentionWireBody>, item: WireItem): string {
    return `row-${[...new Set(body.items.map(pair))].indexOf(pair(item))}`
  }

  function reviewLinkName(item: WireItem): string {
    const label = String(item.displayName ?? item.model)
    return `Review ${label} (${getProviderDisplayLabel(item.provider)} · ${item.model})`
  }

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(settle => {
      resolve = settle
    })
    return { promise, resolve }
  }

  beforeEach(() => {
    vi.mocked(getUnpricedModels).mockResolvedValue({ rows: [] })
    vi.mocked(deleteLlmModel).mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('T-1: shows the counts and no model name or link in the banner', async () => {
    const body = attentionWireBody()
    vi.mocked(getLlmModels).mockResolvedValue({ rows: rowsFor(body) })
    vi.mocked(getAdminAttention).mockResolvedValue(parseAdminAttentionReport(body))

    renderSurface()

    const banner = (await findBannerMessage()).parentElement!
    expect(banner).toHaveAttribute('role', 'status')
    expect(banner).toHaveTextContent('2 still referenced')
    for (const item of body.items) {
      expect(banner).not.toHaveTextContent(item.model)
      if (item.displayName) expect(banner).not.toHaveTextContent(String(item.displayName))
    }
    expect(within(banner).queryAllByRole('link')).toHaveLength(0)
    expect(within(banner).getByRole('button', { name: 'Review models' })).toBeInTheDocument()
  })

  it('T-2: the message is exactly the per-group segments, without a total', async () => {
    const body = attentionWireBody()
    vi.mocked(getLlmModels).mockResolvedValue({ rows: [] })
    vi.mocked(getAdminAttention).mockResolvedValue(parseAdminAttentionReport(body))

    const { unmount } = renderSurface()

    expect((await findBannerMessage()).textContent).toBe(
      'Models need review: 2 still referenced · 1 deprecated'
    )
    unmount()

    vi.mocked(getAdminAttention).mockResolvedValue(
      parseAdminAttentionReport(attentionWireBodyOf('deprecated_model_enabled'))
    )
    renderSurface()

    expect((await findBannerMessage()).textContent).toBe('Models need review: 1 deprecated')
  })

  it('T-3: the dialog opens only from the banner, focuses Done and closes with it', async () => {
    const body = attentionWireBody()
    vi.mocked(getLlmModels).mockResolvedValue({ rows: rowsFor(body) })
    vi.mocked(getAdminAttention).mockResolvedValue(parseAdminAttentionReport(body))

    renderSurface()

    await findBannerMessage()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const dialog = await openReview()
    expect(within(dialog).getByRole('heading', { name: 'Models that need review' })).toBeVisible()
    // The rows are linked, so a default first-focusable target would be a link.
    expect(await within(dialog).findAllByRole('link', { name: /^Review / })).not.toHaveLength(0)
    const done = within(dialog).getByRole('button', { name: 'Done' })
    expect(done).toHaveFocus()

    fireEvent.click(done)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('T-4: each group shows its lede, provider, model and edit link, in group order', async () => {
    const body = attentionWireBody()
    vi.mocked(getLlmModels).mockResolvedValue({ rows: rowsFor(body) })
    vi.mocked(getAdminAttention).mockResolvedValue(parseAdminAttentionReport(body))
    const referenced = body.items.find(item => item.kind === 'stale_model_referenced')!
    const deprecatedItem = body.items.find(item => item.kind === 'deprecated_model_enabled')!

    renderSurface()

    const dialog = await openReview()
    const tables = within(dialog).getAllByRole('table')
    expect(tables).toHaveLength(2)
    const ledes = [
      /2 models disappeared from the provider catalog but are still referenced/,
      /1 enabled model is marked deprecated in the provider catalog/,
    ]
    for (const [index, item] of [referenced, deprecatedItem].entries()) {
      const section = tables[index].parentElement!
      expect(section.querySelector('p')).toHaveTextContent(ledes[index])
      const link = await within(tables[index]).findByRole('link', { name: reviewLinkName(item) })
      expect(link).toHaveAttribute('href', CONTROL_ROUTES.llmModels.edit(rowIdOf(body, item)))
      const cells = within(link.closest('tr')!).getAllByRole('cell')
      expect(cells[0]).toHaveTextContent(getProviderDisplayLabel(item.provider))
      expect(cells[1]).toHaveTextContent(String(item.displayName ?? item.model))
    }
  })

  it('T-5: only the referenced group has a Used by column, listing its Hosts', async () => {
    const body = attentionWireBody()
    vi.mocked(getLlmModels).mockResolvedValue({ rows: rowsFor(body) })
    vi.mocked(getAdminAttention).mockResolvedValue(parseAdminAttentionReport(body))
    const referenced = body.items.find(item => item.kind === 'stale_model_referenced')!
    const hosts = referenced.hostsAffected as Array<{ namespace: string; name: string }>

    renderSurface()

    const dialog = await openReview()
    const [referencedTable, deprecatedTable] = within(dialog).getAllByRole('table')
    expect(
      within(referencedTable).getByRole('columnheader', { name: 'Used by' })
    ).toBeInTheDocument()
    const row = within(referencedTable)
      .getByRole('link', { name: reviewLinkName(referenced) })
      .closest('tr')!
    expect(within(row).getByText(`${hosts[0].namespace}/${hosts[0].name}`)).toBeInTheDocument()
    expect(within(row).getByText('1 Host')).toBeInTheDocument()
    // The deprecated item carries references on the wire too; this group does
    // not render them yet.
    expect(
      within(deprecatedTable).queryByRole('columnheader', { name: 'Used by' })
    ).not.toBeInTheDocument()
  })

  it('T-6: shows the id under the name only when they differ', async () => {
    const body = attentionWireBody()
    vi.mocked(getLlmModels).mockResolvedValue({ rows: rowsFor(body) })
    vi.mocked(getAdminAttention).mockResolvedValue(parseAdminAttentionReport(body))
    const deprecatedItem = body.items.find(item => item.kind === 'deprecated_model_enabled')!
    // The generator gives this model a catalog name equal to its id.
    expect(deprecatedItem.displayName).toBe(deprecatedItem.model)
    const staleOnly = body.items.find(item => item.model === 'claude-haiku-4-5')!
    expect(staleOnly.displayName).not.toBe(staleOnly.model)

    renderSurface()

    const dialog = await openReview()
    expect(within(dialog).getAllByText(deprecatedItem.model, { exact: true })).toHaveLength(1)
    expect(within(dialog).getByText(String(staleOnly.displayName))).toBeInTheDocument()
    expect(within(dialog).getByText(staleOnly.model, { exact: true })).toBeInTheDocument()
  })

  // reviewOpen survives `return null` (the banner is not unmounted), so the
  // dialog must be closed when the feed empties or it reappears on its own.
  async function emptyThenRefill(secondFetch: () => void) {
    const body = attentionWireBodyOf('stale_model_referenced')
    vi.mocked(getLlmModels).mockResolvedValue({ rows: [model] })
    vi.mocked(getAdminAttention).mockResolvedValueOnce(parseAdminAttentionReport(body))
    secondFetch()
    vi.mocked(getAdminAttention).mockResolvedValue(parseAdminAttentionReport(body))
    const firstDelete = deferred<undefined>()
    vi.mocked(deleteLlmModel).mockReturnValueOnce(firstDelete.promise)

    renderSurface()

    expect(await findBannerMessage()).toHaveTextContent('2 still referenced')
    fireEvent.click(screen.getByRole('button', { name: 'Delete claude-haiku-4-5' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(vi.mocked(deleteLlmModel)).toHaveBeenCalledTimes(1))
    // The delete is in flight when the operator opens the review.
    await openReview()

    await act(async () => {
      firstDelete.resolve(undefined)
    })
    await waitFor(() => expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // A second delete refetches a feed with items again.
    fireEvent.click(screen.getByRole('button', { name: 'Delete claude-haiku-4-5' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(await findBannerMessage()).toHaveTextContent('2 still referenced')
    expect(vi.mocked(getAdminAttention)).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  }

  it('T-7: an empty refetch closes the dialog, and the banner comes back closed', async () => {
    await emptyThenRefill(() =>
      vi.mocked(getAdminAttention).mockResolvedValueOnce({ items: [], generatedAt: 'x' })
    )
  })

  it('T-8: a failed refetch closes the dialog, and the banner comes back closed', async () => {
    await emptyThenRefill(() =>
      vi.mocked(getAdminAttention).mockRejectedValueOnce(new Error('attention refetch failed'))
    )
  })
})
