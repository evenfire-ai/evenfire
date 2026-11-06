import { describe, expect, it } from 'vitest'
import type { LlmDiscoverySyncResult } from '../api'
import { describeDiscoverySync } from '../llmDiscoverySync'

// Helper inputs, not wire bodies: the parsed shape the panel hands over. The
// wire-derived cases are exercised through the panel tests.
function result(overrides: Partial<LlmDiscoverySyncResult>): LlmDiscoverySyncResult {
  return {
    source: 'live',
    fetchedAt: '2026-08-12T00:00:00.000Z',
    ranAt: '2026-08-12T00:00:05.000Z',
    added: 5,
    updated: 12,
    staled: 0,
    decidable: true,
    outcome: { autoEnabled: 0, heldUndecidable: 0, deferredByCap: 0 },
    ...overrides,
  }
}

const BASE = 'Synced from live: +5 new, 12 updated, 0 marked stale.'

describe('describeDiscoverySync', () => {
  it('older control-api: the counters only', () => {
    expect(describeDiscoverySync(result({ decidable: null, outcome: null }))).toEqual({
      toast: BASE,
      notice: null,
    })
  })

  it('decidable, nothing enabled or deferred: the counters only', () => {
    expect(describeDiscoverySync(result({}))).toEqual({ toast: BASE, notice: null })
  })

  it('decidable with auto-enabled models: counts them inside "+N new" and points to the Catalog', () => {
    expect(
      describeDiscoverySync(
        result({ outcome: { autoEnabled: 3, heldUndecidable: 0, deferredByCap: 0 } })
      )
    ).toEqual({
      toast:
        'Synced from live: +5 new (3 enabled automatically), 12 updated, 0 marked stale. Enabled models are in the Catalog tab.',
      notice: null,
    })
  })

  it('decidable with models deferred by the cap: an info notice, toast unchanged', () => {
    const d = describeDiscoverySync(
      result({ outcome: { autoEnabled: 2, heldUndecidable: 0, deferredByCap: 7 } })
    )
    expect(d.toast).toContain('(2 enabled automatically)')
    expect(d.notice).toEqual({
      tone: 'info',
      message:
        '7 more new models were not added yet (auto-enable limit for this run reached); run the sync again to add them.',
    })
  })

  it('pluralizes a single deferred model', () => {
    const d = describeDiscoverySync(
      result({ outcome: { autoEnabled: 1, heldUndecidable: 0, deferredByCap: 1 } })
    )
    expect(d.notice?.message).toMatch(/^1 more new model was not added yet/)
  })

  it('undecidable vendored run with models held back: blames reachability', () => {
    const d = describeDiscoverySync(
      result({
        source: 'vendored',
        decidable: false,
        outcome: { autoEnabled: 0, heldUndecidable: 4, deferredByCap: 0 },
      })
    )
    expect(d.toast).toBe('Synced from vendored: +5 new, 12 updated, 0 marked stale.')
    expect(d.notice).toEqual({
      tone: 'warn',
      message:
        'Auto-enable could not decide this run (the live catalog could not be reached): 4 new models from providers with auto-enable on were not added; run the sync again once it is reachable.',
    })
  })

  it('undecidable live run with models held back: blames an incomplete catalog, not reachability', () => {
    const d = describeDiscoverySync(
      result({
        source: 'live',
        decidable: false,
        outcome: { autoEnabled: 0, heldUndecidable: 4, deferredByCap: 0 },
      })
    )
    expect(d.toast).toBe(BASE)
    expect(d.notice).toEqual({
      tone: 'warn',
      message:
        'Auto-enable could not decide this run (the live catalog looked incomplete): 4 new models from providers with auto-enable on were not added; run the sync again.',
    })
    expect(d.notice?.message).not.toMatch(/could not be reached|reachable/)
  })

  it('pluralizes a single held model', () => {
    const d = describeDiscoverySync(
      result({
        decidable: false,
        outcome: { autoEnabled: 0, heldUndecidable: 1, deferredByCap: 0 },
      })
    )
    expect(d.notice?.message).toContain(
      ': 1 new model from providers with auto-enable on was not added;'
    )
  })

  it('undecidable with nothing held back: no notice', () => {
    expect(describeDiscoverySync(result({ decidable: false }))).toEqual({
      toast: BASE,
      notice: null,
    })
  })

  it('a decided flag without a breakdown claims nothing about auto-enable', () => {
    expect(describeDiscoverySync(result({ decidable: false, outcome: null }))).toEqual({
      toast: BASE,
      notice: null,
    })
    expect(describeDiscoverySync(result({ decidable: true, outcome: null }))).toEqual({
      toast: BASE,
      notice: null,
    })
  })

  it('never reports enabled models for an undecidable run', () => {
    const d = describeDiscoverySync(
      result({
        decidable: false,
        outcome: { autoEnabled: 2, heldUndecidable: 0, deferredByCap: 0 },
      })
    )
    expect(d.toast).toBe(BASE)
  })
})
