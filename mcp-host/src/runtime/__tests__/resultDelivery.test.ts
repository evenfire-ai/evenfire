/**
 * Delivered-on-read stamping + the D8 `pendingResults` gauge predicate
 * (runtime/resultDelivery.ts). These are the production helpers main.ts wires
 * into handleTaskResult / getCronResults and the stateless heartbeat gauge —
 * reverting the stamp or the predicate fails these tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResultStore } from '../../resultStore'
import { isUndeliveredResult, markResultDelivered } from '../resultDelivery'

type CronLikeEntry = {
  response: string
  timestamp: Date
  deliveredInline?: boolean
  deliveredAt?: number
}

function makeCronStore(ttlMs = 30 * 60 * 1000): ResultStore<CronLikeEntry> {
  return new ResultStore<CronLikeEntry>(ttlMs, e => e.timestamp.getTime())
}

describe('resultDelivery — delivered-on-read gauge semantics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('an UNREAD cron result pins the gauge for its whole TTL, then evicts (spec hard block unchanged)', () => {
    const store = makeCronStore(1_000)
    store.set('cron-unread', { response: 'r', timestamp: new Date() })

    expect(store.countWhere(isUndeliveredResult)).toBe(1)
    vi.advanceTimersByTime(999)
    expect(store.countWhere(isUndeliveredResult)).toBe(1)
    vi.advanceTimersByTime(2) // past TTL — the store evicts
    expect(store.countWhere(isUndeliveredResult)).toBe(0)
  })

  it('a READ cron result is stamped (no delete) and stops pinning; the explicit ACK delete still works', () => {
    const store = makeCronStore()
    store.set('cron-read', { response: 'digest', timestamp: new Date() })
    expect(store.countWhere(isUndeliveredResult)).toBe(1)

    // GET /cron/results — main.ts getCronResults stamps every returned entry.
    const entry = store.get('cron-read')!
    markResultDelivered(entry)

    // A read is delivery, not consumption: the gauge unpins…
    expect(store.countWhere(isUndeliveredResult)).toBe(0)
    // …but the entry stays for repeat readers until the explicit ACK.
    expect(store.get('cron-read')).toBeDefined()
    expect(store.get('cron-read')!.response).toBe('digest')

    // DELETE /cron/results/:id (ACK) remains the strong consumption signal.
    expect(store.delete('cron-read')).toBe(true)
    expect(store.get('cron-read')).toBeUndefined()
  })

  it('markResultDelivered is idempotent: the FIRST read timestamp wins', () => {
    const entry: CronLikeEntry = { response: 'r', timestamp: new Date() }
    markResultDelivered(entry, 111)
    markResultDelivered(entry, 999)
    expect(entry.deliveredAt).toBe(111)
  })

  it('isUndeliveredResult: undelivered pins; deliveredInline (C3) and deliveredAt (read) do not', () => {
    expect(isUndeliveredResult({})).toBe(true)
    expect(isUndeliveredResult({ deliveredInline: true })).toBe(false)
    expect(isUndeliveredResult({ deliveredAt: 123 })).toBe(false)
    expect(isUndeliveredResult({ deliveredInline: true, deliveredAt: 123 })).toBe(false)
  })
})
