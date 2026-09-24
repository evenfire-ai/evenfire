/**
 * Native (editable) PowerPoint charts for clerum__generate_pptx.
 *
 * The data goes through the same normalizer as clerum__generate_chart, because
 * PowerPoint drops chart-cache values written as text such as "1,200".
 */
import { ChartDataError, normalizeChartData } from './chartData'
import { PPTX_FONT_FACE } from './pptxText'

/** Types drawn as native charts; the stacked ones are bar and area charts with stacked grouping. */
export const NATIVE_CHART_TYPES = [
  'line',
  'bar',
  'horizontalBar',
  'pie',
  'doughnut',
  'area',
  'stackedBar',
  'stackedArea',
] as const

export type NativeChartType = (typeof NATIVE_CHART_TYPES)[number]

const SLICE_TYPES = new Set<NativeChartType>(['pie', 'doughnut'])

/** Series longer than this get no value labels; they would overlap. */
const MAX_LABELLED_POINTS = 12

export interface NativeChart {
  type: NativeChartType
  labels: string[]
  series: Array<{ name: string; values: Array<number | null> }>
}

export class ChartSpecError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * The native chart `raw` describes, or undefined when it carries no data at
 * all. Throws ChartSpecError, naming the field under `where`, for a type
 * PowerPoint cannot draw natively or data no chart can be drawn from.
 */
export function readNativeChart(
  raw: Record<string, unknown>,
  where: string,
  warnings: string[]
): NativeChart | undefined {
  const nested = isRecord(raw.data) ? raw.data : undefined
  // Labels and datasets are each read where they were given, nested or at the top.
  const labelsFrom = nested?.labels !== undefined ? nested : raw
  const datasetsFrom = nested?.datasets !== undefined ? nested : raw
  if (datasetsFrom.datasets === undefined && labelsFrom.labels === undefined) return undefined

  let type: NativeChartType
  if (raw.type === undefined || raw.type === null || raw.type === '') {
    type = 'bar'
    warnings.push(`${where}.type was missing, so a bar chart was drawn; set type to choose one.`)
  } else if ((NATIVE_CHART_TYPES as readonly unknown[]).includes(raw.type)) {
    type = raw.type as NativeChartType
  } else {
    throw new ChartSpecError(
      `${where}.type ${JSON.stringify(raw.type)} has no native PowerPoint chart. Use one of ` +
        `${NATIVE_CHART_TYPES.join(', ')}; for any other type, draw it with ` +
        `clerum__generate_chart and pass the file name it returns as ${where}.path.`
    )
  }

  const baseOf = (from: Record<string, unknown>) => (from === nested ? `${where}.data` : where)
  const base = baseOf(datasetsFrom)
  // Template charts leave the nested form out of the schema, so its labels are checked here.
  if (nested) checkNestedLabels(nested, `${where}.data`)
  const rewrite = (message: string) =>
    message
      .replace(/\bdata\.labels\b/g, `${baseOf(labelsFrom)}.labels`)
      .replace(/\bdata\.datasets\b/g, `${base}.datasets`)
      .replace(/`data`/g, `\`${base}\``)
  let normalized
  try {
    normalized = normalizeChartData(
      { labels: labelsFrom.labels, datasets: datasetsFrom.datasets },
      { chartType: type }
    )
  } catch (err) {
    if (err instanceof ChartDataError) throw new ChartSpecError(rewrite(err.message))
    throw err
  }
  for (const w of normalized.warnings) {
    const text = rewrite(w)
    warnings.push(text.includes(where) ? text : `${where}: ${text}`)
  }

  const unnamed = normalized.datasets.filter(d => !d.label).length
  if (unnamed > 0 && normalized.datasets.length > 1) {
    warnings.push(
      `${base}.datasets: ${unnamed} series had no label, so the legend numbers them; give each a label.`
    )
  }
  let series = normalized.datasets.map((d, i) => ({
    name: boundLabel(d.label || `#${i + 1}`, MAX_SERIES_NAME),
    values: d.data as Array<number | null>,
  }))
  if (SLICE_TYPES.has(type) && series.length > 1) {
    warnings.push(
      `${where}: a ${type} chart draws one series, so only "${series[0].name}" was drawn and ` +
        `${series.length - 1} more were left out. Use a bar or line chart to compare series.`
    )
    series = series.slice(0, 1)
  }
  const labels = (normalized.labels ?? []).map(l => boundLabel(l, MAX_CATEGORY_LABEL))
  return { type, labels, series }
}

function checkNestedLabels(data: Record<string, unknown>, base: string): void {
  if (Array.isArray(data.labels)) {
    data.labels.forEach((label, i) => {
      if (typeof label !== 'string' && typeof label !== 'number') {
        throw new ChartSpecError(`${base}.labels[${i}] must be text or a number.`)
      }
    })
  }
  if (Array.isArray(data.datasets)) {
    data.datasets.forEach((ds, i) => {
      if (isRecord(ds) && ds.label !== undefined && typeof ds.label !== 'string') {
        throw new ChartSpecError(`${base}.datasets[${i}].label must be text.`)
      }
    })
  }
}

/** Axis and legend text longer than this crowds the plot out of the chart area. */
const MAX_CATEGORY_LABEL = 80
const MAX_SERIES_NAME = 100

function boundLabel(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

export interface NativeChartStyle {
  /** Shown above the plot; omitted when it would repeat the slide title. */
  title?: string
  colors: string[]
  textColor: string
  mutedColor: string
}

/**
 * Values below 1000 in General, which prints each with the decimals it has,
 * and larger ones grouped: "1,200", "5,000,000" and "980.5" in one series.
 * "#,##0.##" would print the integers as "1,200.".
 */
const GROUPED_OR_GENERAL = '[>=1000]#,##0;[<=-1000]-#,##0;General'

/** Decimal places `v` carries, ignoring binary noise such as 0.1 + 0.2. */
function decimals(v: number): number {
  const text = String(Number(v.toPrecision(12)))
  if (text.includes('e')) return 0
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0
}

/** Excel number formats for the value labels and the value axis. */
function valueFormats(values: number[]): { label: string; axis: string } {
  const fractional = values.filter(v => !Number.isInteger(v))
  let label = '#,##0'
  if (fractional.some(v => Math.abs(v) >= 1000)) {
    // Grouping and General cannot be combined, so every label gets the same decimals.
    const places = Math.min(Math.max(...fractional.map(decimals), 1), 2)
    label = `#,##0.${'0'.repeat(places)}`
  } else if (fractional.length > 0) {
    label = GROUPED_OR_GENERAL
  }
  // PowerPoint picks fractional axis steps for small ranges, which an integer
  // format would print as repeated labels; grouping only matters for large values.
  const axis = values.some(v => Math.abs(v) >= 1000) ? '#,##0' : 'General'
  return { label, axis }
}

/** Arguments for pptxgenjs `slide.addChart(type, data, options)`. */
export function nativeChartArgs(
  chart: NativeChart,
  style: NativeChartStyle,
  pptx: any
): { type: string; data: unknown[]; options: Record<string, unknown> } {
  const c = pptx.charts ?? {}
  const type =
    chart.type === 'line'
      ? (c.LINE ?? 'line')
      : chart.type === 'area' || chart.type === 'stackedArea'
        ? (c.AREA ?? 'area')
        : chart.type === 'pie'
          ? (c.PIE ?? 'pie')
          : chart.type === 'doughnut'
            ? (c.DOUGHNUT ?? 'doughnut')
            : (c.BAR ?? 'bar')
  const slices = SLICE_TYPES.has(chart.type)
  const stacked = chart.type === 'stackedBar' || chart.type === 'stackedArea'
  const barLike = ['bar', 'horizontalBar', 'stackedBar'].includes(chart.type)
  const labelled =
    !slices &&
    (barLike || chart.type === 'line') &&
    chart.series.every(s => s.values.length <= MAX_LABELLED_POINTS)
  const values = chart.series.flatMap(s => s.values).filter((v): v is number => v !== null)
  const format = valueFormats(values)
  const options: Record<string, unknown> = {
    barDir: chart.type === 'horizontalBar' ? 'bar' : 'col',
    // pptxgenjs colors each bar of a lone series differently when given
    // several colors, which reads as a legend that is not there.
    chartColors: barLike && chart.series.length === 1 ? style.colors.slice(0, 1) : style.colors,
    showTitle: Boolean(style.title),
    title: style.title ?? '',
    titleColor: style.textColor,
    titleFontFace: PPTX_FONT_FACE,
    titleFontSize: 16,
    // A single-series bar or line needs no key; a pie always does, because
    // its categories appear nowhere else.
    showLegend: slices || chart.series.length > 1,
    legendPos: slices ? 'r' : 'b',
    legendColor: style.textColor,
    legendFontFace: PPTX_FONT_FACE,
    legendFontSize: 12,
    catAxisLabelColor: style.mutedColor,
    catAxisLabelFontFace: PPTX_FONT_FACE,
    valAxisLabelColor: style.mutedColor,
    valAxisLabelFontFace: PPTX_FONT_FACE,
    valAxisLabelFormatCode: format.axis,
    dataLabelFontFace: PPTX_FONT_FACE,
    dataLabelFontSize: 11,
    dataLabelColor: style.textColor,
  }
  if (stacked) options.barGrouping = 'stacked'
  if (!slices) {
    // A missing value is a gap in the line, not a straight segment drawn across it.
    options.displayBlanksAs = 'gap'
  }
  if (chart.type !== 'line' && !slices) {
    // A bar or area is read by its length, so the value axis starts at zero, as
    // clerum__generate_chart draws it; PowerPoint would otherwise start near the
    // smallest value. An all-zero chart keeps an automatic maximum.
    if (values.every(v => v >= 0)) options.valAxisMinVal = 0
    else if (values.every(v => v <= 0)) options.valAxisMaxVal = 0
  }
  if (chart.type === 'horizontalBar') {
    // The first category on top, as a ranked list reads, with the value axis
    // and its labels kept at the bottom and the category names on the left.
    options.catAxisOrientation = 'maxMin'
    options.catAxisCrossesAt = 'max'
    options.valAxisLabelPos = 'nextTo'
    options.catAxisLabelPos = 'low'
  }
  if (slices) {
    options.showPercent = true
    options.showValue = false
    // Outside the slice, where the text color reads against the background;
    // a doughnut has no such position, so its labels are white on the ring.
    if (chart.type === 'pie') options.dataLabelPosition = 'outEnd'
    else options.dataLabelColor = 'FFFFFF'
  } else if (labelled) {
    options.showValue = true
    options.dataLabelFormatCode = format.label
    if (barLike && !stacked) options.dataLabelPosition = 'outEnd'
    if (chart.type === 'line') options.dataLabelPosition = 't'
  }
  const data = chart.series.map(s => ({ name: s.name, labels: chart.labels, values: s.values }))
  return { type, data, options }
}
