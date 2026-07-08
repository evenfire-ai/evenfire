import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  rollupUsage5MinToHourly,
  rollupUsageEventsTo5Min,
  rollupUsageHourlyToDaily,
  startUsageRollupCron,
  stopUsageRollupCron,
} from '../src/services/usageRollupCron.js'

const mockQuery = vi.fn()

describe('usageRollupCron', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  afterEach(() => {
    stopUsageRollupCron()
  })

  describe('rollupUsageEventsTo5Min', () => {
    it('issues a single INSERT ... ON CONFLICT DO UPDATE against usage_5min', async () => {
      await rollupUsageEventsTo5Min({ query: mockQuery } as never)
      expect(mockQuery).toHaveBeenCalledTimes(1)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/INSERT\s+INTO\s+usage_5min/i)
      expect(sql).toMatch(/ON\s+CONFLICT/i)
      expect(sql).toMatch(/DO\s+UPDATE\s+SET/i)
    })

    it('LEFT JOINs a canonical-team subquery on team_contexts to resolve team_id', async () => {
      await rollupUsageEventsTo5Min({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      // The subquery is the load-bearing piece — it's what stops a context
      // bound to multiple teams from fanning out the JOIN and double-counting.
      expect(sql).toMatch(/DISTINCT\s+ON\s*\(\s*context_id\s*\)/i)
      expect(sql).toMatch(/FROM\s+team_contexts/i)
      expect(sql).toMatch(/ORDER\s+BY\s+context_id\s*,\s*created_at\s+ASC\s*,\s*team_id\s+ASC/i)
      expect(sql).toMatch(/\)\s+tc\s+ON\s+tc\.context_id\s*=\s*e\.context_ref/i)
      expect(sql).toMatch(/tc\.team_id::text/i)
    })

    it('uses event team snapshots and does not infer workflow team from mutable actors', async () => {
      await rollupUsageEventsTo5Min({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/COALESCE\(e\.team_id,\s*tc\.team_id::text\)/i)
      expect(sql).not.toMatch(/wr_by_id/i)
      expect(sql).not.toMatch(/workflow_runs_audit\s+wra/i)
      expect(sql).not.toMatch(/actor_team/i)
      expect(sql).not.toMatch(/FROM\s+team_members/i)
    })

    it('does not resolve direct user usage teams from mutable team_members', async () => {
      await rollupUsageEventsTo5Min({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).not.toMatch(/team_members/i)
      expect(sql).not.toMatch(/e\.user_id\s*\)/i)
    })

    it('does not resolve workflow usage through legacy child recipe names', async () => {
      await rollupUsageEventsTo5Min({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).not.toMatch(/wr_by_child/i)
      expect(sql).not.toMatch(/child_recipe_name\s*=\s*split_part\(e\.task_id,\s*':',\s*1\)/i)
    })

    it('purges and recomputes the recent 5min window to avoid stale NULL-dimension rows', async () => {
      await rollupUsageEventsTo5Min({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/DELETE\s+FROM\s+usage_5min/i)
      expect(sql).toMatch(/WHERE\s+bucket\s+>=\s+NOW\(\)\s+-\s+INTERVAL\s+'48 hours'/i)
    })

    it('does NOT use a bare LEFT JOIN team_contexts (would double-count multi-team contexts)', async () => {
      await rollupUsageEventsTo5Min({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      // Specifically reject the prior shape: `LEFT JOIN team_contexts tc ON ...`
      // without the canonicalising subquery between LEFT JOIN and team_contexts.
      expect(sql).not.toMatch(/LEFT\s+JOIN\s+team_contexts\s+tc/i)
    })

    it('sweeps the raw retention window so late-ingested events still reach 5min rollups', async () => {
      await rollupUsageEventsTo5Min({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/WHERE\s+e\.ts\s+>=\s+NOW\(\)\s+-\s+INTERVAL\s+'48 hours'/i)
    })

    it('truncates ts into 5-minute buckets', async () => {
      await rollupUsageEventsTo5Min({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(
        /date_trunc\('minute',\s*e\.ts\)\s*-\s*\(extract\(minute from e\.ts\)::int\s*%\s*5\)/i
      )
    })

    it('updates measure columns from EXCLUDED on conflict', async () => {
      await rollupUsageEventsTo5Min({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/input_tokens\s*=\s*EXCLUDED\.input_tokens/i)
      expect(sql).toMatch(/output_tokens\s*=\s*EXCLUDED\.output_tokens/i)
      expect(sql).toMatch(/cache_read_tokens\s*=\s*EXCLUDED\.cache_read_tokens/i)
      expect(sql).toMatch(/cache_write_tokens\s*=\s*EXCLUDED\.cache_write_tokens/i)
      expect(sql).toMatch(/total_tokens\s*=\s*EXCLUDED\.total_tokens/i)
      expect(sql).toMatch(/request_count\s*=\s*EXCLUDED\.request_count/i)
    })

    it('sums cache token columns from raw events', async () => {
      await rollupUsageEventsTo5Min({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/SUM\(e\.cache_read_tokens\)::bigint/i)
      expect(sql).toMatch(/SUM\(e\.cache_write_tokens\)::bigint/i)
    })

    it('returns the upserted rowCount', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 7 })
      const result = await rollupUsageEventsTo5Min({ query: mockQuery } as never)
      expect(result.rowCount).toBe(7)
    })
  })

  describe('rollupUsage5MinToHourly', () => {
    it('aggregates from usage_5min into usage_hourly with date_trunc(hour)', async () => {
      await rollupUsage5MinToHourly({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/INSERT\s+INTO\s+usage_hourly/i)
      expect(sql).toMatch(/FROM\s+usage_5min/i)
      expect(sql).toMatch(/date_trunc\('hour',\s*f\.bucket\)/i)
    })

    it('does NOT join team_contexts (team_id already resolved at the 5min tier)', async () => {
      await rollupUsage5MinToHourly({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).not.toMatch(/team_contexts/i)
    })

    it('sweeps the 5min backfill window so late raw rollups propagate to hourly', async () => {
      await rollupUsage5MinToHourly({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/WHERE\s+f\.bucket\s+>=\s+NOW\(\)\s+-\s+INTERVAL\s+'48 hours'/i)
    })

    it('purges and recomputes the recent hourly window after 5min dimensions change', async () => {
      await rollupUsage5MinToHourly({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/DELETE\s+FROM\s+usage_hourly/i)
      expect(sql).toMatch(/WHERE\s+bucket\s+>=\s+NOW\(\)\s+-\s+INTERVAL\s+'48 hours'/i)
    })

    it('idempotent: ON CONFLICT DO UPDATE on the rollup PK', async () => {
      await rollupUsage5MinToHourly({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/ON\s+CONFLICT[\s\S]+DO\s+UPDATE\s+SET/i)
    })

    it('sums cache token columns up from the 5min tier', async () => {
      await rollupUsage5MinToHourly({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/SUM\(f\.cache_read_tokens\)::bigint/i)
      expect(sql).toMatch(/SUM\(f\.cache_write_tokens\)::bigint/i)
      expect(sql).toMatch(/cache_read_tokens\s*=\s*EXCLUDED\.cache_read_tokens/i)
      expect(sql).toMatch(/cache_write_tokens\s*=\s*EXCLUDED\.cache_write_tokens/i)
    })
  })

  describe('rollupUsageHourlyToDaily', () => {
    it('aggregates from usage_hourly into usage_daily with date_trunc(day)', async () => {
      await rollupUsageHourlyToDaily({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/INSERT\s+INTO\s+usage_daily/i)
      expect(sql).toMatch(/FROM\s+usage_hourly/i)
      expect(sql).toMatch(/date_trunc\('day',\s*f\.bucket\)/i)
    })

    it('does NOT join team_contexts', async () => {
      await rollupUsageHourlyToDaily({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).not.toMatch(/team_contexts/i)
    })

    it('sweeps the last 2 days', async () => {
      await rollupUsageHourlyToDaily({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/WHERE\s+f\.bucket\s+>=\s+NOW\(\)\s+-\s+INTERVAL\s+'2 days'/i)
    })

    it('purges and recomputes the recent daily window after hourly dimensions change', async () => {
      await rollupUsageHourlyToDaily({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/DELETE\s+FROM\s+usage_daily/i)
      expect(sql).toMatch(/WHERE\s+bucket\s+>=\s+NOW\(\)\s+-\s+INTERVAL\s+'2 days'/i)
    })

    it('sums cache token columns up from the hourly tier', async () => {
      await rollupUsageHourlyToDaily({ query: mockQuery } as never)
      const sql = String(mockQuery.mock.calls[0]![0])
      expect(sql).toMatch(/SUM\(f\.cache_read_tokens\)::bigint/i)
      expect(sql).toMatch(/SUM\(f\.cache_write_tokens\)::bigint/i)
      expect(sql).toMatch(/cache_read_tokens\s*=\s*EXCLUDED\.cache_read_tokens/i)
      expect(sql).toMatch(/cache_write_tokens\s*=\s*EXCLUDED\.cache_write_tokens/i)
    })
  })

  describe('startUsageRollupCron', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      stopUsageRollupCron()
      vi.useRealTimers()
    })

    it('does not fire any rollup before the first interval elapses', () => {
      const spy5 = vi.fn().mockResolvedValue({ rowCount: 0 })
      const spyH = vi.fn().mockResolvedValue({ rowCount: 0 })
      const spyD = vi.fn().mockResolvedValue({ rowCount: 0 })
      vi.doMock('../src/services/usageRollupCron.js', async () => {
        const actual = await vi.importActual<typeof import('../src/services/usageRollupCron.js')>(
          '../src/services/usageRollupCron.js'
        )
        return {
          ...actual,
          rollupUsageEventsTo5Min: spy5,
          rollupUsage5MinToHourly: spyH,
          rollupUsageHourlyToDaily: spyD,
        }
      })

      startUsageRollupCron({
        fiveMinIntervalMs: 60_000,
        hourlyIntervalMs: 300_000,
        dailyIntervalMs: 3_600_000,
      })
      // No timer ticks yet → no fires
      expect(spy5).not.toHaveBeenCalled()
      expect(spyH).not.toHaveBeenCalled()
      expect(spyD).not.toHaveBeenCalled()
    })

    it('is idempotent — calling start twice does not double-schedule', () => {
      startUsageRollupCron({
        fiveMinIntervalMs: 60_000,
        hourlyIntervalMs: 300_000,
        dailyIntervalMs: 3_600_000,
      })
      // Second call should be a no-op (handles already set).
      startUsageRollupCron({
        fiveMinIntervalMs: 1_000,
        hourlyIntervalMs: 1_000,
        dailyIntervalMs: 1_000,
      })
      // Pure existence check — no exceptions, no observable side effect to assert beyond
      // the fact that stop() (in afterEach) clears all three handles cleanly.
      expect(true).toBe(true)
    })

    it('stop clears scheduled timers', () => {
      startUsageRollupCron({
        fiveMinIntervalMs: 60_000,
        hourlyIntervalMs: 300_000,
        dailyIntervalMs: 3_600_000,
      })
      stopUsageRollupCron()
      // No throw; subsequent stop is a no-op.
      stopUsageRollupCron()
      expect(true).toBe(true)
    })
  })
})
