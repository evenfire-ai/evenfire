'use client'

import React, { useEffect, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { IconUsage } from '@components/Sidebar/icons'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { IconRefresh } from '@components/icons'
import {
  type AdminUser,
  type TeamListItem,
  type UsageGroupBy,
  type UsageInterval,
  type UsageSeriesRow,
  type UsageTotalsRow,
  fetchUsageSeries,
  fetchUsageTotals,
  getAdminTeams,
  getAdminUsers,
} from '@lib/api'
import {
  GROUP_BY_NONE_VALUE,
  GROUP_BY_OPTIONS,
  NONE_LABEL,
  RANGE_OPTIONS,
  RANGE_TO_INTERVAL,
  type UsageRange,
  floorToBucket,
  generateBuckets,
  rangeToBounds,
  usageFiltersForGroupBy,
} from './types'

type SeriesPoint = {
  bucket: string
  bucketLabel: string
  input_tokens: number
  output_tokens: number
}

type CategoryPoint = {
  bucket: string
  bucketLabel: string
  // dynamic per-category total-token columns; recharts indexes by these keys
  [categoryKey: string]: string | number
}

/**
 * Sum every row into its bucket, ignoring whatever dimension the API
 * grouped on. Used by the "no breakdown" mode to render the simple
 * input/output stacked-area chart.
 */
function aggregateInputOutput(
  rows: UsageSeriesRow[],
  from: Date,
  to: Date,
  interval: '5min' | 'hour' | 'day'
): SeriesPoint[] {
  const sums = new Map<string, { input: number; output: number }>()
  for (const r of rows) {
    const key = floorToBucket(new Date(r.bucket), interval).toISOString()
    const acc = sums.get(key)
    if (acc) {
      acc.input += r.input_tokens
      acc.output += r.output_tokens
    } else {
      sums.set(key, { input: r.input_tokens, output: r.output_tokens })
    }
  }
  return generateBuckets(from, to, interval).map(bucket => {
    const acc = sums.get(bucket)
    return {
      bucket,
      bucketLabel: formatBucket(bucket),
      input_tokens: acc?.input ?? 0,
      output_tokens: acc?.output ?? 0,
    }
  })
}

const CATEGORY_COLORS = [
  '#3b82f6', // blue-500
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#14b8a6', // teal-500
  '#f97316', // orange-500
] as const
const OTHER_COLOR = '#94a3b8' // slate-400
const OTHER_KEY = '__other__'
const OTHER_LABEL = '(other)'
const TOP_N = 8
const CONTROL_PLANE_ADMIN_USAGE_TEAM_ID = 'control-plane-admin-ui'
const CONTROL_PLANE_ADMIN_USAGE_TEAM_LABEL = 'Admin UI / Control Plane'

type CategorySlice = {
  /** dataKey passed to <Area>; opaque string suitable for recharts indexing. */
  key: string
  /** human-friendly legend/tooltip label. */
  label: string
  /** stable color from the palette, or OTHER_COLOR for the rolled-up bucket. */
  color: string
}

function pivotByCategory(
  rows: UsageSeriesRow[],
  from: Date,
  to: Date,
  interval: '5min' | 'hour' | 'day',
  groupBy: UsageGroupBy,
  teamsById: Map<string, string>,
  usersById: Map<string, string>,
  topN: number
): { points: CategoryPoint[]; categories: CategorySlice[] } {
  // Step 1: total per raw category value across the range to find the top N.
  // Null/empty groups still get a slot — they roll into NONE_LABEL via
  // resolveGroupLabel below.
  const totals = new Map<string | null, number>()
  for (const r of rows) {
    const k = r.group ?? null
    totals.set(k, (totals.get(k) ?? 0) + r.input_tokens + r.output_tokens)
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1])
  const topRaw = sorted.slice(0, topN).map(([k]) => k)
  const topSet = new Set<string | null>(topRaw)
  const hasOther = sorted.length > topN

  // dataKey strategy: prefer the raw value; fall back to a sentinel for null
  // (recharts can't index by null/empty) and for the rolled-up bucket.
  const NULL_KEY = '__null__'
  const rawToKey = (raw: string | null): string => {
    if (raw === null || raw === '') return NULL_KEY
    return raw
  }
  const topCategories: CategorySlice[] = topRaw.map((raw, i) => ({
    key: rawToKey(raw),
    label: resolveGroupLabel(raw, groupBy, teamsById, usersById),
    color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
  }))
  const categories: CategorySlice[] = hasOther
    ? [...topCategories, { key: OTHER_KEY, label: OTHER_LABEL, color: OTHER_COLOR }]
    : topCategories

  // Step 2: pivot rows into per-bucket-per-category sums of total_tokens.
  const byBucket = new Map<string, Map<string, number>>()
  for (const r of rows) {
    const bucketKey = floorToBucket(new Date(r.bucket), interval).toISOString()
    const raw = r.group ?? null
    const dataKey = topSet.has(raw) ? rawToKey(raw) : OTHER_KEY
    let inner = byBucket.get(bucketKey)
    if (!inner) {
      inner = new Map()
      byBucket.set(bucketKey, inner)
    }
    inner.set(dataKey, (inner.get(dataKey) ?? 0) + r.input_tokens + r.output_tokens)
  }

  // Step 3: emit a wide row per generated bucket. Pad with zero-valued
  // buckets across the full range so the X axis ticks stay evenly spaced
  // when activity is sparse, and so every <Area> has a defined dataKey at
  // every x position (recharts collapses undefined values weirdly when
  // stacking).
  const points: CategoryPoint[] = generateBuckets(from, to, interval).map(bucket => {
    const inner = byBucket.get(bucket)
    const point: CategoryPoint = { bucket, bucketLabel: formatBucket(bucket) }
    for (const c of categories) {
      point[c.key] = inner?.get(c.key) ?? 0
    }
    return point
  })

  return { points, categories }
}

function formatBucket(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function groupLabel(value: string | null): string {
  if (value === null || value === '') return NONE_LABEL
  return value
}

/**
 * Resolves the displayed label for a row based on the active dimension.
 *
 * - team_id and user_id are UUIDs that map to a name/email via the cached
 *   admin lookups. A row whose UUID isn't in the map (deleted entity)
 *   surfaces as "<uuid> (deleted)" so operators can still distinguish it
 *   from "(none)" / unbound usage.
 * - sender holds freeform handles for real channels (telegram username,
 *   email "From:", slack handle), so we leave it as-is — *unless* the
 *   value happens to be a known user UUID (legacy rpc-channel rows from
 *   before the desktop tagging fix), in which case we resolve the email
 *   without the "(deleted)" decoration since "this user is fine" is the
 *   common case there.
 */
function resolveGroupLabel(
  raw: string | null,
  groupBy: UsageGroupBy,
  teamsById: Map<string, string>,
  usersById: Map<string, string>
): string {
  if (raw === null || raw === '') return NONE_LABEL
  if (groupBy === 'team_id') {
    if (raw === CONTROL_PLANE_ADMIN_USAGE_TEAM_ID) return CONTROL_PLANE_ADMIN_USAGE_TEAM_LABEL
    return teamsById.get(raw) ?? `${raw} (deleted)`
  }
  if (groupBy === 'user_id') {
    return usersById.get(raw) ?? `${raw} (deleted)`
  }
  if (groupBy === 'sender') {
    return usersById.get(raw) ?? raw
  }
  return raw
}

export function UsageDashboard() {
  const [range, setRange] = useState<UsageRange>('24h')
  // null = no breakdown — chart shows the simple input/output stacked totals
  // and the breakdown list panel hides. Pick a category to switch into the
  // per-category coloured stacked-area view.
  const [groupBy, setGroupBy] = useState<UsageGroupBy | null>(null)
  const [series, setSeries] = useState<UsageSeriesRow[]>([])
  const [totals, setTotals] = useState<UsageTotalsRow[]>([])
  const [seriesBounds, setSeriesBounds] = useState<{ from: Date; to: Date } | null>(null)
  const [teamsById, setTeamsById] = useState<Map<string, string>>(() => new Map())
  const [usersById, setUsersById] = useState<Map<string, string>>(() => new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [refreshNonce, setRefreshNonce] = useState(0)

  const interval = RANGE_TO_INTERVAL[range]

  // Teams + users are stable across page loads — fetch once on mount and
  // reuse the id→name maps for every team_id / user_id breakdown render.
  // An entity that was deleted since the rollup row was written falls back
  // to the raw id with "(deleted)" suffix, signalling "this entity is gone".
  // Sender values are freeform handles for real channels (telegram, slack,
  // email); for the legacy/rpc-tagged rows the value is also a user UUID, so
  // the same users map resolves both paths.
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      getAdminTeams().catch(() => ({ items: [] as TeamListItem[] })),
      getAdminUsers().catch(() => ({ items: [] as AdminUser[] })),
    ]).then(([teamsRes, usersRes]) => {
      if (cancelled) return
      const teams = new Map<string, string>()
      for (const t of (teamsRes.items ?? []) as TeamListItem[]) {
        teams.set(t.id, t.name)
      }
      setTeamsById(teams)
      const users = new Map<string, string>()
      for (const u of (usersRes.items ?? []) as AdminUser[]) {
        users.set(u.id, u.email || u.displayName || u.name || u.id)
      }
      setUsersById(users)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoading(true)
      setError('')
      try {
        const { from, to } = rangeToBounds(range)
        const fromIso = from.toISOString()
        const toIso = to.toISOString()
        // The series API requires a groupBy dimension, even when we're
        // rendering the dimensionless input/output view. host_ref is a cheap
        // dim (low cardinality, indexed) and gets summed across by
        // aggregateInputOutput, so the choice doesn't affect the chart.
        const seriesGroupBy: UsageGroupBy = groupBy ?? 'host_ref'
        const breakdownFilters = usageFiltersForGroupBy(groupBy)
        const [seriesRes, totalsRes] = await Promise.all([
          fetchUsageSeries({
            from: fromIso,
            to: toIso,
            interval,
            groupBy: seriesGroupBy,
            filters: breakdownFilters,
          }),
          groupBy === null
            ? Promise.resolve({ rows: [] as UsageTotalsRow[] })
            : fetchUsageTotals({
                from: fromIso,
                to: toIso,
                interval,
                groupBy,
                filters: breakdownFilters,
                limit: 10,
              }),
        ])
        if (cancelled) return
        setSeries(seriesRes.rows)
        setTotals(totalsRes.rows)
        setSeriesBounds({ from, to })
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load usage data')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [range, groupBy, interval, refreshNonce])

  // Chart data: branch on whether a breakdown dimension is selected.
  // - null      → SeriesPoint[]    with input_tokens + output_tokens
  // - dimension → CategoryPoint[]  with one column per top-N value
  const inputOutputPoints = useMemo(() => {
    if (!seriesBounds || groupBy !== null) return [] as SeriesPoint[]
    return aggregateInputOutput(series, seriesBounds.from, seriesBounds.to, interval)
  }, [series, seriesBounds, interval, groupBy])

  const { categoryPoints, seriesCategories } = useMemo(() => {
    if (!seriesBounds || groupBy === null) {
      return { categoryPoints: [] as CategoryPoint[], seriesCategories: [] as CategorySlice[] }
    }
    const { points, categories } = pivotByCategory(
      series,
      seriesBounds.from,
      seriesBounds.to,
      interval,
      groupBy,
      teamsById,
      usersById,
      TOP_N
    )
    return { categoryPoints: points, seriesCategories: categories }
  }, [series, seriesBounds, interval, groupBy, teamsById, usersById])

  const grandTotal = useMemo(() => {
    let input = 0
    let output = 0
    let requests = 0
    for (const r of series) {
      input += r.input_tokens
      output += r.output_tokens
      requests += r.request_count
    }
    return { input, output, total: input + output, requests }
  }, [series])

  const breakdownMax = useMemo(
    () => totals.reduce((max, r) => Math.max(max, r.total_tokens), 0),
    [totals]
  )

  return (
    <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
      <TablePanelHeader
        title={
          <>
            <IconUsage />
            LLM Usage
          </>
        }
        subtitle="Track token usage and request volume across LLM activity."
        actions={
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--toolbar"
            onClick={() => setRefreshNonce(n => n + 1)}
            disabled={loading}
            aria-label={loading ? 'Refreshing usage' : 'Refresh usage'}
          >
            <IconRefresh className={loading ? 'cu-spin' : undefined} width={18} height={18} />
          </button>
        }
      />

      <div className="cu-card__body cu-usage-body">
        {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

        <FiltersBar range={range} setRange={setRange} groupBy={groupBy} setGroupBy={setGroupBy} />

        <SummaryStrip grandTotal={grandTotal} interval={interval} />

        <Panel
          title="Tokens over time"
          subtitle={
            groupBy === null
              ? 'Stacked: input + output, summed across all dimensions.'
              : `Stacked total tokens by ${GROUP_BY_OPTIONS.find(o => o.value === groupBy)?.label.toLowerCase()}.${seriesCategories.some(c => c.key === OTHER_KEY) ? ` Top ${TOP_N} shown; the rest roll into ${OTHER_LABEL}.` : ''}`
          }
        >
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={groupBy === null ? inputOutputPoints : categoryPoints}
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid stroke="var(--cu-border-subtle)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="bucketLabel"
                  fontSize={11}
                  stroke="var(--cu-text-muted)"
                  minTickGap={32}
                />
                <YAxis fontSize={11} stroke="var(--cu-text-muted)" tickFormatter={formatTokens} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--cu-bg-elevated)',
                    border: '1px solid var(--cu-border-subtle)',
                    fontSize: 12,
                  }}
                  formatter={(v: number, name: string) => [formatTokens(v), name]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {groupBy === null ? (
                  <>
                    <Area
                      type="monotone"
                      dataKey="input_tokens"
                      name="Input"
                      stackId="1"
                      stroke="#3b82f6"
                      fill="#3b82f6"
                      fillOpacity={0.6}
                    />
                    <Area
                      type="monotone"
                      dataKey="output_tokens"
                      name="Output"
                      stackId="1"
                      stroke="#10b981"
                      fill="#10b981"
                      fillOpacity={0.6}
                    />
                  </>
                ) : (
                  seriesCategories.map(cat => (
                    <Area
                      key={cat.key}
                      type="monotone"
                      dataKey={cat.key}
                      name={cat.label}
                      stackId="1"
                      stroke={cat.color}
                      fill={cat.color}
                      fillOpacity={0.65}
                    />
                  ))
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {(groupBy === null ? inputOutputPoints : categoryPoints).length === 0 && !loading ? (
            <div className="cu-empty">No usage in the selected range.</div>
          ) : null}
        </Panel>

        {groupBy !== null ? (
          <Panel
            title={`Top ${GROUP_BY_OPTIONS.find(o => o.value === groupBy)?.label.toLowerCase() ?? 'group'}s`}
            subtitle={`Top 10 by total tokens. Rows with no value bucket under ${NONE_LABEL}.`}
          >
            <BreakdownList
              rows={totals}
              max={breakdownMax}
              loading={loading}
              groupBy={groupBy}
              teamsById={teamsById}
              usersById={usersById}
            />
          </Panel>
        ) : null}
      </div>
    </div>
  )
}

function FiltersBar(props: {
  range: UsageRange
  setRange: (r: UsageRange) => void
  groupBy: UsageGroupBy | null
  setGroupBy: (g: UsageGroupBy | null) => void
}) {
  return (
    <div className="cu-usage-filters">
      <div className="cu-usage-filter-group">
        <label className="cu-muted cu-usage-filter-label" htmlFor="usage-range">
          Range
        </label>
        <select
          id="usage-range"
          className="cu-input cu-usage-select"
          value={props.range}
          onChange={e => props.setRange(e.target.value as UsageRange)}
        >
          {RANGE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div className="cu-usage-filter-group">
        <label className="cu-muted cu-usage-filter-label" htmlFor="usage-groupby">
          Break down by
        </label>
        <select
          id="usage-groupby"
          className="cu-input cu-usage-select cu-usage-select--group"
          value={props.groupBy ?? GROUP_BY_NONE_VALUE}
          onChange={e => {
            const v = e.target.value
            props.setGroupBy(v === GROUP_BY_NONE_VALUE ? null : (v as UsageGroupBy))
          }}
        >
          {GROUP_BY_OPTIONS.map(opt => (
            <option key={opt.value || 'none'} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

function SummaryStrip(props: {
  grandTotal: { input: number; output: number; total: number; requests: number }
  interval: UsageInterval
}) {
  const { grandTotal } = props
  return (
    <div className="cu-usage-stats">
      <Stat label="Total tokens" value={formatTokens(grandTotal.total)} />
      <Stat label="Input tokens" value={formatTokens(grandTotal.input)} />
      <Stat label="Output tokens" value={formatTokens(grandTotal.output)} />
      <Stat label="Requests" value={grandTotal.requests.toLocaleString()} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="cu-usage-stat">
      <div className="cu-usage-stat-label">{label}</div>
      <div className="cu-usage-stat-value">{value}</div>
    </div>
  )
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="cu-usage-panel">
      <div className="cu-usage-panel__head">
        <div className="cu-usage-panel-title">{title}</div>
        {subtitle ? <div className="cu-usage-panel-subtitle">{subtitle}</div> : null}
      </div>
      {children}
    </div>
  )
}

function BreakdownList({
  rows,
  max,
  loading,
  groupBy,
  teamsById,
  usersById,
}: {
  rows: UsageTotalsRow[]
  max: number
  loading: boolean
  groupBy: UsageGroupBy
  teamsById: Map<string, string>
  usersById: Map<string, string>
}) {
  if (rows.length === 0 && !loading) {
    return <div className="cu-empty">No usage in the selected range.</div>
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.map((row, i) => {
        const pct = max > 0 ? (row.total_tokens / max) * 100 : 0
        const label = resolveGroupLabel(row.group, groupBy, teamsById, usersById)
        return (
          <div
            key={`${label}-${i}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'var(--cu-bg-elevated)',
                  border: '1px solid var(--cu-border-subtle)',
                  borderRadius: 6,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: `${pct}%`,
                  background: 'rgba(59, 130, 246, 0.18)',
                  borderRadius: 6,
                }}
              />
              <div
                style={{
                  position: 'relative',
                  padding: '6px 10px',
                  fontSize: 13,
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontFamily: row.group === null ? 'inherit' : 'monospace',
                    color: row.group === null ? 'var(--cu-text-muted)' : undefined,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {label}
                </span>
                <span className="cu-muted" style={{ fontSize: 11 }}>
                  {row.request_count.toLocaleString()} req
                </span>
              </div>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, minWidth: 60, textAlign: 'right' }}>
              {formatTokens(row.total_tokens)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
