/**
 * Tests for signalStore.ts
 * Steps 4.1 + 4.6 combined (G-01 + G-15)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type WorkflowSignal, drainSignals, enqueueSignal } from '../../../src/workflow/signalStore'

// Reset the module-level Map between tests by draining any leftover signals
beforeEach(() => {
  // Drain any leftovers from prior tests for the recipe names used here
  drainSignals('recipe-a')
  drainSignals('recipe-b')
  drainSignals('recipe-overflow')
  drainSignals('unknown-recipe')
})

function makeSignal(
  type: WorkflowSignal['type'] = 'cancel',
  overrides: Partial<WorkflowSignal> = {}
): WorkflowSignal {
  return {
    type,
    requestId: 'req-' + Math.random().toString(36).slice(2),
    receivedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ─── Step 4.1: core enqueue / drain ─────────────────────────────────────────

describe('signalStore — enqueue and drain', () => {
  it('enqueues a single signal and drain returns it', () => {
    const sig = makeSignal('cancel')
    enqueueSignal('recipe-a', sig)
    const drained = drainSignals('recipe-a')
    expect(drained).toHaveLength(1)
    expect(drained[0]).toEqual(sig)
  })

  it('drain empties the store — second drain returns []', () => {
    enqueueSignal('recipe-a', makeSignal('pause'))
    drainSignals('recipe-a') // first drain
    const second = drainSignals('recipe-a')
    expect(second).toHaveLength(0)
  })

  it('preserves insertion order across multiple enqueues', () => {
    const s1 = makeSignal('cancel', { requestId: 'r1' })
    const s2 = makeSignal('pause', { requestId: 'r2' })
    const s3 = makeSignal('resume', { requestId: 'r3' })
    enqueueSignal('recipe-a', s1)
    enqueueSignal('recipe-a', s2)
    enqueueSignal('recipe-a', s3)
    const drained = drainSignals('recipe-a')
    expect(drained.map(s => s.requestId)).toEqual(['r1', 'r2', 'r3'])
  })

  it('unknown recipe drain returns empty array', () => {
    const result = drainSignals('unknown-recipe')
    expect(result).toEqual([])
  })

  it('isolation: signals for recipe-a are not returned by drain for recipe-b', () => {
    enqueueSignal('recipe-a', makeSignal('cancel'))
    const bSignals = drainSignals('recipe-b')
    expect(bSignals).toHaveLength(0)
    // recipe-a signals still intact
    const aSignals = drainSignals('recipe-a')
    expect(aSignals).toHaveLength(1)
  })

  it('signals for two different recipes are independent', () => {
    const sa = makeSignal('cancel', { requestId: 'a1' })
    const sb = makeSignal('pause', { requestId: 'b1' })
    enqueueSignal('recipe-a', sa)
    enqueueSignal('recipe-b', sb)

    const drainedA = drainSignals('recipe-a')
    const drainedB = drainSignals('recipe-b')

    expect(drainedA).toHaveLength(1)
    expect(drainedA[0].requestId).toBe('a1')
    expect(drainedB).toHaveLength(1)
    expect(drainedB[0].requestId).toBe('b1')
  })

  it('enqueues signal with optional payload field', () => {
    const sig = makeSignal('approval', { payload: { decision: 'approve' } })
    enqueueSignal('recipe-a', sig)
    const drained = drainSignals('recipe-a')
    expect(drained[0].payload).toEqual({ decision: 'approve' })
  })

  it('drain returns a copy — the store is cleared after drain', () => {
    enqueueSignal('recipe-a', makeSignal('cancel'))
    const d1 = drainSignals('recipe-a')
    const d2 = drainSignals('recipe-a')
    expect(d1).toHaveLength(1)
    expect(d2).toHaveLength(0)
  })
})

// ─── Step 4.6: overflow / security cap ──────────────────────────────────────

describe('signalStore — overflow cap (SIGNAL_STORE_MAX = 100)', () => {
  it('accepts exactly 100 signals (the cap)', () => {
    for (let i = 0; i < 100; i++) {
      enqueueSignal('recipe-overflow', makeSignal('cancel', { requestId: `r${i}` }))
    }
    const drained = drainSignals('recipe-overflow')
    expect(drained).toHaveLength(100)
  })

  it('silently drops the 101st signal — drain still returns 100', () => {
    for (let i = 0; i < 101; i++) {
      enqueueSignal('recipe-overflow', makeSignal('cancel', { requestId: `r${i}` }))
    }
    const drained = drainSignals('recipe-overflow')
    expect(drained).toHaveLength(100)
  })

  it('drain after overflow returns all 100 capped signals in insertion order', () => {
    for (let i = 0; i < 105; i++) {
      enqueueSignal('recipe-overflow', makeSignal('pause', { requestId: `r${i}` }))
    }
    const drained = drainSignals('recipe-overflow')
    // First 100 are retained, 101-105 are dropped
    expect(drained).toHaveLength(100)
    expect(drained[0].requestId).toBe('r0')
    expect(drained[99].requestId).toBe('r99')
  })

  it('after draining a full store, new enqueues are accepted again', () => {
    for (let i = 0; i < 100; i++) {
      enqueueSignal('recipe-overflow', makeSignal('cancel', { requestId: `old${i}` }))
    }
    drainSignals('recipe-overflow') // clears the store

    enqueueSignal('recipe-overflow', makeSignal('resume', { requestId: 'new1' }))
    const drained = drainSignals('recipe-overflow')
    expect(drained).toHaveLength(1)
    expect(drained[0].requestId).toBe('new1')
  })
})

// ─── Eviction: drainSignals cleans up both stores ─────────────────────────

describe('signalStore — eviction cleanup', () => {
  it('drainSignals removes the recipe entry entirely — no stale keys remain', () => {
    enqueueSignal('recipe-a', makeSignal('cancel'))
    const drained = drainSignals('recipe-a')
    expect(drained).toHaveLength(1)
    // Second drain proves the entry is fully gone
    expect(drainSignals('recipe-a')).toHaveLength(0)
  })
})

// ─── TTL eviction: always sweeps regardless of store size ────────────────────

describe('signalStore — TTL eviction (STALE_TTL_MS = 30min)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // Clean up any test recipes
    drainSignals('recipe-stale')
    drainSignals('recipe-fresh')
    drainSignals('recipe-ttl-trigger')
  })

  it('evicts stale entry on next enqueue even when store is below MAX_RECIPES', () => {
    // Enqueue a signal at t=0
    const t0 = Date.now()
    vi.spyOn(Date, 'now').mockReturnValueOnce(t0)
    enqueueSignal('recipe-stale', makeSignal('cancel', { requestId: 'stale-1' }))

    // Advance time by 31 minutes (past STALE_TTL_MS = 30min)
    const t31 = t0 + 31 * 60 * 1000
    vi.spyOn(Date, 'now').mockReturnValue(t31)

    // Trigger eviction by enqueuing to a different recipe
    enqueueSignal('recipe-ttl-trigger', makeSignal('cancel', { requestId: 'new-1' }))

    // Stale recipe signals should be gone
    const staleResult = drainSignals('recipe-stale')
    expect(staleResult).toHaveLength(0)
  })

  it('does NOT evict fresh entry that is within TTL', () => {
    const t0 = Date.now()
    vi.spyOn(Date, 'now').mockReturnValueOnce(t0)
    enqueueSignal('recipe-fresh', makeSignal('cancel', { requestId: 'fresh-1' }))

    // Advance only 5 minutes — well within 30min TTL
    const t5 = t0 + 5 * 60 * 1000
    vi.spyOn(Date, 'now').mockReturnValue(t5)

    enqueueSignal('recipe-ttl-trigger', makeSignal('cancel', { requestId: 'trigger-1' }))

    // Fresh recipe should still have its signal
    const freshResult = drainSignals('recipe-fresh')
    expect(freshResult).toHaveLength(1)
    expect(freshResult[0].requestId).toBe('fresh-1')
  })
})
