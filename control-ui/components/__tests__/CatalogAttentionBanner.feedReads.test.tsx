import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { getProviderDisplayLabel } from '@lib/llm'
import { __resetReadRequestCacheForTests, setReadRequestPrincipal } from '@lib/readRequestCache'
import { acknowledgedWireItem, attentionWireBody } from '../../test/fixtures/llmAttention'
import { CatalogAttentionBanner } from '../LlmModelsSurface/CatalogAttentionBanner'
import { ToastProvider } from '../Toast'

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({ authState: { isLoggedIn: true, isLoading: false } }),
}))

type WireItem = ReturnType<typeof attentionWireBody>['items'][number]

const keyOf = (item: Pick<WireItem, 'kind' | 'provider' | 'model'>) =>
  `${item.kind}/${item.provider}/${item.model}`

function itemName(item: WireItem): string {
  return `${String(item.displayName ?? item.model)} (${getProviderDisplayLabel(item.provider)} · ${item.model})`
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * control-api at the network boundary: the feed is the generated wire body with
 * the acknowledged items flagged, snapshotted when the GET reaches the server
 * (as the real route reads the database then). A held GET answers only when
 * released, and rejects like the browser's fetch once its signal aborts.
 */
function stubControlApi(items: WireItem[]) {
  const acked = new Set<string>()
  const held: Array<() => void> = []
  let getsToHold = 0
  const feedReads: string[] = []

  const snapshot = () => ({
    items: items.map(item => (acked.has(keyOf(item)) ? acknowledgedWireItem(item) : item)),
    generatedAt: 'x',
  })

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://control-ui.test')
    const method = init.method ?? 'GET'
    if (url.pathname.endsWith('/api/v1/admin/attention') && method === 'GET') {
      feedReads.push(url.search)
      const body = snapshot()
      if (getsToHold === 0) return jsonResponse(body)
      getsToHold -= 1
      return new Promise<Response>((resolve, reject) => {
        const signal = init.signal
        const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        held.push(() => resolve(jsonResponse(body)))
      })
    }
    if (url.pathname.endsWith('/api/v1/admin/attention/ack') && method === 'POST') {
      const sent = JSON.parse(String(init.body)) as WireItem
      acked.add(keyOf(sent))
      return new Response(null, { status: 204 })
    }
    throw new Error(`unexpected request ${method} ${url.pathname}`)
  })

  return {
    fetchStub,
    feedReads,
    holdNextGet: () => {
      getsToHold += 1
    },
    releaseHeld: () => {
      for (const release of held.splice(0)) release()
    },
  }
}

function renderBanner(refreshSignal: number) {
  return render(
    <ToastProvider>
      <CatalogAttentionBanner refreshSignal={refreshSignal} />
    </ToastProvider>
  )
}

function rerenderBanner(rerender: (ui: ReactNode) => void, refreshSignal: number) {
  rerender(
    <ToastProvider>
      <CatalogAttentionBanner refreshSignal={refreshSignal} />
    </ToastProvider>
  )
}

describe('catalog attention feed reads over the real client', () => {
  let items: WireItem[]
  let deprecated: WireItem
  let api: ReturnType<typeof stubControlApi>

  beforeEach(() => {
    __resetReadRequestCacheForTests()
    setReadRequestPrincipal('admin-one', 'admin')
    items = attentionWireBody().items
    deprecated = items.find(item => item.kind === 'deprecated_model_enabled')!
    api = stubControlApi(items)
    vi.stubGlobal('fetch', api.fetchStub)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    __resetReadRequestCacheForTests()
  })

  it('reloads after an acknowledgement with a fresh read, never the read still in flight from before it', async () => {
    const { rerender } = renderBanner(0)
    fireEvent.click(await screen.findByRole('button', { name: 'Review models' }))
    const dialog = await screen.findByRole('dialog')

    // A surface refresh is still waiting on the server when the operator acts;
    // its answer was read before the acknowledgement.
    api.holdNextGet()
    rerenderBanner(rerender, 1)
    await waitFor(() => expect(api.feedReads).toHaveLength(2))

    fireEvent.click(
      within(dialog).getByRole('button', { name: `Mark reviewed: ${itemName(deprecated)}` })
    )

    await waitFor(() =>
      expect(api.fetchStub).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/admin/attention/ack'),
        expect.objectContaining({ method: 'POST' })
      )
    )
    // Let the reload that follows the acknowledgement start before the older
    // read answers, so the two overlap.
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
    await act(async () => api.releaseHeld())

    expect(
      await within(dialog).findByRole('button', { name: `Undo review: ${itemName(deprecated)}` })
    ).toBeInTheDocument()
    expect(
      within(dialog).queryByRole('button', { name: `Mark reviewed: ${itemName(deprecated)}` })
    ).not.toBeInTheDocument()
    expect(screen.getByText(/Models need review/)).not.toHaveTextContent('deprecated')
    // The reload reached the server on its own instead of joining the older read.
    expect(api.feedReads).toHaveLength(3)
  })

  it('keeps the banner and the open dialog when a superseded read is aborted', async () => {
    const { rerender } = renderBanner(0)
    fireEvent.click(await screen.findByRole('button', { name: 'Review models' }))
    const dialog = await screen.findByRole('dialog')

    // A refresh is waiting on the server when a newer one replaces it: the
    // first read is aborted and rejects, the second is still on its way.
    api.holdNextGet()
    rerenderBanner(rerender, 1)
    await waitFor(() => expect(api.feedReads).toHaveLength(2))
    api.holdNextGet()
    rerenderBanner(rerender, 2)
    await waitFor(() => expect(api.feedReads).toHaveLength(3))
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))

    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(screen.getByText(/Models need review/)).toBeInTheDocument()

    await act(async () => api.releaseHeld())

    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(
      within(dialog).getByRole('button', { name: `Mark reviewed: ${itemName(deprecated)}` })
    ).toBeInTheDocument()
  })
})
