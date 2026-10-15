/**
 * How a chart series is painted, the same in the PNG renderer (chartGenerator)
 * and the dashboard (dashboardCharts): which kinds tint their fill, which draw
 * point marks, and what a caller's own colors change. Each output resolves the
 * palette its own way: hex colors in the PNG, theme tokens in the dashboard.
 */
import { color } from 'chart.js/helpers'

/** Fills that lie over one another, drawn as a tint of the series color. */
const TINTED_FILL = new Set(['line', 'area', 'radar', 'bubble'])

/** Fills in the series color: stacked areas do not overlap, scatter marks are its points. */
const SERIES_FILL = new Set(['stackedArea', 'scatter'])

/** Lines and webs whose values are point marks in the series color, not the tint. */
const POINT_MARKS = new Set(['line', 'area', 'stackedArea', 'radar'])

/** The opacity of a tinted fill. */
export const TINT_ALPHA = 0.2

/** A series' palette color and its tint, as an output writes them. */
export interface PaletteColors {
  color: string
  tint: string
}

export interface SeriesDefaults {
  borderColor: string
  backgroundColor: string
  /** Set only for kinds that draw point marks. */
  pointBackgroundColor?: string
}

/** A caller's color at TINT_ALPHA, or undefined when chart.js cannot read it. */
export function tintOf(css: string): string | undefined {
  const parsed = color(css)
  return parsed.valid ? parsed.alpha(TINT_ALPHA).rgbString() : undefined
}

/**
 * The colors one series of `kind` takes where the caller set none (`kind` per
 * dataset: the lines of a mixedBarLine are 'line'). The series color is the
 * caller's single borderColor, else the palette's. Fills that lie over one
 * another are its tint, the palette's tint when chart.js cannot read the
 * caller's color; stacked areas and scatter marks are the color itself; bars
 * keep the palette's fill under a caller's outline. Points on lines and webs
 * take the series color.
 */
export function seriesDefaults(
  kind: string,
  ds: { borderColor?: unknown },
  palette: PaletteColors
): SeriesDefaults {
  const own =
    typeof ds.borderColor === 'string' && ds.borderColor !== '' ? ds.borderColor : undefined
  const seriesColor = own ?? palette.color
  const backgroundColor = TINTED_FILL.has(kind)
    ? ((own !== undefined ? tintOf(own) : undefined) ?? palette.tint)
    : SERIES_FILL.has(kind)
      ? seriesColor
      : palette.color
  return {
    borderColor: palette.color,
    backgroundColor,
    ...(POINT_MARKS.has(kind) ? { pointBackgroundColor: seriesColor } : {}),
  }
}

/** The kind each dataset of a `chartType` chart is painted as. */
export function datasetKind(chartType: string, index: number): string {
  if (chartType === 'mixedBarLine') return index === 0 ? 'bar' : 'line'
  return chartType
}
