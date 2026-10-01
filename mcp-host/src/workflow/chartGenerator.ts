/** The PNG chart generator (clerum__generate_chart): Chart.js drawn on a Skia canvas. */
import { type SKRSContext2D, createCanvas } from '@napi-rs/canvas'
import {
  Chart,
  type ChartConfiguration,
  type ChartType,
  type Plugin,
  type Scale,
  registerables,
} from 'chart.js'
import * as fs from 'fs'
import * as path from 'path'
import { config } from '../config'
import {
  artifactResult,
  claimOutputFile,
  enforceQuota,
  ensureDir,
  outputFilename,
  replacedBytes,
} from './artifactOutput'
import { ChartDataError, type NormalizedPoint, normalizeChartData } from './chartData'
import {
  type ValueFormat,
  type ValueLabelOptions,
  backgroundPlugin,
  emptyStatePlugin,
  formatValue,
  gaugeCenterPlugin,
  sliceColors,
  valueLabelsPlugin,
} from './chartPlugins'
import {
  CHART_THEMES,
  type ChartTheme,
  DEFAULT_CHART_HEIGHT,
  DEFAULT_CHART_WIDTH,
  MAX_CHART_DIMENSION,
  MIN_CHART_DIMENSION,
} from './chartThemes'
import { PNG_BASE_PPM } from './embeddedImages'
import { CHART_FONT_STACK, ensureFontsReady, sanitizeForFont } from './fonts'
import { choose } from './ownEntry'
import type { InternalToolResult } from './types'

// Register Chart.js controllers/scales/elements/plugins once. Chart.js v4 ships
// these as separate exports so we have to opt in. `registerables` includes all
// chart types we expose (line, bar, pie, doughnut, etc.) plus axes/legend/title.
Chart.register(...registerables)

/**
 * Charts use the stack ./fonts registers (Roboto first), so labels render the
 * same on every image, including one without system fonts. Set when a chart is
 * drawn, so importing this module leaves the fonts and Chart.js as they were.
 */
function prepareChartFonts(): void {
  ensureFontsReady()
  Chart.defaults.font.family = CHART_FONT_STACK
  Chart.defaults.color = '#0f172a'
}

/** Types whose series overlap, so their fill has to let the one below show. */
const TRANSLUCENT_FILL_TYPES = new Set(['line', 'area', 'radar'])

/** Widest a single bar may be drawn, in nominal pixels. */
const MAX_BAR_THICKNESS = 120

/** A plot area narrower or shorter than this, in px, shows too little of the data to read. */
const MIN_PLOT_SIDE = 40

const SUPPORTED_CHART_TYPES = new Set([
  // Core Chart.js types (one-to-one mapping):
  'line',
  'bar',
  'horizontalBar',
  'pie',
  'doughnut',
  'area',
  'scatter',
  'radar',
  'polarArea',
  'bubble',
  // Extended types built by composing options on top of base types:
  'stackedBar', // bar with stacked x/y scales
  'stackedArea', // line with fill stacking
  'mixedBarLine', // bar primary + line overlay datasets (combo charts)
  'gauge', // doughnut hack: half-circle dial for a single 0..max value
  'waterfall', // bar with floating tuples to show step-by-step deltas
  'funnel', // horizontal bar sorted descending — conversion / pipeline
])

interface ChartDataset {
  label?: string
  /**
   * Numbers for category charts, {x,y[,r]} for scatter/bubble, and [from,to]
   * tuples once a waterfall has been expanded into floating bars.
   */
  data: Array<number | null> | NormalizedPoint[] | number[][]
  backgroundColor?: string | string[]
  borderColor?: string | string[]
  fill?: boolean
}

/**
 * A mark that reaches the end of the plot has nowhere to put its value label
 * and reads as clipped, so a value axis runs 4% of its range past the data on
 * each side. Not past zero: values from 0 get an axis from 0, not from -20.
 * A bound set in the chart options stays as set.
 */
function addHeadroom(scale: Scale): void {
  const { min, max } = scale
  const room = (max - min) * 0.04
  if (!(room > 0)) return
  const set = scale.options as { min?: unknown; max?: unknown }
  if (set.max === undefined) scale.max = max <= 0 && max + room > 0 ? 0 : max + room
  if (set.min === undefined) scale.min = min >= 0 && min - room < 0 ? 0 : min - room
}

/**
 * Room past the data for the marks of a scatter or bubble chart, whose largest
 * mark reaches `radius` pixels from its value. The axis runs on past its end
 * ticks until a mark on the outermost value is drawn whole inside the plot,
 * clear of the tick labels, while the ticks stay where the data put them, so
 * an axis from 0 shows no -1. A bound set in the chart options stays as set.
 * Each axis takes its own pair of callbacks.
 */
function markRoom(radius: number): {
  afterDataLimits(scale: Scale): void
  afterBuildTicks(scale: Scale): void
} {
  let low = 0
  let high = 0
  return {
    afterDataLimits(scale) {
      low = scale.min
      high = scale.max
    },
    afterBuildTicks(scale) {
      const length = scale.isHorizontal() ? scale.width : scale.height
      // A mark wider than half the plot is not given room it cannot use.
      const r = Math.min(radius, length / 4)
      if (!(r > 0)) return
      const set = scale.options as { min?: unknown; max?: unknown }
      const first = scale.min
      const last = scale.max
      let min = first
      let max = last
      // The room a mark needs grows with the span it widens, so it is found by
      // iteration; each step changes the span by at most half the last one.
      for (let i = 0; i < 40; i++) {
        const need = (r * (max - min)) / length
        const nextMin = set.min === undefined ? Math.min(first, low - need) : first
        const nextMax = set.max === undefined ? Math.max(last, high + need) : last
        if (nextMin === min && nextMax === max) break
        min = nextMin
        max = nextMax
      }
      scale.min = min
      scale.max = max
      scale.ticks = spacedTicks(scale.ticks, (last - first) / (max - min))
    },
  }
}

/**
 * `ticks` for an axis they now span only `share` of. Chart.js spaced them for
 * the whole length, so when the room takes much of it every other one is
 * dropped, keeping the multiples of the doubled step so the values stay round.
 */
function spacedTicks<T extends { value: number }>(ticks: T[], share: number): T[] {
  if (!(share < 0.75) || ticks.length < 3) return ticks
  const step = 2 * (ticks[1].value - ticks[0].value)
  const kept = ticks.filter(t => Math.abs(t.value / step - Math.round(t.value / step)) < 1e-6)
  return kept.length >= 2 ? kept : ticks
}

/** Radius in pixels of the largest mark a scatter or bubble chart draws, its border included. */
function largestMark(chartType: string, datasets: ChartDataset[]): number {
  const size = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
  let largest = 0
  for (const ds of datasets) {
    const d = ds as unknown as Record<string, unknown>
    if (chartType === 'bubble') {
      const border = size(d.borderWidth, 1) / 2
      for (const point of ds.data as unknown[]) {
        const r = (point as { r?: unknown } | null)?.r
        largest = Math.max(largest, size(r, size(d.radius, 3)) + border)
      }
    } else {
      const border = size(d.pointBorderWidth, 1) / 2
      for (const r of [d.pointRadius ?? 3].flat()) largest = Math.max(largest, size(r, 0) + border)
    }
  }
  return largest
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
        const where = `data.datasets[${idx}]`
        if (padded) {
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
      if (!out.borderColor) out.borderColor = color
      if (!out.backgroundColor) {
        // Translucent wherever series are drawn over one another — a solid
        // radar fill hides every series behind the first.
        out.backgroundColor = TRANSLUCENT_FILL_TYPES.has(chartType) ? `${color}33` : color
      }
      if (chartType === 'area' && out.fill === undefined) {
        out.fill = true
      }
      const point = out as unknown as Record<string, unknown>
      const points = Array.isArray(ds.data) ? ds.data.length : 0
      if (chartType === 'scatter') {
        if (point.pointRadius === undefined) point.pointRadius = pointRadius(6, 100, points)
      } else if (chartType === 'line' || chartType === 'area' || chartType === 'stackedArea') {
        // A value with a gap on both sides gets no segment, so its point is
        // its only mark.
        if (point.pointRadius === undefined) point.pointRadius = pointRadius(4, 60, points)
        if (point.pointBackgroundColor === undefined) point.pointBackgroundColor = color
      }
    }
    return out
  })
}

interface ResolvedChartType {
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
      const max = Math.max(0, Number(args.gaugeMax) || 100)
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
      const follow = (colors: string | string[] | undefined) =>
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

// ─── Portable schema fragments ───────────────────────────────────────
//
// A tool schema does two jobs. The workflow path (stepRouter) compiles it with
// AJV and REJECTS arguments that do not match before execute() runs, so it must
// accept everything the runtime handles. And it reaches every provider
// verbatim, so it must survive each SDK's translation. Unions are therefore
// written as scalar type lists or `anyOf` branches — @google/genai turns both
// into its own schema — and never as `oneOf`, which it passes through
// untranslated for the Gemini API to reject. Every array declares `items`.

/** Nominal pixels are multiplied by this to keep charts sharp when scaled down. */
const CHART_PIXEL_RATIO = 2

/** Longest side a chart is laid out at, in nominal pixels. */
const MAX_LAYOUT_SIDE = 1600

/** Largest canvas drawn, in device pixels: 50 MiB of RGBA. */
const MAX_CANVAS_PIXELS = 13_107_200

/**
 * Pixel ratio for a chart of the requested size. A large chart is drawn at a
 * lower density rather than refused, down to 1; undefined when even that would
 * exceed MAX_CANVAS_PIXELS.
 */
function chartPixelRatio(width: number, height: number): number | undefined {
  const area = width * height
  if (area > MAX_CANVAS_PIXELS) return undefined
  return Math.min(CHART_PIXEL_RATIO, Math.sqrt(MAX_CANVAS_PIXELS / area))
}

/** Types where per-point labels would collide more than they inform. */
const VALUE_LABELS_OFF_BY_DEFAULT = new Set([
  'scatter',
  'bubble',
  'radar',
  'gauge',
  'stackedArea',
  'stackedBar',
])

function shouldLabelValues(chartType: string, requested: unknown): boolean {
  if (typeof requested === 'boolean') return requested
  return !VALUE_LABELS_OFF_BY_DEFAULT.has(chartType)
}

function resolveValueFormat(raw: unknown): ValueFormat {
  const allowed: ValueFormat[] = ['auto', 'plain', 'compact', 'currency', 'percent']
  const v = String(raw ?? 'auto') as ValueFormat
  return allowed.includes(v) ? v : 'auto'
}

/** True when every plotted number is absent or zero, so nothing would be drawn. */
function isVisuallyEmpty(datasets: ChartDataset[]): boolean {
  let sawNumber = false
  for (const ds of datasets) {
    for (const point of ds.data as unknown[]) {
      const value =
        typeof point === 'number'
          ? point
          : point && typeof point === 'object' && 'y' in point
            ? (point as { y: number }).y
            : Array.isArray(point)
              ? Number(point[1]) - Number(point[0])
              : null
      if (typeof value === 'number' && Number.isFinite(value)) {
        sawNumber = true
        if (value !== 0) return false
      }
    }
  }
  return sawNumber
}

function clampDimension(
  field: 'width' | 'height',
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
  if (n > MAX_CHART_DIMENSION) {
    warnings.push(
      `${field} ${n} is over the ${MAX_CHART_DIMENSION} maximum; used ${MAX_CHART_DIMENSION}.`
    )
    return MAX_CHART_DIMENSION
  }
  if (n < MIN_CHART_DIMENSION) {
    warnings.push(
      `${field} ${n} is under the ${MIN_CHART_DIMENSION} minimum, too small to read; ` +
        `used ${MIN_CHART_DIMENSION}.`
    )
    return MIN_CHART_DIMENSION
  }
  return Math.floor(n)
}

// ─── generate_markdown ───────────────────────────────────────────────

/**
 * Stamp a PNG's pHYs chunk so consumers know the image is oversampled.
 *
 * Charts are rasterized above their layout size to stay sharp in print. Every
 * embedder sizes an image from its pixel count, so without this the extra
 * pixels are read as extra size and the whole chart — its type included — is
 * scaled down to fit, landing at about a third of the surrounding body text.
 * Recording the density lets `imageDisplaySize` recover the size the chart was
 * laid out for.
 */
function stampPngDensity(png: Buffer, ratio: number): Buffer {
  const ppm = Math.round(PNG_BASE_PPM * ratio)
  const data = Buffer.alloc(9)
  data.writeUInt32BE(ppm, 0)
  data.writeUInt32BE(ppm, 4)
  data.writeUInt8(1, 8) // unit: metres
  const type = Buffer.from('pHYs', 'latin1')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  type.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length)

  // IHDR is always the first chunk: 8-byte signature + 4 length + 4 type + 13
  // data + 4 CRC. The new chunk goes straight after it.
  const insertAt = 8 + 25
  if (png.length < insertAt) return png
  return Buffer.concat([png.subarray(0, insertAt), chunk, png.subarray(insertAt)])
}

let crcTable: Uint32Array | undefined

function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export async function runGenerateChart(
  args: Record<string, unknown>,
  outputDir: string
): Promise<InternalToolResult> {
  let chart: Chart | undefined
  try {
    prepareChartFonts()

    const filename = outputFilename(args.filename, 'png', 'chart')
    const chartTypeRaw = String(args.type ?? 'bar')
    if (!SUPPORTED_CHART_TYPES.has(chartTypeRaw)) {
      return {
        success: false,
        error:
          `Unsupported chart type "${chartTypeRaw}". Supported types: ` +
          `${[...SUPPORTED_CHART_TYPES].join(', ')}.`,
      }
    }

    // Repair what the caller sent before anything is drawn, so an unusable
    // dataset fails with a message instead of rendering an empty plot.
    const normalized = normalizeChartData(args.data, { chartType: chartTypeRaw })
    const warnings = [...normalized.warnings]

    const width = clampDimension('width', args.width, DEFAULT_CHART_WIDTH, warnings)
    const height = clampDimension('height', args.height, DEFAULT_CHART_HEIGHT, warnings)

    // Pixel density for the requested size; the layout itself is capped below.
    const pixelRatio = chartPixelRatio(width, height)
    if (pixelRatio === undefined) {
      return {
        success: false,
        error:
          `Chart too large: ${width}x${height} is over the ` +
          `${(MAX_CANVAS_PIXELS / 1e6).toFixed(1)} megapixel limit. Reduce width or height.`,
      }
    }
    const theme =
      CHART_THEMES[choose(args.theme, Object.keys(CHART_THEMES), 'light', 'theme', warnings)]

    const title = args.title ? sanitizeForFont(String(args.title)) : undefined
    const yAxisLabel = args.yAxisLabel ? sanitizeForFont(String(args.yAxisLabel)) : undefined
    const xAxisLabel = args.xAxisLabel ? sanitizeForFont(String(args.xAxisLabel)) : undefined

    let labels = normalized.labels ? normalized.labels.map(l => sanitizeForFont(l)) : undefined
    const datasets: ChartDataset[] = normalized.datasets.map(ds => ({
      ...ds,
      ...(ds.label ? { label: sanitizeForFont(ds.label) } : {}),
    })) as ChartDataset[]

    const themedDatasets = applyThemePalette(datasets, theme, chartTypeRaw, warnings)
    const resolved = resolveChartType(chartTypeRaw, themedDatasets, labels, theme, args)
    const chartType = resolved.chartType
    if (resolved.labels !== undefined) labels = resolved.labels
    warnings.push(...resolved.notes)

    // Past MAX_LAYOUT_SIDE the chart is laid out smaller and drawn at a higher
    // density, so type, lines and bars keep their share of the image.
    const layoutScale = Math.max(1, Math.max(width, height) / MAX_LAYOUT_SIDE)
    const layoutWidth = Math.round(width / layoutScale)
    const layoutHeight = Math.round(height / layoutScale)

    // Type sized for the default canvas turns unreadable on a much larger
    // one, so every font size follows the canvas area.
    const fontScale = Math.min(
      2,
      Math.max(
        0.85,
        Math.sqrt((layoutWidth * layoutHeight) / (DEFAULT_CHART_WIDTH * DEFAULT_CHART_HEIGHT))
      )
    )
    const px = (base: number): number => Math.round(base * fontScale)

    const indexAxis = resolved.optionsOverrides?.indexAxis === 'y' ? 'y' : 'x'
    const decimals =
      typeof args.decimals === 'number' &&
      Number.isInteger(args.decimals) &&
      args.decimals >= 0 &&
      args.decimals <= 20
        ? args.decimals
        : undefined
    if (args.decimals !== undefined && decimals === undefined) {
      warnings.push(
        `decimals ${JSON.stringify(args.decimals)} is not a whole number from 0 to 20, so ` +
          'each value got the places it needs.'
      )
    }
    const valueOptions: ValueLabelOptions = {
      format: resolveValueFormat(args.valueFormat),
      ...(args.currencySymbol ? { currencySymbol: String(args.currencySymbol) } : {}),
      ...(decimals !== undefined ? { decimals } : {}),
      textColor: theme.textColor,
      backgroundColor: theme.backgroundColor,
      indexAxis,
      fontScale,
    }

    const cartesian =
      chartType === 'bar' ||
      chartType === 'line' ||
      chartType === 'scatter' ||
      chartType === 'bubble'
    const showAxes = cartesian && chartTypeRaw !== 'gauge'
    const radial = chartType === 'radar' || chartType === 'polarArea'

    const sliceChart =
      chartTypeRaw === 'pie' || chartTypeRaw === 'doughnut' || chartTypeRaw === 'polarArea'
    const legendEntries = sliceChart ? (labels?.length ?? 0) : themedDatasets.length
    // One series needs a legend only when its name says what the titles do not.
    const only = legendEntries === 1 && !sliceChart ? themedDatasets[0]?.label : undefined
    const namesMore =
      typeof only === 'string' &&
      only.trim() !== '' &&
      ![title, yAxisLabel, xAxisLabel].some(t =>
        t?.toLowerCase().includes(only.trim().toLowerCase())
      )
    const legendDisplay =
      args.showLegend === undefined
        ? resolved.optionsOverrides?.plugins?.legend?.display !== false &&
          (legendEntries > 1 || namesMore)
        : Boolean(args.showLegend)

    const labelValues = shouldLabelValues(chartTypeRaw, args.showValues)
    const plugins: Plugin[] = [backgroundPlugin(theme.backgroundColor)]
    const unlabelled = { count: 0 }
    const failed: string[] = []
    if (labelValues) plugins.push(valueLabelsPlugin({ ...valueOptions, unlabelled, failed }))
    if (chartTypeRaw === 'gauge') {
      plugins.push(
        gaugeCenterPlugin({
          value: resolved.gaugeValue ?? 0,
          max: resolved.gaugeMax ?? 100,
          textColor: theme.textColor,
          mutedColor: theme.mutedTextColor,
          format: valueOptions,
          failed,
        })
      )
    }
    if (isVisuallyEmpty(themedDatasets)) {
      plugins.push(emptyStatePlugin('No data to display', theme.textColor))
    }

    const axisTicks = {
      color: theme.textColor,
      font: { family: CHART_FONT_STACK, size: px(12) },
    }
    // Applied to whichever axis carries the values, never to the one carrying
    // the category names. The decision to abbreviate is taken from the whole
    // tick range, so one axis never mixes "$350K" with "$50,000".
    const valueTick = {
      callback: (value: string | number, _i: number, ticks: Array<{ value: number }>) => {
        const peak = Math.max(...ticks.map(t => Math.abs(t.value)), 0)
        const scaled =
          peak >= 10_000 ? { ...valueOptions, format: 'compact' as const } : valueOptions
        const prefix =
          valueOptions.format === 'currency' ? (valueOptions.currencySymbol ?? '$') : ''
        const suffix = valueOptions.format === 'percent' ? '%' : ''
        return peak >= 10_000
          ? `${Number(value) < 0 ? '-' : ''}${prefix}${formatValue(Math.abs(Number(value)), scaled)}${suffix}`
          : formatValue(Number(value), valueOptions)
      },
    }
    const headroom = { afterDataLimits: addHeadroom }
    const marks = chartTypeRaw === 'scatter' || chartTypeRaw === 'bubble'
    const radius = marks ? largestMark(chartTypeRaw, themedDatasets) : 0

    const config: ChartConfiguration = {
      type: chartType,
      data: { labels, datasets: themedDatasets as ChartConfiguration['data']['datasets'] },
      options: {
        responsive: false,
        animation: false,
        devicePixelRatio: pixelRatio * layoutScale,
        maintainAspectRatio: false,
        // Room for value labels that sit just outside the outermost marks.
        layout: { padding: { top: 12, right: 16, bottom: 4, left: 4 } },
        // Without a cap, a chart with one or two categories draws bars as
        // wide as the plot, which reads as a block rather than a measurement.
        datasets: { bar: { maxBarThickness: MAX_BAR_THICKNESS } },
        ...resolved.optionsOverrides,
        plugins: {
          title: title
            ? {
                display: true,
                text: title,
                color: theme.textColor,
                font: { family: CHART_FONT_STACK, size: px(17), weight: 'bold' as const },
                padding: { top: 6, bottom: 14 },
              }
            : { display: false },
          legend: {
            display: legendDisplay,
            position: 'top' as const,
            labels: {
              color: theme.textColor,
              font: { family: CHART_FONT_STACK, size: px(12) },
              usePointStyle: true,
              boxWidth: 10,
              boxHeight: 10,
            },
          },
          ...(resolved.optionsOverrides?.plugins ?? {}),
        },
        scales: showAxes
          ? {
              x: {
                ticks: {
                  ...axisTicks,
                  autoSkip: true,
                  maxRotation: 45,
                  minRotation: 0,
                  ...(indexAxis === 'y' ? valueTick : {}),
                },
                grid: { color: theme.gridColor },
                ...(marks ? markRoom(radius) : indexAxis === 'y' ? headroom : {}),
                title: xAxisLabel
                  ? {
                      display: true,
                      text: xAxisLabel,
                      color: theme.textColor,
                      font: { family: CHART_FONT_STACK, size: px(13) },
                    }
                  : { display: false },
                ...(resolved.optionsOverrides?.scales?.x ?? {}),
              },
              y: {
                ticks: {
                  ...axisTicks,
                  ...(indexAxis === 'x' ? valueTick : {}),
                },
                grid: { color: theme.gridColor },
                ...(marks ? markRoom(radius) : indexAxis === 'x' ? headroom : {}),
                title: yAxisLabel
                  ? {
                      display: true,
                      text: yAxisLabel,
                      color: theme.textColor,
                      font: { family: CHART_FONT_STACK, size: px(13) },
                    }
                  : { display: false },
                ...(resolved.optionsOverrides?.scales?.y ?? {}),
              },
              ...(resolved.optionsOverrides?.scales?.y1
                ? {
                    y1: {
                      ticks: axisTicks,
                      ...resolved.optionsOverrides.scales.y1,
                    },
                  }
                : {}),
            }
          : radial
            ? {
                r: {
                  // Above the data, so slices and fills do not cover the scale.
                  ticks: { ...axisTicks, backdropColor: theme.backgroundColor, z: 1 },
                  grid: { color: theme.gridColor },
                  angleLines: { color: theme.gridColor },
                  pointLabels: {
                    color: theme.textColor,
                    font: { family: CHART_FONT_STACK, size: px(12) },
                  },
                },
              }
            : undefined,
      },
      plugins,
    }

    // The canvas is created at the layout size and Chart.js is told the pixel
    // ratio, so it lays out in nominal units and rasterizes the backing store
    // at the higher density itself. Scaling the context by hand instead does
    // not work: Chart.js resets the transform, so the layout silently becomes
    // the full device size and every font ends up half its intended size
    // relative to the image.
    const canvas = createCanvas(layoutWidth, layoutHeight)
    const ctx = canvas.getContext('2d') as SKRSContext2D
    // Chart.js types target a browser CanvasRenderingContext2D; the Skia
    // context is API-compatible for the subset Chart.js uses.
    chart = new Chart(ctx as any, config)
    chart.update('none')
    if (args.showValues === true && unlabelled.count > 0) {
      const n = unlabelled.count
      warnings.push(
        `showValues: ${n} value${n === 1 ? '' : 's'} got no label, since at this size ` +
          `${n === 1 ? 'its label' : 'the labels'} would cover another bar or label, or the ` +
          'series is too dense; a larger chart or fewer series leaves room.'
      )
    }
    for (const what of new Set(failed)) {
      warnings.push(`The chart was drawn without ${what}.`)
    }
    // The plot area in requested pixels; the layout may run at a smaller scale.
    const plotWidth = Math.max(0, Math.round(chart.chartArea.width * layoutScale))
    const plotHeight = Math.max(0, Math.round(chart.chartArea.height * layoutScale))
    if (plotWidth < MIN_PLOT_SIDE || plotHeight < MIN_PLOT_SIDE) {
      warnings.push(
        `At ${width}x${height} px the title, legend and axes leave the data ` +
          `${plotWidth}x${plotHeight} px; use a larger width and height, or leave out the ` +
          'title or legend.'
      )
    }

    const pngBuffer = stampPngDensity(canvas.toBuffer('image/png'), pixelRatio)

    ensureDir(outputDir)
    const target = claimOutputFile(outputDir, filename)
    enforceQuota(outputDir, pngBuffer.byteLength, replacedBytes(target))
    fs.writeFileSync(target.filePath, pngBuffer)

    const summary =
      `Chart written: ${target.filename} (${canvas.width}x${canvas.height} px, ` +
      `${chartTypeRaw}, ${themedDatasets.length} series). To embed it, pass ` +
      `images: [{ path: '${target.filename}' }] to the PDF or DOCX generator, ` +
      `sheets[].images: [{ path: '${target.filename}' }] to the XLSX generator, or ` +
      `image: { path: '${target.filename}' } or chart: { path: '${target.filename}' } ` +
      'on a PPTX slide.'
    return artifactResult(target, 'png', { summary, warnings })
  } catch (err) {
    if (err instanceof ChartDataError) return { success: false, error: err.message }
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (chart) chart.destroy()
  }
}
