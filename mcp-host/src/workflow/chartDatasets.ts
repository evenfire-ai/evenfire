/**
 * The datasets a PNG chart draws: the theme's colors applied (seriesPaint.ts,
 * shared with the dashboard) and the composed chart types lowered to what
 * Chart.js draws.
 */
import type { ChartType } from 'chart.js'
import { colorWarnings, withoutInvalidColors } from './chartColors'
import type { NormalizedPoint } from './chartData'
import { sliceColors } from './chartPlugins'
import type { ChartTheme } from './chartThemes'
import { datasetKind, filled, seriesDefaults } from './seriesPaint'

export interface ChartDataset {
  label?: string
  /**
   * Numbers for category charts, {x,y[,r]} for scatter/bubble, and [from,to]
   * tuples once a waterfall has been expanded into floating bars.
   */
  data: Array<number | null> | NormalizedPoint[] | number[][]
  /** Per value when a list; a gap is a value placed by its label with no color of its own. */
  backgroundColor?: string | Array<string | undefined>
  borderColor?: string | Array<string | undefined>
  fill?: boolean
}

/**
 * `value` as a positive finite number; `fallback` when it is unset, and also
 * when it is not one, which `warnings` records.
 */
export function positiveNumber(
  field: string,
  value: unknown,
  fallback: number,
  warnings: string[]
): number {
  if (value === undefined || value === null) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    warnings.push(`${field} ${String(value)} is not a positive number; used ${fallback}.`)
    return fallback
  }
  return n
}

/**
 * Default radius of a series' points: `full` up to `crowd` points, and smaller
 * past that so a dense series keeps the ink of `crowd` points instead of
 * merging into one blot. Never under 1.5 px, so a lone point still shows.
 */
function pointRadius(full: number, crowd: number, points: number): number {
  return points <= crowd ? full : Math.max(1.5, full * Math.sqrt(crowd / points))
}

/**
 * Apply theme colors to datasets that don't specify their own. Each dataset gets
 * a different color from the palette by index. For pie/doughnut/polarArea where
 * each slice is a separate color, every slice gets its own color: a caller's
 * short list is completed from the theme, and slices past the palette get
 * shades of it.
 *
 * Palettes have 7 colors; with more datasets the palette wraps via
 * `idx % palette.length`, so series i and i+7 share a color. Callers who need
 * more distinct series pass `borderColor` / `backgroundColor` per dataset.
 */
function applyThemePalette(
  datasets: ChartDataset[],
  theme: ChartTheme,
  chartType: string,
  warnings: string[]
): ChartDataset[] {
  const sliceTypes = new Set(['pie', 'doughnut', 'polarArea'])
  const isSliceType = sliceTypes.has(chartType)

  return datasets.map((ds, idx) => {
    const out: ChartDataset = { ...ds }
    if (isSliceType) {
      if (typeof out.backgroundColor !== 'string') {
        const requested = out.backgroundColor
        const { colors, padded, repeated } = sliceColors(
          ds.data.length,
          requested,
          theme.palette,
          theme.backgroundColor
        )
        out.backgroundColor = colors
        if (Array.isArray(out.borderColor)) {
          out.borderColor = out.borderColor.map(c => c ?? theme.backgroundColor)
        }
        const where = `data.datasets[${idx}]`
        // Only a list shorter than the slices is short; an entry left empty
        // for not being a CSS color has a warning of its own.
        if (padded && requested!.length < ds.data.length) {
          warnings.push(
            `${where}.backgroundColor had ${requested!.length} color(s) for ${ds.data.length} ` +
              'slices; the rest were taken from the theme. Send one color per slice.'
          )
        }
        if (repeated) {
          warnings.push(
            `${where} has ${ds.data.length} slices, more than there are distinct colors, so ` +
              'some colors repeat. Group the smallest slices into "Other".'
          )
        }
      }
    } else {
      const color = theme.palette[idx % theme.palette.length]
      // Shared with the dashboard (seriesPaint.ts); `${color}33` is the
      // palette color at TINT_ALPHA.
      const paint = seriesDefaults(datasetKind(chartType, idx), ds, {
        color,
        tint: `${color}33`,
      })
      // A value with no color of its own in a list takes the series default.
      out.borderColor = filled(out.borderColor, paint.borderColor, color)
      out.backgroundColor = filled(out.backgroundColor, paint.backgroundColor, color)
      if (chartType === 'area' && out.fill === undefined) {
        out.fill = true
      }
      const point = out as unknown as Record<string, unknown>
      if (paint.pointBackgroundColor && point.pointBackgroundColor === undefined) {
        point.pointBackgroundColor = paint.pointBackgroundColor
      }
      if (paint.borderWidth && point.borderWidth === undefined)
        point.borderWidth = paint.borderWidth
      const points = Array.isArray(ds.data) ? ds.data.length : 0
      if (chartType === 'scatter') {
        if (point.pointRadius === undefined) point.pointRadius = pointRadius(6, 100, points)
      } else if (chartType === 'line' || chartType === 'area' || chartType === 'stackedArea') {
        // A value with a gap on both sides gets no segment, so its point is
        // its only mark.
        if (point.pointRadius === undefined) point.pointRadius = pointRadius(4, 60, points)
      }
    }
    return out
  })
}

export interface ResolvedChartType {
  chartType: ChartType
  // Loosely typed because Chart.js options that are valid only for specific
  // chart kinds (rotation/circumference/cutout for doughnut, indexAxis for
  // bar, etc.) don't satisfy the general ChartConfiguration['options'] union.
  // The cast happens once at config-merge time.
  optionsOverrides: Record<string, unknown> & {
    scales?: {
      x?: Record<string, unknown>
      y?: Record<string, unknown>
      y1?: Record<string, unknown>
    }
    plugins?: { legend?: { display?: boolean } }
    indexAxis?: 'x' | 'y'
  }
  /** When set, the caller should replace the labels array with this value. */
  labels?: string[]
  /** Gauge only: the reading as sent and the dial's ceiling, for the centre readout. */
  gaugeValue?: number
  gaugeMax?: number
  /** What the type changed about the data, for the caller. */
  notes: string[]
}

/**
 * Resolve our user-facing chart-type string to the underlying Chart.js
 * type AND compute per-type option overrides + dataset mutations.
 *
 * For composed types (gauge / waterfall / funnel / mixedBarLine / stacked*)
 * this function MUTATES `datasets` (and sometimes `labels`) in-place so
 * the caller can pass the result straight into the Chart.js config.
 */
function resolveChartType(
  raw: string,
  datasets: ChartDataset[],
  labels: string[] | undefined,
  theme: ChartTheme,
  args: Record<string, unknown>
): ResolvedChartType {
  const o: ResolvedChartType = { chartType: 'bar', optionsOverrides: {}, notes: [] }
  switch (raw) {
    case 'horizontalBar':
      o.chartType = 'bar'
      o.optionsOverrides.indexAxis = 'y'
      return o
    case 'area':
      o.chartType = 'line'
      // applyThemePalette already set fill=true for area datasets.
      return o
    case 'stackedBar':
      o.chartType = 'bar'
      o.optionsOverrides.scales = {
        x: { stacked: true },
        y: { stacked: true },
      }
      return o
    case 'stackedArea':
      o.chartType = 'line'
      o.optionsOverrides.scales = { y: { stacked: true } }
      datasets.forEach((d, i) => {
        if (d.fill === undefined) d.fill = (i === 0 ? 'origin' : '-1') as unknown as boolean
      })
      return o
    case 'mixedBarLine': {
      o.chartType = 'bar'
      // First dataset stays as bar (default for mixed); subsequent
      // datasets render as line overlays via Chart.js per-dataset `type`.
      const dual = args.dualAxis === true
      datasets.forEach((d, i) => {
        if (i > 0) {
          ;(d as any).type = 'line'
          ;(d as any).fill = false
          if (dual) (d as unknown as Record<string, unknown>).yAxisID = 'y1'
        }
      })
      if (dual) {
        o.optionsOverrides.scales = {
          y1: { position: 'right', grid: { drawOnChartArea: false } },
        }
      }
      return o
    }
    case 'bubble':
      o.chartType = 'bubble'
      return o
    case 'gauge': {
      o.chartType = 'doughnut'
      // Single-value 0..max. Take datasets[0].data[0] as the value;
      // build a 2-segment doughnut [value, max-value] and rotate it
      // 180° so the cut shows as a half-circle dial at the bottom.
      const ds = datasets[0]
      if (!ds) return o
      const values = (ds.data as unknown[]).filter((v): v is number => typeof v === 'number')
      const reading = values[0] ?? 0
      // The dial and its notes use this one validated ceiling.
      const max = positiveNumber('gaugeMax', args.gaugeMax, 100, o.notes)
      // Only the arc is bounded by the dial; the readout prints the reading.
      const arc = Math.min(Math.max(reading, 0), max)
      if (reading > max) {
        o.notes.push(
          `the gauge value ${reading} exceeds gaugeMax ${max}, so the dial is shown full; ` +
            'the readout prints the value. Raise gaugeMax to show it on the scale.'
        )
      } else if (reading < 0) {
        o.notes.push(`the gauge value ${reading} is below 0, so the dial is shown empty.`)
      }
      if (values.length > 1) {
        o.notes.push(
          `the gauge shows one value, so ${values.length - 1} more in data.datasets[0].data ` +
            `${values.length > 2 ? 'were' : 'was'} left out.`
        )
      }
      const fill = theme.palette[0]
      const remainder = theme.gridColor
      ds.data = [arc, max - arc]
      ds.backgroundColor = [fill, remainder]
      ds.borderColor = [fill, remainder]
      // Drop any extra datasets — gauge is single-value.
      datasets.length = 1
      o.gaugeValue = reading
      o.gaugeMax = max
      o.labels = ['Value', 'Remainder']
      o.optionsOverrides = {
        rotation: -90,
        circumference: 180,
        cutout: '70%',
        // The bottom padding leaves room under the dial's flat edge for the
        // "/ max" line the readout prints below it.
        radius: '88%',
        layout: { padding: { top: 12, right: 16, bottom: 90, left: 16 } },
        plugins: { legend: { display: false } },
      }
      return o
    }
    case 'waterfall': {
      o.chartType = 'bar'
      const ds = datasets[0]
      if (!ds || !Array.isArray(ds.data)) return o
      const deltas = ds.data as number[]
      const floats: number[][] = []
      const colors: string[] = []
      let cumulative = 0
      for (const delta of deltas) {
        const start = cumulative
        cumulative += Number(delta) || 0
        floats.push([start, cumulative])
        colors.push((Number(delta) || 0) >= 0 ? theme.positive : theme.negative)
      }
      // Final cumulative-total bar in primary color.
      floats.push([0, cumulative])
      colors.push(theme.palette[0])
      ds.data = floats as any
      ds.backgroundColor = colors
      ds.borderColor = colors
      // Append "Total" to labels (or synthesize labels if absent).
      const newLabels = labels ? [...labels] : deltas.map((_, i) => `Step ${i + 1}`)
      newLabels.push('Total')
      o.labels = newLabels
      // Drop extra datasets — waterfall is single-series.
      datasets.length = 1
      o.optionsOverrides = { plugins: { legend: { display: false } } }
      return o
    }
    case 'funnel': {
      o.chartType = 'bar'
      const ds = datasets[0]
      if (!ds || !Array.isArray(ds.data)) return o
      // Sort descending while keeping label/data alignment.
      const lbls = labels ?? (ds.data as number[]).map((_, i) => `Stage ${i + 1}`)
      const paired = (ds.data as number[]).map((v, i) => ({
        v: Number(v) || 0,
        l: lbls[i] ?? '',
        i,
      }))
      paired.sort((a, b) => b.v - a.v)
      ds.data = paired.map(p => p.v)
      o.labels = paired.map(p => p.l)
      // Per-stage colors follow their stage through the sort.
      const follow = (colors: string | Array<string | undefined> | undefined) =>
        Array.isArray(colors) ? paired.map(p => colors[p.i % colors.length]) : colors
      ds.backgroundColor = follow(ds.backgroundColor)
      ds.borderColor = follow(ds.borderColor)
      // Drop extra datasets — funnel is single-series.
      datasets.length = 1
      o.optionsOverrides = {
        indexAxis: 'y',
        plugins: { legend: { display: false } },
      }
      return o
    }
    default:
      o.chartType = raw as ChartType
      return o
  }
}

/**
 * The datasets as Chart.js draws them: the theme's colors applied, then the
 * composed types lowered. Also read by the check that the PNG and the
 * dashboard paint a chart alike.
 */
export function paintedDatasets(
  chartTypeRaw: string,
  datasets: ChartDataset[],
  labels: string[] | undefined,
  theme: ChartTheme,
  args: Record<string, unknown>,
  warnings: string[]
): { datasets: ChartDataset[]; resolved: ResolvedChartType } {
  // A color that is not a CSS color is left out for the palette's, as the
  // dashboard leaves it, instead of drawn black.
  const bad: Array<{ at: string; value: unknown }> = []
  const checked = datasets.map((ds, i) => withoutInvalidColors(ds, i, 'data', bad))
  warnings.push(...colorWarnings(bad, 'data'))
  const themed = applyThemePalette(checked, theme, chartTypeRaw, warnings)
  return { datasets: themed, resolved: resolveChartType(chartTypeRaw, themed, labels, theme, args) }
}
