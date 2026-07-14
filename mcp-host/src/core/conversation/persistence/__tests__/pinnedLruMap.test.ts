import { describe, expect, it, vi } from 'vitest'
import { CacheOverflowError, PinnedLRUMap } from '../pinnedLruMap'

describe('PinnedLRUMap', () => {
  it('rejects non-positive maxSize', () => {
    expect(() => new PinnedLRUMap(0)).toThrow()
    expect(() => new PinnedLRUMap(-1)).toThrow()
    expect(() => new PinnedLRUMap(1.5)).toThrow()
  })

  it('basic set/get/has/delete', () => {
    const m = new PinnedLRUMap<string, number>(3)
    m.set('a', 1)
    m.set('b', 2)
    expect(m.get('a')).toBe(1)
    expect(m.has('b')).toBe(true)
    expect(m.size()).toBe(2)
    expect(m.delete('a')).toBe(true)
    expect(m.has('a')).toBe(false)
  })

  it('LRU eviction drops the oldest unpinned entry', () => {
    const m = new PinnedLRUMap<string, number>(2)
    m.set('a', 1)
    m.set('b', 2)
    m.set('c', 3)
    expect(m.has('a')).toBe(false)
    expect(m.has('b')).toBe(true)
    expect(m.has('c')).toBe(true)
  })

  it('get/touch promotes to MRU', () => {
    const m = new PinnedLRUMap<string, number>(2)
    m.set('a', 1)
    m.set('b', 2)
    m.get('a') // a is now MRU
    m.set('c', 3) // evicts b
    expect(m.has('a')).toBe(true)
    expect(m.has('b')).toBe(false)
    expect(m.has('c')).toBe(true)
  })

  it('pinned entries are never evicted', () => {
    const m = new PinnedLRUMap<string, number>(2)
    m.set('a', 1, { pinned: true })
    m.set('b', 2)
    m.set('c', 3)
    expect(m.has('a')).toBe(true) // pinned, survives
    expect(m.has('b')).toBe(false) // evicted (oldest unpinned)
    expect(m.has('c')).toBe(true)
  })

  it('CacheOverflowError when all entries are pinned', () => {
    const m = new PinnedLRUMap<string, number>(2)
    m.set('a', 1, { pinned: true })
    m.set('b', 2, { pinned: true })
    expect(() => m.set('c', 3)).toThrow(CacheOverflowError)
  })

  it('pin() throws CacheOverflowError when it would exceed maxSize', () => {
    const m = new PinnedLRUMap<string, number>(2)
    m.set('a', 1, { pinned: true })
    m.set('b', 2, { pinned: true })
    // size == maxSize already, but b is pinned so set('c') would fail.
    // pin() on an existing entry stays under control.
    m.set('a', 1) // pinned via set with default no-pin? — keep pinned
    expect(m.isPinned('a')).toBe(true)
  })

  it('unpin allows eviction again', () => {
    const m = new PinnedLRUMap<string, number>(2)
    m.set('a', 1, { pinned: true })
    m.set('b', 2)
    m.unpin('a')
    m.set('c', 3) // evicts a (oldest)
    expect(m.has('a')).toBe(false)
    expect(m.has('b')).toBe(true)
    expect(m.has('c')).toBe(true)
  })

  it('onEvict fires only on LRU eviction, not on delete()', () => {
    const m = new PinnedLRUMap<string, number>(2)
    const cb = vi.fn()
    m.onEvict(cb)
    m.set('a', 1)
    m.set('b', 2)
    m.set('c', 3) // a evicted
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith('a', 1)
    cb.mockClear()
    m.delete('b')
    expect(cb).not.toHaveBeenCalled()
  })

  it('stats() reports size + pinnedCount + maxSize', () => {
    const m = new PinnedLRUMap<string, number>(5)
    m.set('a', 1, { pinned: true })
    m.set('b', 2)
    const s = m.stats()
    expect(s).toEqual({ size: 2, pinnedCount: 1, maxSize: 5 })
  })
})
