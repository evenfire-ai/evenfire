import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkIntervalCoversRange,
  isAllowedGroupBy,
  isUsageInterval,
  queryUsageSeries,
  queryUsageTotals,
} from '../src/services/usageReader.js'

const mockQuery = vi.fn()
const fakeDb = { query: mockQuery } as never

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('isUsageInterval / isAllowedGroupBy', () => {
  it('accepts the three rollup tiers', () => {
    expect(isUsageInterval('5min')).toBe(true)
    expect(isUsageInterval('hour')).toBe(true)
    expect(isUsageInterval('day')).toBe(true)
  })

  it('rejects raw and unknown intervals', () => {
    expect(isUsageInterval('events')).toBe(false)
    expect(isUsageInterval('minute')).toBe(false)
    expect(isUsageInterval(null)).toBe(false)
  })

  it('accepts every documented dimension', () => {
    for (const f of [
      'model',
      'provider',
      'host_ref',
      'team_id',
      'recipe_name',
      'llm_secret_name',
      'user_id',
      'sender',
      'channel_type',
      'source_kind',
    ]) {
      expect(isAllowedGroupBy(f)).toBe(true)
    }
  })

  it('rejects unknown dimensions (no SQL identifier injection)', () => {
    expect(isAllowedGroupBy('drop table')).toBe(false)
    expect(isAllowedGroupBy('1 OR 1=1')).toBe(false)
    expect(isAllowedGroupBy('request_count')).toBe(false)
  })
})

describe('checkIntervalCoversRange', () => {
  it('rejects 5min if from is older than 7 days', () => {
    const now = new Date('2026-05-06T12:00:00Z')
    const from = new Date('2026-04-29T11:59:59Z')
    expect(checkIntervalCoversRange('5min', from, now)).toEqual({
      error: 'range_too_old_for_interval',
      interval: '5min',
      retentionDays: 7,
    })
  })

  it('accepts 5min if from is within the last 7 days', () => {
    const now = new Date('2026-05-06T12:00:00Z')
    const from = new Date('2026-04-29T13:00:00Z')
    expect(checkIntervalCoversRange('5min', from, now)).toBeNull()
  })

  it('rejects hour if from is older than 30 days', () => {
    const now = new Date('2026-05-06T12:00:00Z')
    const from = new Date('2026-04-05T00:00:00Z')
    expect(checkIntervalCoversRange('hour', from, now)).not.toBeNull()
  })

  it('day tier has no upper bound', () => {
    const now = new Date('2026-05-06T12:00:00Z')
    const from = new Date('2020-01-01T00:00:00Z')
    expect(checkIntervalCoversRange('day', from, now)).toBeNull()
  })
})

describe('queryUsageSeries', () => {
  it('reads from usage_5min for interval=5min and binds time bounds', async () => {
    await queryUsageSeries({
      from: new Date('2026-05-06T00:00:00Z'),
      to: new Date('2026-05-06T12:00:00Z'),
      interval: '5min',
      groupBy: 'model',
      db: fakeDb,
    })
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(String(sql)).toMatch(/FROM\s+usage_5min/)
    expect(String(sql)).toMatch(/GROUP BY\s+bucket,\s+model/)
    expect(params).toEqual(['2026-05-06T00:00:00.000Z', '2026-05-06T12:00:00.000Z'])
  })

  it('sums cache token columns in the series query', async () => {
    await queryUsageSeries({
      from: new Date('2026-05-06T00:00:00Z'),
      to: new Date('2026-05-06T12:00:00Z'),
      interval: '5min',
      groupBy: 'model',
      db: fakeDb,
    })
    const [sql] = mockQuery.mock.calls[0]
    expect(String(sql)).toMatch(/SUM\(cache_read_tokens\)::bigint/)
    expect(String(sql)).toMatch(/SUM\(cache_write_tokens\)::bigint/)
  })

  it('reads from usage_hourly for interval=hour', async () => {
    await queryUsageSeries({
      from: new Date('2026-05-01T00:00:00Z'),
      to: new Date('2026-05-06T12:00:00Z'),
      interval: 'hour',
      groupBy: 'team_id',
      db: fakeDb,
    })
    const [sql] = mockQuery.mock.calls[0]
    expect(String(sql)).toMatch(/FROM\s+usage_hourly/)
    expect(String(sql)).toMatch(/GROUP BY\s+bucket,\s+team_id/)
  })

  it('reads from usage_daily for interval=day', async () => {
    await queryUsageSeries({
      from: new Date('2026-04-01T00:00:00Z'),
      to: new Date('2026-05-06T12:00:00Z'),
      interval: 'day',
      groupBy: 'host_ref',
      db: fakeDb,
    })
    const [sql] = mockQuery.mock.calls[0]
    expect(String(sql)).toMatch(/FROM\s+usage_daily/)
  })

  it('appends parameterised filters with stable placeholder indexes', async () => {
    await queryUsageSeries({
      from: new Date('2026-05-06T00:00:00Z'),
      to: new Date('2026-05-06T12:00:00Z'),
      interval: '5min',
      groupBy: 'model',
      filters: { host_ref: ['chatllm', 'trader'], source_kind: ['desktop'] },
      db: fakeDb,
    })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(String(sql)).toMatch(/host_ref IN \(\$3,\$4\)/)
    expect(String(sql)).toMatch(/source_kind IN \(\$5\)/)
    expect(params).toEqual([
      '2026-05-06T00:00:00.000Z',
      '2026-05-06T12:00:00.000Z',
      'chatllm',
      'trader',
      'desktop',
    ])
  })

  it('skips empty filter arrays so they do not produce empty IN ()', async () => {
    await queryUsageSeries({
      from: new Date('2026-05-06T00:00:00Z'),
      to: new Date('2026-05-06T12:00:00Z'),
      interval: '5min',
      groupBy: 'model',
      filters: { host_ref: [] },
      db: fakeDb,
    })
    const [sql] = mockQuery.mock.calls[0]
    expect(String(sql)).not.toMatch(/IN\s*\(\)/)
    expect(String(sql)).not.toMatch(/host_ref IN/)
  })

  it('shapes returned rows with bucket ISO + group + numeric measures', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          bucket: new Date('2026-05-06T00:00:00Z'),
          group_col: 'gpt-4o',
          input_tokens: '120',
          output_tokens: '80',
          cache_read_tokens: '40',
          cache_write_tokens: '10',
          total_tokens: '200',
          request_count: '1',
        },
      ],
      rowCount: 1,
    })
    const rows = await queryUsageSeries({
      from: new Date('2026-05-06T00:00:00Z'),
      to: new Date('2026-05-06T12:00:00Z'),
      interval: '5min',
      groupBy: 'model',
      db: fakeDb,
    })
    expect(rows).toEqual([
      {
        bucket: '2026-05-06T00:00:00.000Z',
        group: 'gpt-4o',
        input_tokens: 120,
        output_tokens: 80,
        cache_read_tokens: 40,
        cache_write_tokens: 10,
        total_tokens: 200,
        request_count: 1,
      },
    ])
  })

  it('preserves NULL group as null (route layer renders "(none)")', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          bucket: new Date('2026-05-06T00:00:00Z'),
          group_col: null,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          request_count: 0,
        },
      ],
      rowCount: 1,
    })
    const rows = await queryUsageSeries({
      from: new Date('2026-05-06T00:00:00Z'),
      to: new Date('2026-05-06T12:00:00Z'),
      interval: '5min',
      groupBy: 'team_id',
      db: fakeDb,
    })
    expect(rows[0]?.group).toBeNull()
  })
})

describe('queryUsageTotals', () => {
  it('orders by total_tokens desc and applies the limit', async () => {
    await queryUsageTotals({
      from: new Date('2026-05-06T00:00:00Z'),
      to: new Date('2026-05-06T12:00:00Z'),
      interval: '5min',
      groupBy: 'recipe_name',
      limit: 5,
      db: fakeDb,
    })
    const [sql] = mockQuery.mock.calls[0]
    expect(String(sql)).toMatch(/ORDER BY total_tokens DESC/)
    expect(String(sql)).toMatch(/LIMIT 5/)
  })

  it('clamps absurd limits into [1, 500]', async () => {
    await queryUsageTotals({
      from: new Date('2026-05-06T00:00:00Z'),
      to: new Date('2026-05-06T12:00:00Z'),
      interval: '5min',
      groupBy: 'recipe_name',
      limit: 99999,
      db: fakeDb,
    })
    const [sql] = mockQuery.mock.calls[0]
    expect(String(sql)).toMatch(/LIMIT 500/)
  })

  it('defaults to limit 50 when unspecified', async () => {
    await queryUsageTotals({
      from: new Date('2026-05-06T00:00:00Z'),
      to: new Date('2026-05-06T12:00:00Z'),
      interval: '5min',
      groupBy: 'recipe_name',
      db: fakeDb,
    })
    const [sql] = mockQuery.mock.calls[0]
    expect(String(sql)).toMatch(/LIMIT 50/)
  })
})
