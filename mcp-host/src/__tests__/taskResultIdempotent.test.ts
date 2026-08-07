import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResultStore } from '../resultStore'

interface TaskEntry {
  response: string
  storedAt: number
}

function createStore(ttlMs: number = 5000): ResultStore<TaskEntry> {
  return new ResultStore<TaskEntry>(ttlMs, e => e.storedAt)
}

describe('TaskResult idempotent read — get() vs getAndDelete()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('task result persists after first read via get()', () => {
    const store = createStore()
    const now = Date.now()
    store.set('task-1', { response: 'Hello world', storedAt: now })

    // First read — result should be present
    const first = store.get('task-1')
    expect(first).toBeDefined()
    expect(first!.response).toBe('Hello world')

    // Second read — result should STILL be present (idempotent)
    const second = store.get('task-1')
    expect(second).toBeDefined()
    expect(second!.response).toBe('Hello world')

    // Third read — still there
    const third = store.get('task-1')
    expect(third).toBeDefined()
    expect(third!.response).toBe('Hello world')
  })

  it('task result is consumed by getAndDelete() (non-idempotent)', () => {
    const store = createStore()
    const now = Date.now()
    store.set('task-2', { response: 'One-time result', storedAt: now })

    // getAndDelete consumes the entry
    const result = store.getAndDelete('task-2')
    expect(result).toBeDefined()
    expect(result!.response).toBe('One-time result')

    // Subsequent read returns undefined — entry was deleted
    expect(store.get('task-2')).toBeUndefined()
    expect(store.getAndDelete('task-2')).toBeUndefined()
  })

  it('task result expires after TTL even with get() (no infinite retention)', () => {
    const ttlMs = 300_000 // 5 minutes
    const store = createStore(ttlMs)
    const now = Date.now()
    store.set('task-3', { response: 'Expires eventually', storedAt: now })

    // Within TTL — present
    vi.advanceTimersByTime(ttlMs - 1000)
    expect(store.get('task-3')).toBeDefined()

    // Past TTL — evicted by cleanup
    vi.advanceTimersByTime(2000)
    expect(store.get('task-3')).toBeUndefined()
  })

  it('multiple reads within TTL all return the same result', () => {
    const ttlMs = 300_000
    const store = createStore(ttlMs)
    const now = Date.now()
    store.set('task-4', { response: 'Persistent', storedAt: now })

    // Read at various points within the TTL window
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(20_000) // 20s increments (total 200s, within 300s TTL)
      const result = store.get('task-4')
      expect(result).toBeDefined()
      expect(result!.response).toBe('Persistent')
    }
  })
})
