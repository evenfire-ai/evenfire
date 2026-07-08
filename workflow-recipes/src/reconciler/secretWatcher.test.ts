import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OWNER_RECIPE_LABEL_KEY, SHARED_LABEL_KEY } from './secretOwnership'
import { SecretReverseIndex } from './secretReverseIndex'
import { SecretWatcher } from './secretWatcher'

const DEBOUNCE_MS = 200

function buildHarness(): {
  watcher: SecretWatcher
  enqueued: string[]
  reverseIndex: SecretReverseIndex
} {
  const reverseIndex = new SecretReverseIndex()
  const enqueued: string[] = []
  const watcher = new SecretWatcher(
    reverseIndex,
    name => {
      enqueued.push(name)
    },
    DEBOUNCE_MS
  )
  return { watcher, enqueued, reverseIndex }
}

describe('SecretWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('enqueues a reconcile for every recipe referencing a newly added Secret', () => {
    const { watcher, enqueued, reverseIndex } = buildHarness()
    reverseIndex.set('recipe-a', ['my-secret'])
    reverseIndex.set('recipe-b', ['my-secret'])

    watcher.handleEvent('ADDED', {
      metadata: { name: 'my-secret' },
      data: { token: 'eA==' },
    })
    expect(enqueued).toEqual([])

    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued.sort()).toEqual(['recipe-a', 'recipe-b'])
  })

  it('does not enqueue when the Secret has no dependent recipes', () => {
    const { watcher, enqueued } = buildHarness()
    watcher.handleEvent('ADDED', {
      metadata: { name: 'orphan-secret' },
      data: { token: 'eA==' },
    })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued).toEqual([])
  })

  it('skips reconcile when the key-set is unchanged (metadata-only update)', () => {
    const { watcher, enqueued, reverseIndex } = buildHarness()
    reverseIndex.set('recipe-a', ['s1'])

    watcher.handleEvent('ADDED', { metadata: { name: 's1' }, data: { k: 'eA==' } })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued).toEqual(['recipe-a'])
    enqueued.length = 0

    // Same key set — no reconcile should fire.
    watcher.handleEvent('MODIFIED', { metadata: { name: 's1' }, data: { k: 'eA==' } })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued).toEqual([])
  })

  it('coalesces a burst of changes into a single reconcile per recipe', () => {
    const { watcher, enqueued, reverseIndex } = buildHarness()
    reverseIndex.set('recipe-a', ['s1'])

    watcher.handleEvent('ADDED', { metadata: { name: 's1' }, data: { a: 'eA==' } })
    vi.advanceTimersByTime(DEBOUNCE_MS / 2)
    watcher.handleEvent('MODIFIED', { metadata: { name: 's1' }, data: { a: 'eA==', b: 'eA==' } })
    vi.advanceTimersByTime(DEBOUNCE_MS / 2)
    watcher.handleEvent('MODIFIED', {
      metadata: { name: 's1' },
      data: { a: 'eA==', b: 'eA==', c: 'eA==' },
    })
    vi.advanceTimersByTime(DEBOUNCE_MS)

    expect(enqueued).toEqual(['recipe-a'])
  })

  it('emits a reconcile when a Secret is deleted (key-set transitions to empty)', () => {
    const { watcher, enqueued, reverseIndex } = buildHarness()
    reverseIndex.set('recipe-a', ['s1'])

    watcher.handleEvent('ADDED', { metadata: { name: 's1' }, data: { a: 'eA==' } })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    enqueued.length = 0

    watcher.handleEvent('DELETED', { metadata: { name: 's1' } })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued).toEqual(['recipe-a'])
  })

  it('emits a reconcile on DELETED even when the Secret was never observed populated', () => {
    // Covers the WRC-restart race: WRC missed the original ADD, gets a
    // DELETED first. The dependent recipe's last reconcile may have
    // projected stale keys, so reconcile-on-DELETE keeps it in sync.
    const { watcher, enqueued, reverseIndex } = buildHarness()
    reverseIndex.set('recipe-a', ['s1'])

    watcher.handleEvent('DELETED', { metadata: { name: 's1' } })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued).toEqual(['recipe-a'])
  })

  it('treats stringData and data keys uniformly', () => {
    const { watcher, enqueued, reverseIndex } = buildHarness()
    reverseIndex.set('recipe-a', ['s1'])

    watcher.handleEvent('ADDED', {
      metadata: { name: 's1' },
      data: { 'binary-key': 'eA==' },
      stringData: { 'plain-key': 'value' },
    })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued).toEqual(['recipe-a'])
    enqueued.length = 0

    // Re-emit with same effective key-set (same keys, different storage) — no reconcile.
    watcher.handleEvent('MODIFIED', {
      metadata: { name: 's1' },
      data: { 'binary-key': 'eA==', 'plain-key': 'eA==' },
    })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued).toEqual([])
  })

  it('ignores events whose Secret has no name', () => {
    const { watcher, enqueued, reverseIndex } = buildHarness()
    reverseIndex.set('recipe-a', ['s1'])

    watcher.handleEvent('ADDED', { metadata: {}, data: { a: 'eA==' } })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued).toEqual([])
  })

  it('primeKnownKeys suppresses a reconcile when the first event has the seeded key-set', () => {
    const { watcher, enqueued, reverseIndex } = buildHarness()
    reverseIndex.set('recipe-a', ['s1'])
    watcher.primeKnownKeys('s1', ['a', 'b'])

    watcher.handleEvent('ADDED', {
      metadata: { name: 's1' },
      data: { a: 'eA==', b: 'eA==' },
    })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued).toEqual([])
  })

  it('fans out on an ownership-label change even when the key-set is unchanged (Issue #637)', () => {
    const { watcher, enqueued, reverseIndex } = buildHarness()
    reverseIndex.set('recipe-a', ['s1'])
    // First observation: Secret owned by recipe-a.
    watcher.handleEvent('ADDED', {
      metadata: { name: 's1', labels: { [OWNER_RECIPE_LABEL_KEY]: 'recipe-a' } },
      data: { token: 'eA==' },
    })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    enqueued.length = 0
    // Reassigned to recipe-b — identical key-set, different owner. recipe-a now
    // loses access, so it MUST re-reconcile so the ownership gate re-evaluates.
    watcher.handleEvent('MODIFIED', {
      metadata: { name: 's1', labels: { [OWNER_RECIPE_LABEL_KEY]: 'recipe-b' } },
      data: { token: 'eA==' },
    })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued).toEqual(['recipe-a'])
  })

  it('does not fan out on metadata-only churn (same keys, same ownership)', () => {
    const { watcher, enqueued, reverseIndex } = buildHarness()
    reverseIndex.set('recipe-a', ['s1'])
    watcher.handleEvent('ADDED', {
      metadata: { name: 's1', labels: { [SHARED_LABEL_KEY]: 'true' } },
      data: { token: 'eA==' },
    })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    enqueued.length = 0
    // resourceVersion bump / unrelated annotation edit — same keys, same labels.
    watcher.handleEvent('MODIFIED', {
      metadata: { name: 's1', labels: { [SHARED_LABEL_KEY]: 'true' } },
      data: { token: 'eA==' },
    })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued).toEqual([])
  })

  it('stop() clears pending debounce timers and prevents future fan-out', () => {
    const { watcher, enqueued, reverseIndex } = buildHarness()
    reverseIndex.set('recipe-a', ['s1'])

    watcher.handleEvent('ADDED', { metadata: { name: 's1' }, data: { a: 'eA==' } })
    watcher.stop()
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued).toEqual([])
  })

  it('routes events to the correct recipes when multiple Secrets are watched', () => {
    const { watcher, enqueued, reverseIndex } = buildHarness()
    reverseIndex.set('recipe-a', ['s1'])
    reverseIndex.set('recipe-b', ['s2'])

    watcher.handleEvent('ADDED', { metadata: { name: 's1' }, data: { a: 'eA==' } })
    watcher.handleEvent('ADDED', { metadata: { name: 's2' }, data: { b: 'eA==' } })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(enqueued.sort()).toEqual(['recipe-a', 'recipe-b'])
  })
})
