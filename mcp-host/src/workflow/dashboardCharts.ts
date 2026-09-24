/**
 * Chart preparation for `clerum__generate_dashboard`: each chart is validated
 * and translated to a configuration Chart.js registers before the page is
 * written, so an unusable chart becomes a note in its own card and a warning
 * for the agent instead of an error that stops the page script.
 */
import { ChartDataError, coerceNumber, normalizeChartData } from './chartData'
import type { NormalizedDataset, NormalizedPoint } from './chartData'
import { escapeHtml } from './dashboardHtml'

/** Every chart type the dashboard draws, the same set clerum__generate_chart accepts. */
export const DASHBOARD_CHART_TYPES = [
  'line',
  'bar',
  'horizontalBar',
  'pie',
  'doughnut',
  'area',
  'radar',
  'polarArea',
  'scatter',
  'bubble',
  'stackedBar',
  'stackedArea',
  'mixedBarLine',
  'gauge',
  'waterfall',
  'funnel',
] as const

const KNOWN_TYPES = new Set<string>(DASHBOARD_CHART_TYPES)
const SLICE_TYPES = new Set(['pie', 'doughnut', 'polarArea'])
const XY_TYPES = new Set(['scatter', 'bubble'])
const TRANSLUCENT_TYPES = new Set(['line', 'area', 'stackedArea', 'radar', 'scatter', 'bubble'])

/**
 * What the page script needs to draw one chart. Colors are left as tokens
 * ("$chart-0", "$chart-1@0.2", "$success") that the script resolves against
 * the page's CSS variables, so the series follow light, dark and print modes.
 */
export interface ClientChart {
  id: string
  type: string
  labels: string[]
  datasets: Array<Record<string, unknown>>
  axes: 'cartesian' | 'radial' | 'none'
  indexAxis: 'x' | 'y'
  stacked: boolean
  legend: boolean
  xAxisLabel?: string
  yAxisLabel?: string
  gauge?: { value: string; max: string }
  /** Radius in pixels of a scatter or bubble chart's largest mark, hovered. */
  markRadius?: number
}

/** The number of series colors each theme defines (DashboardThemeColors.chart). */
const PALETTE_SIZE = 7

/**
 * The palette token for series or slice `i`. Past the palette the colors
 * repeat fainter each round, with a dash for lines, so the first 21 series look
 * different; later ones repeat.
 */
function paletteColor(i: number, alpha = 1): { color: string; dash?: number[] } {
  const round = Math.floor(i / PALETTE_SIZE)
  const shade = alpha * Math.max(0.35, 1 - 0.3 * round)
  const base = `$chart-${i % PALETTE_SIZE}`
  return {
    color: shade === 1 ? base : `${base}@${Number(shade.toFixed(2))}`,
    dash:
      round === 0
        ? undefined
        : [
            [6, 3],
            [2, 3],
            [8, 3, 2, 3],
          ][(round - 1) % 3],
  }
}

/** The values of a chart as a table, shown when Chart.js is not inlined. */
interface ValueTable {
  labels: string[]
  series: Array<{ label: string; values: string[] }>
}

interface Translated {
  chart: Omit<ClientChart, 'id'>
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function seriesColors(ds: NormalizedDataset, index: number, type: string): Record<string, unknown> {
  if (SLICE_TYPES.has(type)) {
    return {
      backgroundColor: ds.backgroundColor ?? ds.data.map((_, j) => paletteColor(j).color),
      borderColor: ds.borderColor ?? '$surface',
    }
  }
  const { color, dash } = paletteColor(index)
  const border = ds.borderColor ?? color
  const dashed = dash && ds.borderColor === undefined ? { borderDash: dash } : {}
  if (!TRANSLUCENT_TYPES.has(type)) {
    return { borderColor: border, backgroundColor: ds.backgroundColor ?? color, ...dashed }
  }
  // Points take the fill color by default, which here is the faint area tint.
  return {
    borderColor: border,
    backgroundColor: ds.backgroundColor ?? paletteColor(index, 0.2).color,
    pointBackgroundColor: border,
    ...dashed,
  }
}

/** CSS color keywords, which canvas and Chart.js both read. */
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen transparent'
  ).split(' ')
)

/** Longer than any CSS color a chart needs, e.g. "hsl(210deg 50% 40% / 0.8)". */
const MAX_COLOR_LENGTH = 64

function isCssColor(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > MAX_COLOR_LENGTH) return false
  const v = value.trim().toLowerCase()
  return (
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v) ||
    /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?:[\d\s.,%/+-]|deg|g?rad|turn|none)*\)$/.test(v) ||
    NAMED_COLORS.has(v)
  )
}

/** Color warnings written out per chart; the rest are counted in one line. */
const COLOR_WARNINGS_SHOWN = 3

/**
 * `ds` without the colors that are not CSS colors, which canvas would paint
 * black: a single color is dropped for the palette's, a per-point one gets the
 * palette color of its point (slices) or of its series. Each rejected value's
 * path and text go to `bad`.
 */
function checkColors(
  ds: NormalizedDataset,
  index: number,
  type: string,
  where: string,
  bad: Array<{ at: string; value: unknown }>
): NormalizedDataset {
  const out = { ...ds }
  for (const key of ['backgroundColor', 'borderColor'] as const) {
    const value = ds[key]
    if (value === undefined) continue
    const at = `${where}.datasets[${index}].${key}`
    if (!Array.isArray(value)) {
      if (!isCssColor(value)) {
        bad.push({ at, value })
        delete out[key]
      }
      continue
    }
    out[key] = value.map((v, j) => {
      if (isCssColor(v)) return v
      bad.push({ at: `${at}[${j}]`, value: v })
      return paletteColor(SLICE_TYPES.has(type) ? j : index).color
    })
  }
  return out
}

function colorWarnings(bad: Array<{ at: string; value: unknown }>, where: string): string[] {
  const shown = bad.slice(0, COLOR_WARNINGS_SHOWN).map(({ at, value }) => {
    const text = JSON.stringify(
      typeof value === 'string' && value.length > 40 ? `${value.slice(0, 40)}…` : value
    )
    return (
      `${at} ${text} is not a CSS color, so the palette color was used. ` +
      'Pass hex such as "#2563eb", rgb(), hsl() or a color name.'
    )
  })
  const more = bad.length - shown.length
  if (more > 0) {
    shown.push(`${where}: ${more} more colors are not CSS colors and were replaced the same way.`)
  }
  return shown
}

function readout(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))
}

function firstSeriesValues(ds: NormalizedDataset | undefined): number[] {
  return ((ds?.data ?? []) as Array<number | null>).map(v => (typeof v === 'number' ? v : 0))
}

/** Map a validated user-facing chart onto the Chart.js configuration that draws it. */
function translate(
  type: string,
  spec: Record<string, unknown>,
  labels: string[],
  datasets: NormalizedDataset[]
): Translated {
  const warnings: string[] = []
  const chart: Omit<ClientChart, 'id'> = {
    type,
    labels,
    datasets: [],
    axes: SLICE_TYPES.has(type) ? 'none' : type === 'radar' ? 'radial' : 'cartesian',
    indexAxis: 'x',
    stacked: false,
    legend: SLICE_TYPES.has(type) || datasets.some(ds => Boolean(ds.label)),
    xAxisLabel: optionalText(spec.xAxisLabel),
    yAxisLabel: optionalText(spec.yAxisLabel),
  }
  if (type === 'polarArea') chart.axes = 'radial'

  const styled = (ds: NormalizedDataset, i: number, as = type): Record<string, unknown> => ({
    ...ds,
    label: ds.label ?? '',
    ...seriesColors(ds, i, as),
  })

  switch (type) {
    case 'horizontalBar':
      chart.type = 'bar'
      chart.indexAxis = 'y'
      chart.datasets = datasets.map((ds, i) => styled(ds, i))
      return { chart, warnings }
    case 'area':
      chart.type = 'line'
      chart.datasets = datasets.map((ds, i) => ({ ...styled(ds, i), fill: ds.fill ?? true }))
      return { chart, warnings }
    case 'stackedBar':
      chart.type = 'bar'
      chart.stacked = true
      chart.datasets = datasets.map((ds, i) => styled(ds, i))
      return { chart, warnings }
    case 'stackedArea':
      chart.type = 'line'
      chart.stacked = true
      chart.datasets = datasets.map((ds, i) => ({
        ...styled(ds, i),
        fill: ds.fill ?? (i === 0 ? 'origin' : '-1'),
      }))
      return { chart, warnings }
    case 'mixedBarLine':
      chart.type = 'bar'
      // A lower order draws later, which keeps the lines above the bars.
      chart.datasets = datasets.map((ds, i) =>
        i === 0
          ? { ...styled(ds, i, 'bar'), order: 1 }
          : { ...styled(ds, i, 'line'), type: 'line', fill: false, order: 0 }
      )
      return { chart, warnings }
    case 'funnel': {
      chart.type = 'bar'
      chart.indexAxis = 'y'
      chart.legend = false
      const pairs = firstSeriesValues(datasets[0]).map((v, i) => ({ v, l: labels[i] ?? '' }))
      pairs.sort((a, b) => b.v - a.v)
      chart.labels = pairs.map(p => p.l)
      chart.datasets = [
        { ...styled({ ...datasets[0], data: pairs.map(p => p.v) }, 0, 'bar'), label: '' },
      ]
      return { chart, warnings }
    }
    case 'waterfall': {
      chart.type = 'bar'
      chart.legend = false
      const deltas = firstSeriesValues(datasets[0])
      const floats: number[][] = []
      const colors: string[] = []
      let total = 0
      for (const delta of deltas) {
        floats.push([total, total + delta])
        colors.push(delta >= 0 ? '$success' : '$danger')
        total += delta
      }
      floats.push([0, total])
      colors.push('$chart-0')
      chart.labels = [...labels, 'Total']
      chart.datasets = [
        {
          label: datasets[0]?.label ?? '',
          data: floats,
          backgroundColor: colors,
          borderColor: colors,
        },
      ]
      return { chart, warnings }
    }
    case 'gauge': {
      chart.type = 'doughnut'
      chart.axes = 'none'
      chart.legend = false
      const requestedMax = coerceNumber(spec.gaugeMax)
      const max = requestedMax !== undefined && requestedMax > 0 ? requestedMax : 100
      const values = firstSeriesValues(datasets[0])
      const raw = values[0] ?? 0
      if (values.length > 1) {
        warnings.push(
          `the gauge shows one value, so ${values.length - 1} more in datasets[0].data ` +
            `${values.length > 2 ? 'were' : 'was'} left out. ` +
            'Send one value, or use a bar chart to compare several.'
        )
      }
      const value = Math.min(Math.max(raw, 0), max)
      if (value !== raw) {
        warnings.push(
          `the gauge value ${raw} is outside 0..${max}, so the dial is drawn ` +
            `${value === 0 ? 'empty' : 'full'} and the readout shows ${readout(raw)}.`
        )
      }
      chart.labels = labels.length > 0 ? [labels[0], ''] : ['', '']
      chart.datasets = [
        {
          label: datasets[0]?.label ?? '',
          data: [value, max - value],
          backgroundColor: ['$chart-0', '$border'],
          borderColor: ['$chart-0', '$border'],
        },
      ]
      chart.gauge = { value: readout(raw), max: readout(max) }
      return { chart, warnings }
    }
    default:
      chart.datasets = datasets.map((ds, i) => styled(ds, i))
      if (XY_TYPES.has(type)) chart.markRadius = largestMark(type, datasets)
      return { chart, warnings }
  }
}

// Chart.js draws a point 3 px across by default and grows a hovered mark by 4
// px, with a border of 1 px.
const POINT_RADIUS = 3
const HOVER_GROWTH = 4
const MARK_BORDER = 1

/** Radius in pixels of the largest mark a scatter or bubble chart draws when hovered. */
function largestMark(type: string, datasets: NormalizedDataset[]): number {
  let largest = POINT_RADIUS
  if (type === 'bubble') {
    for (const ds of datasets) {
      for (const point of ds.data as NormalizedPoint[]) {
        if (point.r !== undefined && point.r > largest) largest = point.r
      }
    }
  }
  return largest + HOVER_GROWTH + MARK_BORDER
}

function valueTable(type: string, labels: string[], datasets: NormalizedDataset[]): ValueTable {
  if (XY_TYPES.has(type)) {
    const points = Math.max(...datasets.map(ds => ds.data.length))
    return {
      labels: Array.from({ length: points }, (_, i) => String(i + 1)),
      series: datasets.map(ds => ({
        label: ds.label ?? '',
        values: (ds.data as NormalizedPoint[]).map(p =>
          p.r === undefined ? `(${p.x}, ${p.y})` : `(${p.x}, ${p.y}, ${p.r})`
        ),
      })),
    }
  }
  return {
    labels,
    series: datasets.map(ds => ({
      label: ds.label ?? '',
      values: (ds.data as Array<number | null>).map(v => (v === null ? '' : String(v))),
    })),
  }
}

export interface PreparedChart {
  title?: string
  /** Text under the chart: a gauge's label. */
  caption?: string
  chart?: Omit<ClientChart, 'id'>
  table?: ValueTable
  error?: string
  warnings: string[]
}

/** Validate one chart spec found at `where` in the arguments. */
export function prepareDashboardChart(raw: unknown, where: string): PreparedChart {
  if (!isRecord(raw)) {
    return {
      warnings: [],
      error: `${where} must be a chart object {type, labels, datasets}; received ${
        raw === undefined
          ? 'nothing'
          : raw === null
            ? 'null'
            : Array.isArray(raw)
              ? 'an array'
              : `a ${typeof raw}`
      }.`,
    }
  }
  const title = optionalText(raw.title)
  const type = typeof raw.type === 'string' ? raw.type : undefined
  if (!type || !KNOWN_TYPES.has(type)) {
    const got = type ? `"${type}" is not a chart type` : 'is missing'
    return {
      title,
      warnings: [],
      error: `${where}.type ${got}; use one of: ${DASHBOARD_CHART_TYPES.join(', ')}.`,
    }
  }
  try {
    const clean = normalizeChartData(
      { labels: raw.labels, datasets: raw.datasets },
      { chartType: type, path: where }
    )
    const labels = clean.labels ?? []
    // A gauge draws one value, so it has no categories to label.
    const unlabeledGauge = type === 'gauge' && raw.labels === undefined
    const warnings = clean.warnings
      .filter(w => !(unlabeledGauge && w.includes(`\`${where}.labels\``)))
      .map(w => (w.includes(where) ? w : `${where}: ${w}`))
    const badColors: Array<{ at: string; value: unknown }> = []
    const datasets = clean.datasets.map((ds, i) => checkColors(ds, i, type, where, badColors))
    warnings.push(...colorWarnings(badColors, where))
    const slices = SLICE_TYPES.has(type)
    const colored = slices
      ? datasets.reduce((n, ds) => (ds.backgroundColor ? n : Math.max(n, ds.data.length)), 0)
      : datasets.length
    const paletted = slices || datasets.slice(PALETTE_SIZE).some(ds => !ds.borderColor)
    if (colored > PALETTE_SIZE && paletted && !['gauge', 'waterfall', 'funnel'].includes(type)) {
      const what = slices ? 'slices' : 'series'
      const past =
        colored === PALETTE_SIZE + 1
          ? `${what} ${colored} repeats one in a fainter shade`
          : `${what} ${PALETTE_SIZE + 1}-${colored} repeat them in fainter shades`
      warnings.push(
        `${where} has ${colored} ${what} and the palette ${PALETTE_SIZE} colors, so ${past}. ` +
          `Fewer ${what} read better.`
      )
    }
    const translated = translate(type, raw, labels, datasets)
    warnings.push(...translated.warnings.map(w => `${where}: ${w}`))
    return {
      title,
      caption:
        type === 'gauge' && Array.isArray(raw.labels) ? optionalText(raw.labels[0]) : undefined,
      chart: translated.chart,
      table: valueTable(type, labels, datasets),
      warnings,
    }
  } catch (err) {
    if (!(err instanceof ChartDataError)) throw err
    return { title, warnings: [], error: err.message }
  }
}

function valueTableHtml(table: ValueTable): string {
  const head = `<tr><th></th>${table.series.map(s => `<th>${escapeHtml(s.label)}</th>`).join('')}</tr>`
  const rows = table.labels
    .map(
      (label, i) =>
        `<tr><td>${escapeHtml(label)}</td>${table.series
          .map(s => `<td>${escapeHtml(s.values[i] ?? '')}</td>`)
          .join('')}</tr>`
    )
    .join('')
  return `<div class="chart-card__table"><table class="data-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`
}

/**
 * The charts of one dashboard. Each `card` call validates a spec and returns
 * its card; the specs Chart.js has to draw accumulate in `specs`.
 */
export class DashboardCharts {
  readonly specs: ClientChart[] = []
  drawn = 0

  /**
   * @param drawInBrowser false when Chart.js is not inlined: cards then carry a table of their values.
   * @param notes where repairs (`warnings`) and charts that could not be drawn (`failures`) are reported.
   */
  constructor(
    private readonly drawInBrowser: boolean,
    private readonly notes: { warnings: string[]; failures: string[] }
  ) {}

  card(raw: unknown, where: string, opts: { title?: string; tall?: boolean } = {}): string {
    const prepared = prepareDashboardChart(raw, where)
    this.notes.warnings.push(...prepared.warnings)
    const title = opts.title ?? prepared.title
    const heading = title ? `<h3 class="chart-card__title">${escapeHtml(title)}</h3>` : ''
    const wide = opts.tall ? ' chart-card--wide' : ''
    let body: string
    if (!prepared.chart) {
      this.notes.failures.push(prepared.error!)
      body = `<p class="chart-card__note">${escapeHtml(`This chart could not be drawn: ${prepared.error}`)}</p>`
    } else if (!this.drawInBrowser) {
      this.drawn++
      body = valueTableHtml(prepared.table!)
    } else {
      this.drawn++
      const id = `chart-${this.specs.length}`
      this.specs.push({ id, ...prepared.chart })
      const tall = opts.tall ? ' chart-card__container--tall' : ''
      const caption = prepared.caption
        ? `<p class="chart-card__caption">${escapeHtml(prepared.caption)}</p>`
        : ''
      body = `<div class="chart-card__container${tall}"><canvas id="${id}" role="img" aria-label="${escapeHtml(title ?? prepared.caption ?? '')}"></canvas></div>${caption}`
    }
    return `<div class="chart-card${wide}">${heading}${body}</div>`
  }
}
