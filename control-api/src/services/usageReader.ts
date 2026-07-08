/**
 * Read service for the admin LLM-usage dashboard. Tier-routes by `interval`
 * and reads from rollup tables only — never from `usage_events`.
 *
 * Group-by and filter columns are gated by a fixed allowlist; the mapping
 * is the only place a caller-controlled string ever touches SQL
 * identifiers. Time bounds and filter values are bound parameters.
 */
import { type DbClient, pool } from '../db.js'

export type UsageInterval = '5min' | 'hour' | 'day'

export type UsageGroupBy =
  | 'model'
  | 'provider'
  | 'host_ref'
  | 'team_id'
  | 'recipe_name'
  | 'llm_secret_name'
  | 'user_id'
  | 'sender'
  | 'channel_type'
  | 'source_kind'

export type UsageFilters = Partial<Record<UsageGroupBy, string[]>>

export type UsageSeriesRow = {
  bucket: string
  group: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  request_count: number
}

export type UsageTotalsRow = {
  group: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  request_count: number
}

const TIER_BY_INTERVAL: Record<UsageInterval, { table: string; retentionDays: number }> = {
  '5min': { table: 'usage_5min', retentionDays: 7 },
  hour: { table: 'usage_hourly', retentionDays: 30 },
  day: { table: 'usage_daily', retentionDays: Number.POSITIVE_INFINITY },
}

const ALLOWED_GROUP_BY: ReadonlySet<UsageGroupBy> = new Set<UsageGroupBy>([
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
])

export function isAllowedGroupBy(value: unknown): value is UsageGroupBy {
  return typeof value === 'string' && ALLOWED_GROUP_BY.has(value as UsageGroupBy)
}

export function isUsageInterval(value: unknown): value is UsageInterval {
  return value === '5min' || value === 'hour' || value === 'day'
}

export type RangeError = {
  error: 'range_too_old_for_interval'
  interval: UsageInterval
  retentionDays: number
}

/**
 * The chosen rollup tier must cover the requested `from`. We can't read 5-min
 * resolution for a window older than 7 days because the rows have been pruned.
 * Day tier has no upper bound.
 */
export function checkIntervalCoversRange(
  interval: UsageInterval,
  from: Date,
  now: Date = new Date()
): RangeError | null {
  const tier = TIER_BY_INTERVAL[interval]
  if (!Number.isFinite(tier.retentionDays)) return null
  const cutoffMs = now.getTime() - tier.retentionDays * 24 * 60 * 60 * 1000
  if (from.getTime() < cutoffMs) {
    return {
      error: 'range_too_old_for_interval',
      interval,
      retentionDays: tier.retentionDays,
    }
  }
  return null
}

function buildFilterSql(
  filters: UsageFilters,
  startIndex: number
): { sql: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  let idx = startIndex
  for (const key of Object.keys(filters) as UsageGroupBy[]) {
    if (!ALLOWED_GROUP_BY.has(key)) continue
    const values = filters[key]
    if (!Array.isArray(values) || values.length === 0) continue
    const placeholders: string[] = []
    for (const v of values) {
      params.push(v)
      placeholders.push(`$${idx++}`)
    }
    clauses.push(`${key} IN (${placeholders.join(',')})`)
  }
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', params }
}

export type QueryUsageSeriesOptions = {
  from: Date
  to: Date
  interval: UsageInterval
  groupBy: UsageGroupBy
  filters?: UsageFilters
  db?: DbClient
}

export async function queryUsageSeries(opts: QueryUsageSeriesOptions): Promise<UsageSeriesRow[]> {
  const { from, to, interval, groupBy } = opts
  const filters = opts.filters ?? {}
  const db = opts.db ?? pool
  const tier = TIER_BY_INTERVAL[interval]

  const filterSql = buildFilterSql(filters, 3)
  const sql = `
    SELECT
      bucket,
      ${groupBy} AS group_col,
      SUM(input_tokens)::bigint        AS input_tokens,
      SUM(output_tokens)::bigint       AS output_tokens,
      SUM(cache_read_tokens)::bigint   AS cache_read_tokens,
      SUM(cache_write_tokens)::bigint  AS cache_write_tokens,
      SUM(total_tokens)::bigint        AS total_tokens,
      SUM(request_count)::bigint       AS request_count
    FROM ${tier.table}
    WHERE bucket >= $1 AND bucket < $2${filterSql.sql}
    GROUP BY bucket, ${groupBy}
    ORDER BY bucket ASC, group_col ASC NULLS LAST
  `
  const params: unknown[] = [from.toISOString(), to.toISOString(), ...filterSql.params]
  const result = await db.query(sql, params)
  return (result.rows as Record<string, unknown>[]).map(rowToSeries)
}

export type QueryUsageTotalsOptions = {
  from: Date
  to: Date
  interval: UsageInterval
  groupBy: UsageGroupBy
  filters?: UsageFilters
  limit?: number
  db?: DbClient
}

export async function queryUsageTotals(opts: QueryUsageTotalsOptions): Promise<UsageTotalsRow[]> {
  const { from, to, interval, groupBy } = opts
  const filters = opts.filters ?? {}
  const limit = clampLimit(opts.limit)
  const db = opts.db ?? pool
  const tier = TIER_BY_INTERVAL[interval]

  const filterSql = buildFilterSql(filters, 3)
  const sql = `
    SELECT
      ${groupBy} AS group_col,
      SUM(input_tokens)::bigint        AS input_tokens,
      SUM(output_tokens)::bigint       AS output_tokens,
      SUM(cache_read_tokens)::bigint   AS cache_read_tokens,
      SUM(cache_write_tokens)::bigint  AS cache_write_tokens,
      SUM(total_tokens)::bigint        AS total_tokens,
      SUM(request_count)::bigint       AS request_count
    FROM ${tier.table}
    WHERE bucket >= $1 AND bucket < $2${filterSql.sql}
    GROUP BY ${groupBy}
    ORDER BY total_tokens DESC NULLS LAST, group_col ASC NULLS LAST
    LIMIT ${limit}
  `
  const params: unknown[] = [from.toISOString(), to.toISOString(), ...filterSql.params]
  const result = await db.query(sql, params)
  return (result.rows as Record<string, unknown>[]).map(rowToTotals)
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 50
  if (limit < 1) return 1
  if (limit > 500) return 500
  return Math.floor(limit)
}

function toNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  if (typeof raw === 'bigint') return Number(raw)
  return 0
}

function toStringOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') return raw
  return String(raw)
}

function bucketToIso(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString()
  if (typeof raw === 'string') {
    const d = new Date(raw)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
    return raw
  }
  return String(raw)
}

function rowToSeries(row: Record<string, unknown>): UsageSeriesRow {
  return {
    bucket: bucketToIso(row.bucket),
    group: toStringOrNull(row.group_col),
    input_tokens: toNumber(row.input_tokens),
    output_tokens: toNumber(row.output_tokens),
    cache_read_tokens: toNumber(row.cache_read_tokens),
    cache_write_tokens: toNumber(row.cache_write_tokens),
    total_tokens: toNumber(row.total_tokens),
    request_count: toNumber(row.request_count),
  }
}

function rowToTotals(row: Record<string, unknown>): UsageTotalsRow {
  return {
    group: toStringOrNull(row.group_col),
    input_tokens: toNumber(row.input_tokens),
    output_tokens: toNumber(row.output_tokens),
    cache_read_tokens: toNumber(row.cache_read_tokens),
    cache_write_tokens: toNumber(row.cache_write_tokens),
    total_tokens: toNumber(row.total_tokens),
    request_count: toNumber(row.request_count),
  }
}
