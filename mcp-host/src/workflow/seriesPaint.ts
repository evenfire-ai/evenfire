/**
 * How a chart series is painted, the same in the PNG renderer (chartGenerator)
 * and the dashboard (dashboardCharts): which kinds tint their fill, which draw
 * point marks, and what a caller's own colors change. Each output resolves the
 * palette its own way: hex colors in the PNG, theme tokens in the dashboard.
 */
import { color } from 'chart.js/helpers'
import { isCssColor } from './chartColors'

/** Fills that lie over one another, drawn as a tint of the series color. */
const TINTED_FILL = new Set(['line', 'area', 'radar'])

/** Marks filled in the series color: scatter points and stacked areas. */
const SERIES_FILL = new Set(['scatter', 'stackedArea'])

/**
 * Bars, whose borderColor is their outline, as the schemas say; Chart.js draws
 * a bar with no outline by default, so a caller's border gets a width.
 */
const OUTLINED = new Set(['bar', 'horizontalBar', 'stackedBar', 'funnel'])

/** The width a caller's bar outline is drawn at. */
const OUTLINE_WIDTH = 2

/** Lines and webs whose values are point marks in the series color, not the tint. */
const POINT_MARKS = new Set(['line', 'area', 'stackedArea', 'radar'])

/** The opacity of a tinted fill. */
export const TINT_ALPHA = 0.2

/** A series' palette color and its tint, as an output writes them. */
export interface PaletteColors {
  color: string
  tint: string
}

/** One color for a whole series, or one per value. */
export type SeriesColors = string | string[]

export interface SeriesDefaults {
  borderColor: string
  backgroundColor: SeriesColors
  /** Set only for kinds that draw point marks. */
  pointBackgroundColor?: SeriesColors
  /** Set only for a bar whose caller sent a border color. */
  borderWidth?: number
}

/** A caller's color at TINT_ALPHA, or undefined when chart.js cannot read it. */
export function tintOf(css: string): string | undefined {
  const parsed = color(css)
  return parsed.valid ? parsed.alpha(TINT_ALPHA).rgbString() : undefined
}

/**
 * The colors one series of `kind` takes where the caller set none (`kind` per
 * dataset: the lines of a mixedBarLine are 'line'). The series color is the
 * caller's borderColor, one color or one per value, else the palette's; a
 * value with no usable color of its own takes the palette's. Fills that lie
 * over one another (line, area, radar) are the tint of a single series color,
 * the palette's tint otherwise or when chart.js cannot read the color; points
 * on lines and webs, scatter points and stacked areas take the series color.
 * A bar or a bubble keeps the palette's fill, and the caller's color is its
 * outline, drawn for a bar at OUTLINE_WIDTH.
 */
export function seriesDefaults(
  kind: string,
  ds: { borderColor?: unknown },
  palette: PaletteColors
): SeriesDefaults {
  const own = ds.borderColor
  const single = typeof own === 'string' && isCssColor(own) ? own : undefined
  const perValue =
    Array.isArray(own) && own.length > 0
      ? own.map(c => (typeof c === 'string' && isCssColor(c) ? c : palette.color))
      : undefined
  const seriesColor: SeriesColors = single ?? perValue ?? palette.color
  const backgroundColor = TINTED_FILL.has(kind)
    ? ((single !== undefined ? tintOf(single) : undefined) ?? palette.tint)
    : SERIES_FILL.has(kind)
      ? seriesColor
      : palette.color
  return {
    borderColor: palette.color,
    backgroundColor,
    ...(POINT_MARKS.has(kind) ? { pointBackgroundColor: seriesColor } : {}),
    ...(OUTLINED.has(kind) && (single ?? perValue) !== undefined
      ? { borderWidth: OUTLINE_WIDTH }
      : {}),
  }
}

/**
 * `value`, with `fallback` where it sets no color: for the whole series when
 * it is unset, and for each empty entry of a per-value list, which takes the
 * fallback's color for that value (a short fallback list wraps), else `last`.
 */
export function filled(
  value: string | Array<string | undefined> | undefined,
  fallback: SeriesColors,
  last: string
): SeriesColors {
  if (value === undefined || value === '') return fallback
  if (!Array.isArray(value)) return value
  // A short fallback list wraps over the values, as Chart.js wraps it.
  return value.map(
    (c, i) =>
      c ??
      (Array.isArray(fallback)
        ? fallback.length > 0
          ? fallback[i % fallback.length]
          : last
        : fallback)
  )
}

/** The kind each dataset of a `chartType` chart is painted as. */
export function datasetKind(chartType: string, index: number): string {
  if (chartType === 'mixedBarLine') return index === 0 ? 'bar' : 'line'
  return chartType
}
