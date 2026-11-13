import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AdminAttentionReport, LlmAllowedModel } from '@lib/api'
import {
  ackAdminAttention,
  formatApiError,
  getAdminAttention,
  getLlmModels,
  getUnpricedModels,
  parseAdminAttentionReport,
  unackAdminAttention,
  updateLlmModel,
} from '@lib/api'
import { getProviderDisplayLabel } from '@lib/llm'
import {
  acknowledgedWireItem,
  attentionWireBody,
  withRecipesWireItem,
} from '../../test/fixtures/llmAttention'
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
vi.mock('@components/LlmModelTable', () => ({
  LlmModelTable: () => <div>Model catalog</div>,
}))
vi.mock('@lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/api')>()
  return {
    ...actual,
    getLlmModels: vi.fn(),
    getUnpricedModels: vi.fn(),
    getAdminAttention: vi.fn(),
    ackAdminAttention: vi.fn(),
    unackAdminAttention: vi.fn(),
    updateLlmModel: vi.fn(),
  }
})

type WireItem = ReturnType<typeof attentionWireBody>['items'][number]

const BANNER_TEXT = /Models need review/

function structuredApiError(status: number, body: Record<string, unknown>): Error {
  const text = JSON.stringify(body)
  const res = new Response(text, { status, headers: { 'content-type': 'application/json' } })
  return formatApiError(res, text)
}

// The 409 control-api's `POST /admin/attention/ack` answers when the episode moved on.
function episodeChangedError(): Error {
  return structuredApiError(409, {
    error: 'attention_episode_changed',
    message:
      'the model changed since this attention item was loaded (new episode, or no longer enabled); reload the feed',
  })
}

const keyOf = (item: Pick<WireItem, 'kind' | 'provider' | 'model'>) =>
  `${item.kind}/${item.provider}/${item.model}`
const pairOf = (item: Pick<WireItem, 'provider' | 'model'>) => `${item.provider}/${item.model}`

const baseRow: LlmAllowedModel = {
  id: 'row',
  provider: 'claude',
  model: 'x',
  vendor: 'Anthropic',
  display_name: null,
  context_window_tokens: null,
  enabled: true,
  source: 'discovery',
  stale: true,
  discovered_at: null,
  last_seen_at: null,
  auto_disabled_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

/** One allowlist row per distinct pair, so every item resolves to a model id. */
function rowsFor(items: WireItem[]): LlmAllowedModel[] {
  const pairs = [...new Set(items.map(pairOf))]
  return pairs.map(pair => {
    const item = items.find(candidate => pairOf(candidate) === pair)!
    return { ...baseRow, id: `row:${pair}`, provider: item.provider, model: item.model }
  })
}

/**
 * The feed as control-api serves it: the generated items, with those the test
 * acknowledged flagged (or omitted without `includeAcknowledged`), run through
 * the real client parser.
 */
function serveFeed(items: WireItem[], acked: Set<string>) {
  vi.mocked(getAdminAttention).mockImplementation(async opts => {
    const served = items
      .map(item => (acked.has(keyOf(item)) ? acknowledgedWireItem(item) : item))
      .filter(item => opts?.includeAcknowledged || item.acknowledged !== true)
    return parseAdminAttentionReport({ items: served, generatedAt: 'x' })
  })
}

function renderSurface() {
  return render(
    <ToastProvider>
      <LlmModelsSurface activeTab="catalog" />
    </ToastProvider>
  )
}

async function openReview() {
  fireEvent.click(await screen.findByRole('button', { name: 'Review models' }))
  return screen.findByRole('dialog')
}

function itemName(item: WireItem): string {
  return `${String(item.displayName ?? item.model)} (${getProviderDisplayLabel(item.provider)} · ${item.model})`
}

/** The pending row of an item: the one carrying its `Mark reviewed` button. */
function pendingRow(dialog: HTMLElement, item: WireItem): HTMLElement {
  return within(dialog)
    .getByRole('button', { name: `Mark reviewed: ${itemName(item)}` })
    .closest('tr')!
}

function reviewedSection(dialog: HTMLElement): HTMLElement {
  return within(dialog)
    .getByText(/^Reviewed \(\d+\)$/)
    .closest('details')!
}

describe('catalog attention dialog actions', () => {
  let items: WireItem[]
  let acked: Set<string>
  let stale: WireItem
  let otherStale: WireItem
  let deprecated: WireItem

  beforeEach(() => {
    items = attentionWireBody().items
    acked = new Set()
    stale = items.find(item => item.model === 'claude-fable-5-1')!
    otherStale = items.find(item => item.model === 'claude-haiku-4-5')!
    deprecated = items.find(item => item.kind === 'deprecated_model_enabled')!
    vi.mocked(getLlmModels).mockResolvedValue({ rows: rowsFor(items) })
    vi.mocked(getUnpricedModels).mockResolvedValue({ rows: [] })
    vi.mocked(updateLlmModel).mockImplementation(async id => ({ ...baseRow, id }))
    vi.mocked(ackAdminAttention).mockImplementation(async item => {
      acked.add(keyOf(item))
    })
    vi.mocked(unackAdminAttention).mockImplementation(async item => {
      acked.delete(keyOf(item))
    })
    serveFeed(items, acked)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('reads the feed with the acknowledged items', async () => {
    renderSurface()
    await screen.findByText(BANNER_TEXT)
    expect(vi.mocked(getAdminAttention).mock.calls[0][0]).toMatchObject({
      includeAcknowledged: true,
    })
  })

  it('Keep enabled pins the model on, then acknowledges, and the item moves to Reviewed', async () => {
    renderSurface()
    const dialog = await openReview()

    fireEvent.click(
      within(pendingRow(dialog, stale)).getByRole('button', {
        name: `Keep enabled: ${itemName(stale)}`,
      })
    )

    await waitFor(() =>
      expect(
        within(dialog).queryByRole('button', { name: `Mark reviewed: ${itemName(stale)}` })
      ).not.toBeInTheDocument()
    )
    expect(vi.mocked(updateLlmModel)).toHaveBeenCalledWith(`row:${pairOf(stale)}`, {
      enabled: true,
      pinEnabled: true,
    })
    expect(vi.mocked(ackAdminAttention)).toHaveBeenCalledTimes(1)
    const [acknowledged] = vi.mocked(ackAdminAttention).mock.calls[0]
    expect(acknowledged).toMatchObject({
      kind: stale.kind,
      provider: stale.provider,
      model: stale.model,
      episode: stale.episode,
      consumerKeys: stale.consumerKeys,
    })
    // The PUT is the decision; the acknowledgement only follows it.
    expect(vi.mocked(updateLlmModel).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ackAdminAttention).mock.invocationCallOrder[0]
    )
    const reviewed = reviewedSection(dialog)
    expect(reviewed).not.toHaveAttribute('open')
    expect(
      within(reviewed).getByRole('button', { name: `Undo review: ${itemName(stale)}` })
    ).toBeInTheDocument()
    expect(screen.getByText(BANNER_TEXT)).not.toHaveTextContent('2 still referenced')
    expect(screen.getByText(BANNER_TEXT)).toHaveTextContent('1 still referenced')
  })

  it('keeps the item and shows the error when the PUT lands but the acknowledgement fails; a retry finishes it', async () => {
    vi.mocked(ackAdminAttention).mockRejectedValueOnce(new Error('Network error'))
    renderSurface()
    const dialog = await openReview()
    const keepName = `Keep enabled: ${itemName(stale)}`

    fireEvent.click(within(pendingRow(dialog, stale)).getByRole('button', { name: keepName }))

    const alert = await within(pendingRow(dialog, stale)).findByRole('alert')
    expect(alert).toHaveTextContent(/Kept enabled, but marking it as reviewed failed/)
    expect(alert).toHaveTextContent(/Network error/)
    // Not undone: the PUT ran once and no reverse PUT followed.
    expect(vi.mocked(updateLlmModel)).toHaveBeenCalledTimes(1)
    const retry = within(pendingRow(dialog, stale)).getByRole('button', { name: keepName })
    await waitFor(() => expect(retry).toBeEnabled())

    fireEvent.click(retry)

    await waitFor(() =>
      expect(
        within(dialog).queryByRole('button', { name: `Mark reviewed: ${itemName(stale)}` })
      ).not.toBeInTheDocument()
    )
    expect(vi.mocked(ackAdminAttention)).toHaveBeenCalledTimes(2)
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reloads the feed and tells the operator when the item changed (409 attention_episode_changed)', async () => {
    vi.mocked(ackAdminAttention).mockRejectedValueOnce(episodeChangedError())
    renderSurface()
    const dialog = await openReview()
    const readsBefore = vi.mocked(getAdminAttention).mock.calls.length

    fireEvent.click(
      within(pendingRow(dialog, deprecated)).getByRole('button', {
        name: `Mark reviewed: ${itemName(deprecated)}`,
      })
    )

    expect(await screen.findByText('This item changed, review it again.')).toBeInTheDocument()
    await waitFor(() =>
      expect(vi.mocked(getAdminAttention).mock.calls.length).toBeGreaterThan(readsBefore)
    )
    // Still to review, and no error is pinned to it.
    expect(pendingRow(dialog, deprecated)).toBeInTheDocument()
    expect(within(pendingRow(dialog, deprecated)).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Reviewed only acknowledges; Undo removes the acknowledgement and the item comes back', async () => {
    renderSurface()
    const dialog = await openReview()

    fireEvent.click(
      within(pendingRow(dialog, deprecated)).getByRole('button', {
        name: `Mark reviewed: ${itemName(deprecated)}`,
      })
    )
    const undoName = `Undo review: ${itemName(deprecated)}`
    const undo = await within(dialog).findByRole('button', { name: undoName })
    expect(vi.mocked(updateLlmModel)).not.toHaveBeenCalled()
    expect(vi.mocked(ackAdminAttention)).toHaveBeenCalledTimes(1)
    expect(screen.getByText(BANNER_TEXT)).not.toHaveTextContent('deprecated')

    fireEvent.click(undo)

    expect(
      await within(dialog).findByRole('button', { name: `Mark reviewed: ${itemName(deprecated)}` })
    ).toBeInTheDocument()
    expect(vi.mocked(unackAdminAttention)).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: deprecated.kind,
        provider: deprecated.provider,
        model: deprecated.model,
      })
    )
    expect(within(dialog).queryByRole('button', { name: undoName })).not.toBeInTheDocument()
    expect(screen.getByText(BANNER_TEXT)).toHaveTextContent('1 deprecated')
  })

  it('locks only the buttons of the item whose action is in flight', async () => {
    let finishPut: () => void = () => undefined
    vi.mocked(updateLlmModel).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishPut = () => resolve({ ...baseRow })
        })
    )
    renderSurface()
    const dialog = await openReview()

    fireEvent.click(
      within(pendingRow(dialog, stale)).getByRole('button', {
        name: `Keep enabled: ${itemName(stale)}`,
      })
    )

    const busyRow = pendingRow(dialog, stale)
    await waitFor(() =>
      expect(
        within(busyRow).getByRole('button', { name: `Mark reviewed: ${itemName(stale)}` })
      ).toBeDisabled()
    )
    expect(
      within(busyRow).getByRole('button', { name: `Keep enabled: ${itemName(stale)}` })
    ).toBeDisabled()
    expect(
      within(pendingRow(dialog, otherStale)).getByRole('button', {
        name: `Mark reviewed: ${itemName(otherStale)}`,
      })
    ).toBeEnabled()

    await act(async () => finishPut())
  })

  it('counts only items still to review in the banner', async () => {
    acked.add(keyOf(deprecated))
    renderSurface()

    const banner = await screen.findByText(BANNER_TEXT)
    expect(banner).toHaveTextContent('Models need review: 2 still referenced')
    expect(banner).not.toHaveTextContent('deprecated')
  })

  it('shows a neutral line, not the review warning, when every item is reviewed; Undo stays reachable', async () => {
    for (const item of items) acked.add(keyOf(item))
    renderSurface()

    const line = await screen.findByText(`${items.length} models reviewed`)
    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument()
    expect(line.closest('.cu-banner')).not.toHaveClass('cu-banner--warning')

    fireEvent.click(screen.getByRole('button', { name: 'Show reviewed' }))
    const dialog = await screen.findByRole('dialog')
    expect(reviewedSection(dialog)).toHaveAttribute('open')

    fireEvent.click(
      within(dialog).getByRole('button', { name: `Undo review: ${itemName(deprecated)}` })
    )

    // The undone item needs review again, so the warning line comes back.
    expect(
      await within(dialog).findByRole('button', { name: `Mark reviewed: ${itemName(deprecated)}` })
    ).toBeInTheDocument()
    expect(vi.mocked(unackAdminAttention)).toHaveBeenCalledTimes(1)
    expect(screen.getByText(BANNER_TEXT)).toHaveTextContent('1 deprecated')
  })

  it('keeps the dialog open with focus inside when the last pending item is reviewed', async () => {
    for (const item of items) if (item !== deprecated) acked.add(keyOf(item))
    renderSurface()
    const dialog = await openReview()
    const reviewedButton = within(dialog).getByRole('button', {
      name: `Mark reviewed: ${itemName(deprecated)}`,
    })
    reviewedButton.focus()

    fireEvent.click(reviewedButton)

    // The acted-on row moves to Reviewed, which opens since nothing else is left.
    const undo = await within(dialog).findByRole('button', {
      name: `Undo review: ${itemName(deprecated)}`,
    })
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(reviewedSection(dialog)).toContainElement(undo)
    expect(reviewedSection(dialog)).toHaveAttribute('open')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Done' })).toHaveFocus())
    expect(screen.getByText(`${items.length} models reviewed`)).toBeInTheDocument()
    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument()
  })
})

describe('catalog attention dialog Used by', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the recipes naming the model and an all-models Host legibly', async () => {
    const body = attentionWireBody()
    const implicitItem = body.items.find(item => item.model === 'claude-haiku-4-5')!
    const items = body.items.map(item =>
      item === implicitItem
        ? withRecipesWireItem(item, [{ namespace: 'sandbox-recipes', name: 'nightly-summary' }])
        : item
    )
    vi.mocked(getLlmModels).mockResolvedValue({ rows: rowsFor(items) })
    vi.mocked(getUnpricedModels).mockResolvedValue({ rows: [] })
    serveFeed(items, new Set())

    renderSurface()
    const dialog = await openReview()

    const row = pendingRow(dialog, implicitItem)
    expect(within(row).getByText('1 recipe')).toBeInTheDocument()
    expect(within(row).getByText('sandbox-recipes/nightly-summary')).toBeInTheDocument()
    expect(within(row).getByText('mcp-host/agent-a')).toBeInTheDocument()
    expect(within(row).getByText('(allows all models)')).toBeInTheDocument()
    expect(within(row).queryByText(/implicit/)).not.toBeInTheDocument()
  })
})

describe('catalog attention feed ordering', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('never lets an older feed response that lands late overwrite a newer one', async () => {
    const items = attentionWireBody().items
    const stale = items.find(item => item.model === 'claude-fable-5-1')!
    const deprecated = items.find(item => item.kind === 'deprecated_model_enabled')!
    const acked = new Set<string>()
    vi.mocked(getLlmModels).mockResolvedValue({ rows: rowsFor(items) })
    vi.mocked(getUnpricedModels).mockResolvedValue({ rows: [] })
    serveFeed(items, acked)
    vi.mocked(ackAdminAttention).mockImplementation(async item => {
      acked.add(keyOf(item))
    })

    renderSurface()
    const dialog = await openReview()

    // The reload after the first acknowledgement stalls; it was read before the
    // second one, so it still shows the deprecated item pending.
    let releaseFirstReload: () => void = () => undefined
    const feedAfterFirstAck = parseAdminAttentionReport({
      items: items.map(item => (item === stale ? acknowledgedWireItem(item) : item)),
      generatedAt: 'x',
    })
    vi.mocked(getAdminAttention).mockImplementationOnce(
      () =>
        new Promise<AdminAttentionReport>(resolve => {
          releaseFirstReload = () => resolve(feedAfterFirstAck)
        })
    )

    fireEvent.click(
      within(dialog).getByRole('button', { name: `Mark reviewed: ${itemName(stale)}` })
    )
    await waitFor(() => expect(vi.mocked(ackAdminAttention)).toHaveBeenCalledTimes(1))
    fireEvent.click(
      within(dialog).getByRole('button', { name: `Mark reviewed: ${itemName(deprecated)}` })
    )
    // The second reload lands first, with both acknowledged.
    await within(dialog).findByRole('button', { name: `Undo review: ${itemName(deprecated)}` })

    await act(async () => releaseFirstReload())

    expect(
      within(dialog).getByRole('button', { name: `Undo review: ${itemName(deprecated)}` })
    ).toBeInTheDocument()
    expect(
      within(dialog).queryByRole('button', { name: `Mark reviewed: ${itemName(deprecated)}` })
    ).not.toBeInTheDocument()
    expect(screen.getByText(BANNER_TEXT)).not.toHaveTextContent('deprecated')
  })
})
