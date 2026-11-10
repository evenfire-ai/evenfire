import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  sumProviderCounts,
  syncResultCase,
  syncResultLegacyCase,
} from '../../test/fixtures/llmCatalogSyncResult'
import { parseDiscoverySyncResult, syncDiscovery } from '../api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('catalog sync api helper', () => {
  it('POSTs the sync and sums auto-enabled models over every provider', async () => {
    const body = syncResultCase('decidable_auto_enabled')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body))

    const result = await syncDiscovery()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/llm-models/discovery/sync')
    expect(init.method).toBe('POST')
    expect(result).toMatchObject({
      source: 'live',
      added: body.added,
      updated: body.updated,
      staled: body.staled,
      ranAt: body.ranAt,
      decidable: true,
    })
    expect(result.outcome).toEqual({
      autoEnabled: sumProviderCounts(body, 'autoEnabled'),
      heldUndecidable: 0,
      deferredByCap: 0,
    })
    // More than one provider contributes, so reading one cannot pass.
    const contributing = Object.values(body.providerCounts ?? {}).filter(c => c.autoEnabled > 0)
    expect(contributing.length).toBeGreaterThanOrEqual(2)
  })

  it('reports an undecidable run and the models it held back', async () => {
    const body = syncResultCase('undecidable_vendored')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body))

    const result = await syncDiscovery()

    expect(result.source).toBe('vendored')
    expect(result.decidable).toBe(false)
    expect(result.outcome?.heldUndecidable).toBe(sumProviderCounts(body, 'skippedUndecidable'))
    expect(result.outcome?.heldUndecidable).toBeGreaterThan(0)
  })

  it('sums models deferred by the cap', () => {
    const body = syncResultCase('decidable_capped')
    const result = parseDiscoverySyncResult(body)
    expect(result.outcome?.deferredByCap).toBe(sumProviderCounts(body, 'deferredByCap'))
    expect(result.outcome?.autoEnabled).toBe(sumProviderCounts(body, 'autoEnabled'))
  })

  it('reads a body from an older control-api as unknown, not as nothing enabled', async () => {
    const body = syncResultLegacyCase('decidable_auto_enabled')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body))

    const result = await syncDiscovery()

    expect(result.decidable).toBeNull()
    expect(result.outcome).toBeNull()
    expect(result.added).toBe(body.added)
  })

  it('reads an unknown source as the vendored fallback', () => {
    const body = { ...syncResultCase('decidable_auto_enabled'), source: 'mirror' }
    expect(parseDiscoverySyncResult(body).source).toBe('vendored')
  })
})
