import type { UsageFilters, UsageGroupBy, UsageInterval } from '@lib/api'

export type UsageRange = '24h' | '7d' | '30d'

export type RangeBounds = { from: Date; to: Date }

export const RANGE_OPTIONS: ReadonlyArray<{ value: UsageRange; label: string }> = [
  { value: '24h', label: 'Last 24 h' },
  { value: '7d', label: 'Last 7 d' },
  { value: '30d', label: 'Last 30 d' },
]

export const RANGE_TO_INTERVAL: Record<UsageRange, UsageInterval> = {
  '24h': '5min',
  '7d': 'hour',
  '30d': 'day',
}

export const RANGE_TO_MS: Record<UsageRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

/**
 * Selection state for the "Break down by" dropdown. `null` means no
 * breakdown — chart shows the simple input/output stacked totals.
 */
export type GroupBySelection = UsageGroupBy | null

/** Empty string is the DOM <option> value that round-trips to `null` state. */
export const GROUP_BY_NONE_VALUE = ''

export const GROUP_BY_OPTIONS: ReadonlyArray<{
  value: UsageGroupBy | typeof GROUP_BY_NONE_VALUE
  label: string
}> = [
  { value: GROUP_BY_NONE_VALUE, label: '(no breakdown)' },
  { value: 'team_id', label: 'Team' },
  { value: 'recipe_name', label: 'Recipe' },
  { value: 'model', label: 'Model' },
  { value: 'provider', label: 'Provider' },
  { value: 'host_ref', label: 'Agent (host)' },
  { value: 'llm_secret_name', label: 'LLM secret' },
  { value: 'user_id', label: 'Desktop user' },
  { value: 'source_kind', label: 'Source kind' },
]

export const NONE_LABEL = '(none)'

export function usageFiltersForGroupBy(groupBy: UsageGroupBy | null): UsageFilters | undefined {
  if (groupBy === 'recipe_name') {
    // Recipe breakdown is workflow-only; agent calls have recipe_name=NULL.
    return { source_kind: ['workflow'] }
  }
  if (groupBy === 'host_ref') {
    // Agent breakdown must not show workflow recipe hostRefs as agents.
    return { source_kind: ['channel', 'desktop', 'cron', 'unknown'] }
  }
  if (groupBy === 'user_id') {
    // Per spec, workflow usage is owned by recipe_name; user_id is the
    // stable desktop-session actor dimension.
    return { source_kind: ['desktop'] }
  }
  return undefined
}

/**
 * Clip the right edge of every range by this many milliseconds — events the
 * mcp-host UsageReporter is still buffering for its 60 s flush, plus the
 * rollup cron's 60 s tick interval, mean the most recent ~3 minutes lag
 * behind the wall clock. Showing 5 min of headroom keeps the trailing
 * bucket from looking falsely empty / truncated mid-bucket.
 */
export const TRAILING_LAG_MS = 5 * 60 * 1000

export function rangeToBounds(range: UsageRange, now: Date = new Date()): RangeBounds {
  const to = new Date(now.getTime() - TRAILING_LAG_MS)
  return { from: new Date(to.getTime() - RANGE_TO_MS[range]), to }
}

export const INTERVAL_TO_STEP_MS: Record<UsageInterval, number> = {
  '5min': 5 * 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
}

/**
 * Floor `date` down to the boundary of the rollup tier so the resulting
 * timestamp matches the bucket the server would produce. Done in UTC because
 * that is what the server's date_trunc('day' / 'hour', ts) produces and what
 * the rollup cron's 5-minute SQL truncation aligns to.
 */
export function floorToBucket(date: Date, interval: UsageInterval): Date {
  const d = new Date(date)
  if (interval === 'day') {
    d.setUTCHours(0, 0, 0, 0)
    return d
  }
  if (interval === 'hour') {
    d.setUTCMinutes(0, 0, 0)
    return d
  }
  // 5min: floor to nearest 5-minute boundary inside the current hour.
  const m = d.getUTCMinutes()
  d.setUTCMinutes(m - (m % 5), 0, 0)
  return d
}

/**
 * Returns every bucket-aligned timestamp in `[from, to]` for the given
 * interval, as ISO strings. Used to pad the time-series chart with empty
 * buckets so the X axis ticks are evenly spaced even when activity is sparse.
 */
export function generateBuckets(from: Date, to: Date, interval: UsageInterval): string[] {
  const step = INTERVAL_TO_STEP_MS[interval]
  const start = floorToBucket(from, interval).getTime()
  const end = to.getTime()
  const out: string[] = []
  for (let t = start; t <= end; t += step) {
    out.push(new Date(t).toISOString())
  }
  return out
}
