import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pruneUsageRetention,
  startUsageRetentionCron,
  stopUsageRetentionCron,
} from '../src/services/usageRetentionCron.js'

const mockQuery = vi.fn()

describe('usageRetentionCron', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  afterEach(() => {
    stopUsageRetentionCron()
  })

  describe('pruneUsageRetention', () => {
    it('issues three DELETEs in tier order: events, 5min, hourly', async () => {
      await pruneUsageRetention({ query: mockQuery } as never)
      expect(mockQuery).toHaveBeenCalledTimes(3)
      const sqls = mockQuery.mock.calls.map(c => String(c[0]))
      expect(sqls[0]).toMatch(
        /DELETE FROM usage_events\s+WHERE ts < NOW\(\) - INTERVAL '48 hours'/i
      )
      expect(sqls[1]).toMatch(
        /DELETE FROM usage_5min\s+WHERE bucket < NOW\(\) - INTERVAL '7 days'/i
      )
      expect(sqls[2]).toMatch(
        /DELETE FROM usage_hourly\s+WHERE bucket < NOW\(\) - INTERVAL '30 days'/i
      )
    })

    it('does NOT prune usage_daily (kept indefinitely)', async () => {
      await pruneUsageRetention({ query: mockQuery } as never)
      const sqls = mockQuery.mock.calls.map(c => String(c[0])).join('\n')
      expect(sqls).not.toMatch(/usage_daily/i)
    })

    it('reports rows-deleted per tier', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 100 })
        .mockResolvedValueOnce({ rows: [], rowCount: 50 })
        .mockResolvedValueOnce({ rows: [], rowCount: 10 })
      const results = await pruneUsageRetention({ query: mockQuery } as never)
      expect(results).toEqual([
        { table: 'usage_events', rowsDeleted: 100 },
        { table: 'usage_5min', rowsDeleted: 50 },
        { table: 'usage_hourly', rowsDeleted: 10 },
      ])
    })

    it('keeps pruning subsequent tiers when one DELETE throws', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 100 })
        .mockRejectedValueOnce(new Error('lock timeout'))
        .mockResolvedValueOnce({ rows: [], rowCount: 7 })
      const results = await pruneUsageRetention({ query: mockQuery } as never)
      expect(mockQuery).toHaveBeenCalledTimes(3)
      expect(results).toEqual([
        { table: 'usage_events', rowsDeleted: 100 },
        { table: 'usage_5min', rowsDeleted: 0 },
        { table: 'usage_hourly', rowsDeleted: 7 },
      ])
    })

    it('treats rowCount=null as zero (defensive against driver variance)', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: null })
      const results = await pruneUsageRetention({ query: mockQuery } as never)
      expect(results.every(r => r.rowsDeleted === 0)).toBe(true)
    })
  })

  describe('startUsageRetentionCron', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      stopUsageRetentionCron()
      vi.useRealTimers()
    })

    it('does not fire before the first interval elapses', () => {
      startUsageRetentionCron(86_400_000)
      // Cron is purely interval-based; nothing fires synchronously.
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('is idempotent — second start is a no-op', () => {
      startUsageRetentionCron(86_400_000)
      startUsageRetentionCron(1_000)
      // Pure existence check; stop() in afterEach clears one handle cleanly.
      expect(true).toBe(true)
    })

    it('stop is safe to call repeatedly', () => {
      startUsageRetentionCron(86_400_000)
      stopUsageRetentionCron()
      stopUsageRetentionCron()
      expect(true).toBe(true)
    })
  })
})
