/**
 * Regression tests for PR-186 review P0: memory eviction fixes.
 *
 * Covers:
 *   C1  — SseProgressReporter listener leak after TTL eviction
 *   M3  — TaskLifecycle.records unbounded
 *   M10 — TaskLifecycle missing setMaxListeners(0)
 *   MessageQueue.taskInstanceIndex unbounded
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoopSafety } from '../../core/safety/__tests__/noopSafety.js'
import { SseProgressReporter, progressReporterRegistry } from '../../progress/sseProgressReporter'
import { MessageQueue } from '../../queue/messageQueue'
import { TaskLifecycle } from '../taskLifecycle'
import { buildTask } from './helpers'

describe('PR-186 review P0: memory eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('REVIEW-3: cleanupStaleRecords is debounced to 30s', () => {
    it('_lastCleanupAt is set to Date.now() on first scan and unchanged within debounce', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime()
      vi.setSystemTime(t0)

      const lc = new TaskLifecycle()

      // Before any read, _lastCleanupAt is 0 (never scanned)
      expect((lc as any)._lastCleanupAt).toBe(0)

      lc.register(buildTask({ id: 't-a' }))
      lc.transition('t-a', 'processing', 'dispatched')
      lc.transition('t-a', 'completed', 'natural')

      // Advance past TTL and trigger first scan
      vi.setSystemTime(t0 + 5 * 60 * 1000 + 1000)
      lc.getStats()

      const afterFirstScan = (lc as any)._lastCleanupAt as number
      expect(afterFirstScan).toBe(t0 + 5 * 60 * 1000 + 1000)

      // Multiple reads within 30s must not update _lastCleanupAt
      vi.setSystemTime(t0 + 5 * 60 * 1000 + 10 * 1000)
      lc.get('any')
      lc.getStatus('any')
      lc.isTerminal('any')
      lc.getStats()

      expect((lc as any)._lastCleanupAt).toBe(afterFirstScan)
    })

    it('scan is skipped entirely within 30s of last scan', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime()
      vi.setSystemTime(t0)

      const lc = new TaskLifecycle()
      const evicted: string[] = []
      lc.on('record:evicted', (ev: { taskId: string }) => evicted.push(ev.taskId))

      // Register t-a at t0
      lc.register(buildTask({ id: 't-a' }))
      lc.transition('t-a', 'processing', 'dispatched')
      lc.transition('t-a', 'completed', 'natural') // terminalAt = t0

      // Register t-b also at t0
      lc.register(buildTask({ id: 't-b' }))
      lc.transition('t-b', 'processing', 'dispatched')
      lc.transition('t-b', 'completed', 'natural') // terminalAt = t0

      // Advance past TTL for both tasks
      vi.setSystemTime(t0 + 5 * 60 * 1000 + 1000)

      // First scan: both t-a and t-b evicted in ONE scan
      lc.getStats()
      expect(evicted.sort()).toEqual(['t-a', 't-b'])

      // Register t-c at (t0 + 5:01) — terminal immediately
      lc.register(buildTask({ id: 't-c' }))
      lc.transition('t-c', 'processing', 'dispatched')
      lc.transition('t-c', 'completed', 'natural') // terminalAt = t0 + 5:01

      // Advance 20s (within the 30s debounce window from the first scan)
      // Also advance past t-c's TTL for good measure (but debounce should prevent scan)
      // t-c TTL = t0 + 5:01 + 5min = t0 + 10:01
      // We go to t0 + 5:21 — t-c's TTL NOT elapsed yet, AND debounce window active
      vi.setSystemTime(t0 + 5 * 60 * 1000 + 1000 + 20 * 1000)
      lc.getStats() // scan should be SKIPPED (debounce active)
      expect(evicted.sort()).toEqual(['t-a', 't-b']) // t-c not evicted yet

      // Advance past both the debounce AND t-c's TTL
      // Debounce expires at: first-scan-time (t0+5:01) + 30s = t0 + 5:31
      // t-c TTL expires at:  t0 + 5:01 + 5min = t0 + 10:01
      // Go to t0 + 10:05 — both conditions met
      vi.setSystemTime(t0 + 10 * 60 * 1000 + 5000)
      lc.getStats()
      expect(evicted.sort()).toEqual(['t-a', 't-b', 't-c'])
    })

    it('scan resumes after 30s debounce window even without evictable records', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime()
      vi.setSystemTime(t0)

      const lc = new TaskLifecycle()

      // Register a terminal task and advance past TTL to trigger first scan
      lc.register(buildTask({ id: 't-a' }))
      lc.transition('t-a', 'processing', 'dispatched')
      lc.transition('t-a', 'completed', 'natural')

      vi.setSystemTime(t0 + 5 * 60 * 1000 + 1000)
      lc.getStats() // first scan, sets _lastCleanupAt

      const lastCleanupAfterFirst = (lc as any)._lastCleanupAt as number
      expect(lastCleanupAfterFirst).toBe(t0 + 5 * 60 * 1000 + 1000)

      // Within debounce — _lastCleanupAt must NOT change
      vi.setSystemTime(t0 + 5 * 60 * 1000 + 1000 + 15 * 1000)
      lc.getStats()
      expect((lc as any)._lastCleanupAt).toBe(lastCleanupAfterFirst)

      // Past debounce — _lastCleanupAt MUST be updated
      vi.setSystemTime(t0 + 5 * 60 * 1000 + 1000 + 31 * 1000)
      lc.getStats()
      expect((lc as any)._lastCleanupAt).toBeGreaterThan(lastCleanupAfterFirst)
    })
  })

  it('TaskLifecycle evicts terminal records after 5min TTL', () => {
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 't-evict' }))
    lc.transition('t-evict', 'processing', 'dispatched')
    lc.transition('t-evict', 'completed', 'natural')
    expect(lc.get('t-evict')).toBeDefined()

    // Advance past TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000)

    // Lazy eviction: triggered on next read
    expect(lc.get('t-evict')).toBeNull()
  })

  it('TaskLifecycle does NOT evict non-terminal records', () => {
    const lc = new TaskLifecycle()
    lc.register(buildTask({ id: 't-keep' }))
    lc.transition('t-keep', 'processing', 'dispatched')

    vi.advanceTimersByTime(10 * 60 * 1000)

    expect(lc.get('t-keep')?.status).toBe('processing')
  })

  it('TaskLifecycle emits record:evicted when evicting', () => {
    const lc = new TaskLifecycle()
    const evicted: string[] = []
    lc.on('record:evicted', (ev: { taskId: string }) => evicted.push(ev.taskId))

    lc.register(buildTask({ id: 't-a' }))
    lc.register(buildTask({ id: 't-b' }))
    lc.transition('t-a', 'processing', 'dispatched')
    lc.transition('t-a', 'cancelled', 'user_requested')
    // t-b stays pending

    vi.advanceTimersByTime(5 * 60 * 1000 + 1000)
    lc.getStats() // trigger cleanup

    expect(evicted).toEqual(['t-a'])
  })

  it('MessageQueue.taskInstanceIndex is cleaned up on record:evicted', () => {
    const lc = new TaskLifecycle()
    const mq = new MessageQueue()
    mq.setLifecycle(lc)

    const t = mq.createInternalTask('test')
    lc.register(t)
    lc.transition(t.id, 'processing', 'dispatched')
    lc.transition(t.id, 'completed', 'natural')

    expect(mq.getTask(t.id)).toBe(t) // still present before TTL

    vi.advanceTimersByTime(5 * 60 * 1000 + 1000)
    lc.getStats() // trigger eviction → emits record:evicted → mq cleans up

    expect(mq.getTask(t.id)).toBeNull() // evicted
  })

  it('TaskLifecycle sets maxListeners to 0 (no warning threshold)', () => {
    const lc = new TaskLifecycle()
    expect(lc.getMaxListeners()).toBe(0)
  })

  it('SseProgressReporter.dispose() removes its lifecycle listener', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('t-dispose', lc, NoopSafety)
    const initialListeners = lc.listenerCount('transition')
    reporter.dispose()
    expect(lc.listenerCount('transition')).toBe(initialListeners - 1)
  })

  it('progressReporterRegistry cleanup() calls dispose() on evicted reporters', () => {
    const lc = new TaskLifecycle()
    const reporter = new SseProgressReporter('t-registry', lc, NoopSafety)
    // Mark it completed so TTL applies
    ;(reporter as any).completed = true
    ;(reporter as any).completedAt = Date.now()

    progressReporterRegistry.set('t-registry', reporter)
    const listenersBefore = lc.listenerCount('transition')

    vi.advanceTimersByTime(5 * 60 * 1000 + 1000)
    progressReporterRegistry.get('t-registry') // triggers internal cleanup + dispose

    // After TTL eviction + dispose chain, the listener should be gone
    expect(lc.listenerCount('transition')).toBeLessThan(listenersBefore)
  })
})
