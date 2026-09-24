/**
 * Input normalization for chart data, shared by the tools that draw charts.
 *
 * Models describe the same chart in many shapes: numbers as strings, `{label,
 * value}` records instead of a numeric array, a missing `labels` key, a series
 * whose length disagrees with its labels.
 *
 * Everything unambiguous is repaired and reported as a warning; everything that
 * would yield a chart with nothing in it is rejected with a message naming the
 * field and the fix. Warnings travel back in the tool result so the agent can
 * correct itself on the next call.
 */
import { currencyPrefix, currencySuffix } from './xlsxCells'

/** Types whose points are {x,y} pairs rather than a value per label. */
const XY_TYPES = new Set(['scatter', 'bubble'])

/** Types that draw one colored slice per data point. */
const SLICE_TYPES = new Set(['pie', 'doughnut', 'polarArea'])

/** Types that draw each value as a share of the whole. */
const SHARE_TYPES = new Set(['pie', 'doughnut'])

/** Types that draw no category labels. */
const UNLABELLED_TYPES = new Set(['gauge'])

/** Types that carry exactly one series; extra datasets are dropped downstream. */
const SINGLE_SERIES_TYPES = new Set(['gauge', 'waterfall', 'funnel'])

export interface NormalizedPoint {
  x: number
  y: number
  r?: number
}

export interface NormalizedDataset {
  label?: string
  data: Array<number | null> | NormalizedPoint[]
  backgroundColor?: string | string[]
  borderColor?: string | string[]
  fill?: boolean
}

export interface NormalizedChartData {
  labels?: string[]
  datasets: NormalizedDataset[]
  warnings: string[]
}

export class ChartDataError extends Error {}

function fail(message: string): never {
  throw new ChartDataError(message)
}

/** The value of a numeral under each decimal convention that can spell it. */
interface Readings {
  /** "1,234.5": comma groups, dot decimals. */
  dot?: number
  /** "1.234,5": dot groups, comma decimals. */
  comma?: number
}

const SPACED_GROUPS = /^\d{1,3}(?:[ '_\u00a0\u202f]\d{3})+(?:[.,]\d+)?$/
const DOT_DECIMAL = /^(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/
const COMMA_DECIMAL = /^(?:(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?|,\d+)$/
const EXPONENT = /^\d+(?:\.\d+)?[eE][+-]?\d+$/

function readNumeral(text: string): Readings | undefined {
  if (EXPONENT.test(text)) return { dot: Number(text), comma: Number(text) }
  // Space, apostrophe and underscore only ever group digits.
  const body = SPACED_GROUPS.test(text) ? text.replace(/[ '_\u00a0\u202f]/g, '') : text
  const out: Readings = {}
  if (DOT_DECIMAL.test(body)) out.dot = Number(body.replace(/,/g, ''))
  if (COMMA_DECIMAL.test(body)) out.comma = Number(body.replace(/\./g, '').replace(',', '.'))
  return out.dot === undefined && out.comma === undefined ? undefined : out
}

/** Scale words, only directly after the number. A lowercase "m" is refused. */
const SCALES: Record<string, number> = {
  k: 3,
  K: 3,
  M: 6,
  mn: 6,
  Mn: 6,
  MN: 6,
  B: 9,
  bn: 9,
  Bn: 9,
  BN: 9,
}

type ParsedText =
  | { readings: Readings; negative: boolean; exponent: number }
  | { problem: string }
  | undefined

/**
 * Split text such as "-$1.2M", "(1,200)" or "45%" into its numeral, sign and
 * scale. Undefined when it holds no digit; a problem when it holds a number
 * that cannot be read without guessing.
 */
function parseText(value: string): ParsedText {
  let s = value.trim().replace(/\u2212/g, '-')
  if (!/\d/.test(s)) return undefined
  const quoted = `'${value.trim().slice(0, 40)}'`
  let negative = false
  const parens = /^\((.*)\)$/.exec(s)
  if (parens) {
    negative = true
    s = parens[1].trim()
  }
  const sign = () => {
    if (/^[-+]/.test(s)) {
      if (s[0] === '-') negative = !negative
      s = s.slice(1).trimStart()
    }
  }
  sign()
  const prefix = currencyPrefix(s)
  if (prefix) {
    s = s.slice(prefix[1]).trimStart()
    sign()
  }
  if (s.endsWith('%')) s = s.slice(0, -1).trimEnd()
  const suffix = currencySuffix(s)
  if (suffix) s = s.slice(0, s.length - suffix[1]).trimEnd()
  let exponent = 0
  const scaled = /^(.*\d)\s?([A-Za-z]+)$/.exec(s)
  if (scaled) {
    const word = scaled[2]
    if (word === 'm') {
      return {
        problem:
          `is ${quoted}: a lowercase m may mean million, minutes or metres. ` +
          `Send a JSON number, or write 'M' for million (e.g. '${scaled[1]}M').`,
      }
    }
    if (SCALES[word] === undefined) {
      return {
        problem:
          `is ${quoted}, which carries the unit '${word}'. Send the number alone ` +
          '(as JSON) and put the unit in the axis title or the series label.',
      }
    }
    exponent = SCALES[word]
    s = scaled[1]
  }
  const readings = readNumeral(s)
  if (!readings) {
    return { problem: `is ${quoted}, which is not a number a chart can read. Send JSON numbers.` }
  }
  return { readings, negative, exponent }
}

/** The decimal convention a set of values settles on, if any. */
type Convention = 'dot' | 'comma' | 'mixed' | undefined

function conventionOf(texts: string[]): Convention {
  let dot = false
  let comma = false
  for (const text of texts) {
    const parsed = parseText(text)
    if (!parsed || 'problem' in parsed) continue
    const { readings } = parsed
    if (readings.comma === undefined) dot = true
    else if (readings.dot === undefined) comma = true
  }
  return dot && comma ? 'mixed' : dot ? 'dot' : comma ? 'comma' : undefined
}

/**
 * Reads the numbers of one chart. Text such as "1.200" reads as 1.2 with dot
 * decimals and 1200 with comma decimals, so the convention is taken from the
 * values that can only be read one way; "1,200" alone follows the dot
 * convention, as the XLSX reader does.
 */
class NumberReader {
  private readonly convention: Convention

  constructor(texts: string[]) {
    this.convention = conventionOf(texts)
  }

  /** The number `value` holds; throws naming `where` when it cannot be read safely. */
  read(value: unknown, where: string): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value !== 'string') return undefined
    const parsed = parseText(value)
    if (!parsed) return undefined
    if ('problem' in parsed) fail(`${where} ${parsed.problem}`)
    const quoted = `'${value.trim().slice(0, 40)}'`
    const { dot, comma } = parsed.readings
    const oneReading = dot === undefined || comma === undefined || dot === comma
    const neutral = dot !== undefined && dot === comma
    if (!neutral && this.convention === 'mixed') {
      fail(
        `${where} is ${quoted}, and this chart writes decimals both as "1,234.5" and as ` +
          '"1.234,5". Send JSON numbers.'
      )
    }
    let n: number
    if (oneReading) n = (dot ?? comma)!
    else if (this.convention) n = this.convention === 'comma' ? comma! : dot!
    else if (value.includes(',')) n = dot!
    else {
      fail(
        `${where} is ${quoted}, which reads as ${dot} or ${comma} depending on the ` +
          'locale. Send JSON numbers.'
      )
    }
    const scaled = parsed.exponent ? Number((n * 10 ** parsed.exponent).toPrecision(15)) : n
    return parsed.negative ? -scaled : scaled
  }
}

/** Every string a chart's data holds, at the depths values are read from. */
function dataTexts(datasets: unknown[]): string[] {
  const texts: string[] = []
  const add = (v: unknown) => {
    if (typeof v === 'string') texts.push(v)
  }
  for (const ds of datasets) {
    const data = (ds as { data?: unknown } | null)?.data
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      add(entry)
      if (Array.isArray(entry)) entry.forEach(add)
      else if (entry && typeof entry === 'object') Object.values(entry).forEach(add)
    }
  }
  return texts
}

/**
 * The number a single value holds: a JSON number, or text such as "1,234.5",
 * "$1.2M", "(1,200)", "45%" or "987,65". Undefined for text with no number, a
 * unit ("100 MB"), a lowercase "m", or a grouping that reads two ways ("1.200"),
 * so the caller can refuse it rather than plot a guess.
 */
export function coerceNumber(value: unknown): number | undefined {
  try {
    return new NumberReader([]).read(value, 'value')
  } catch {
    return undefined
  }
}

const LABEL_KEYS = ['label', 'name', 'category', 'key']
const VALUE_KEYS = ['value', 'y', 'count', 'total', 'amount']

interface RecordPoint {
  label?: string
  value: number
  /** The label came from a numeric `x`. */
  fromX: boolean
}

/** Read a `{label, value}`-style record, whatever synonym the model used. */
function readRecordPoint(
  obj: Record<string, unknown>,
  reader: NumberReader,
  where: string
): RecordPoint | undefined {
  let value: number | undefined
  for (const key of VALUE_KEYS) {
    if (key in obj) {
      value = reader.read(obj[key], `${where}.${key}`)
      if (value !== undefined) break
    }
  }
  if (value === undefined) return undefined

  for (const key of LABEL_KEYS) {
    const raw = obj[key]
    if (typeof raw === 'string' && raw !== '') return { label: raw, value, fromX: false }
  }
  const x = obj.x
  if (typeof x === 'string' && x !== '') return { label: x, value, fromX: false }
  if (typeof x === 'number' && Number.isFinite(x)) return { label: String(x), value, fromX: true }
  return { value, fromX: false }
}

function readXYPoint(
  obj: Record<string, unknown>,
  wantsRadius: boolean,
  reader: NumberReader,
  where: string
): NormalizedPoint | undefined {
  const x = reader.read(obj.x, `${where}.x`)
  const y = reader.read(obj.y, `${where}.y`)
  if (x === undefined || y === undefined) return undefined
  if (!wantsRadius) return { x, y }
  const r = reader.read(obj.r ?? obj.radius ?? obj.size, `${where}.r`)
  return { x, y, r: r !== undefined && r > 0 ? r : 6 }
}

interface SeriesResult {
  data: Array<number | null>
  labels?: string[]
  warnings: string[]
}

/** How text values were read, for the note that reports them. */
function readingsNote(where: string, read: Array<[string, number]>): string {
  const shown = read
    .filter(([text, n]) => text.trim() !== String(n))
    .slice(0, 3)
    .map(([text, n]) => `'${text.trim().slice(0, 40)}' as ${n}`)
  return (
    `${where}: read ${read.length} value(s) written as text` +
    (shown.length > 0 ? ` (${shown.join(', ')})` : '') +
    '. Send JSON numbers.'
  )
}

/** Normalize one dataset's `data` into numbers, harvesting labels if embedded. */
function normalizeSeries(raw: unknown, where: string, reader: NumberReader): SeriesResult {
  if (!Array.isArray(raw)) {
    fail(`${where}.data must be an array; received ${describe(raw)}.`)
  }
  if (raw.length === 0) {
    fail(`${where}.data is empty — a chart needs at least one value.`)
  }

  const data: Array<number | null> = []
  const harvested: string[] = []
  const warnings: string[] = []
  const readText: Array<[string, number]> = []
  let fromRecords = 0
  let fromX = 0
  let fromPairs = 0

  raw.forEach((entry, i) => {
    const at = `${where}.data[${i}]`
    if (entry === null || entry === undefined) {
      data.push(null)
      return
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) {
        fail(`${at} is ${String(entry)} — every value must be a finite number.`)
      }
      data.push(entry)
      return
    }
    if (typeof entry === 'string') {
      const n = reader.read(entry, at)
      if (n === undefined) {
        fail(
          `${at} is ${JSON.stringify(entry)}, which holds no number. ` +
            'Send numbers, and put the text in `labels`.'
        )
      }
      readText.push([entry, n])
      data.push(n)
      return
    }
    if (Array.isArray(entry)) {
      // [label, value] or [x, y]: the first member names the position.
      const value = entry.length === 2 ? reader.read(entry[1], `${at}[1]`) : undefined
      const label = entry[0]
      if (value === undefined || (typeof label !== 'string' && typeof label !== 'number')) {
        fail(
          `${at} is an array; send a number per label, or a [label, value] pair ` +
            `(received ${JSON.stringify(entry).slice(0, 80)}).`
        )
      }
      fromPairs++
      harvested.push(String(label))
      data.push(value)
      return
    }
    if (typeof entry === 'object') {
      const point = readRecordPoint(entry as Record<string, unknown>, reader, at)
      if (!point) {
        fail(
          `${at} is an object with no numeric value ` +
            `(${JSON.stringify(entry).slice(0, 80)}). Use a plain number, or an object ` +
            'carrying `value`. For scatter/bubble use `{x, y}` / `{x, y, r}`.'
        )
      }
      if (point.fromX) fromX++
      else fromRecords++
      if (point.label !== undefined) harvested.push(point.label)
      data.push(point.value)
      return
    }
    fail(`${at} is ${describe(entry)}, which is not a value a chart can plot.`)
  })

  const labelled = harvested.length === data.length
  if (readText.length > 0) warnings.push(readingsNote(where, readText))
  if (fromRecords > 0) {
    warnings.push(
      `${where}: read ${fromRecords} value(s) out of {label, value} objects` +
        (labelled ? ' and used their labels' : '') +
        '. A plain number array is the expected shape.'
    )
  }
  if (fromX > 0) {
    warnings.push(
      `${where}: read ${fromX} point(s) out of {x, y} objects` +
        (labelled ? ' and used each x as its category label' : '') +
        '. On this chart type send labels and a plain number array; {x, y} is for scatter.'
    )
  }
  if (fromPairs > 0) {
    warnings.push(
      `${where}: read ${fromPairs} [label, value] pair(s)` +
        (labelled ? ' and used their first members as labels' : '') +
        '. A plain number array with labels is the expected shape.'
    )
  }

  if (data.every(v => v === null)) {
    fail(`${where}.data holds no usable value — every entry was null.`)
  }

  return {
    data,
    labels: labelled ? harvested : undefined,
    warnings,
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return `a ${typeof v}`
}

/** Normalize a scatter/bubble dataset, which needs coordinate pairs. */
function normalizeXYSeries(
  raw: unknown,
  where: string,
  wantsRadius: boolean,
  reader: NumberReader
): {
  data: NormalizedPoint[]
  warnings: string[]
} {
  if (!Array.isArray(raw)) fail(`${where}.data must be an array; received ${describe(raw)}.`)
  if (raw.length === 0) fail(`${where}.data is empty — a chart needs at least one point.`)

  const warnings: string[] = []
  const numeric: number[] = []
  const points: NormalizedPoint[] = []
  const shape = wantsRadius ? '`{x, y, r}` objects or [x, y, r]' : '`{x, y}` objects or [x, y]'

  for (const [i, entry] of raw.entries()) {
    const at = `${where}.data[${i}]`
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const p = readXYPoint(entry as Record<string, unknown>, wantsRadius, reader, at)
      if (!p) {
        fail(
          `${at} needs numeric \`x\` and \`y\`` +
            (wantsRadius ? ' (and \`r\` for the bubble size)' : '') +
            `; received ${JSON.stringify(entry).slice(0, 80)}.`
        )
      }
      points.push(p)
      continue
    }
    if (Array.isArray(entry) && entry.length >= 2) {
      const x = reader.read(entry[0], `${at}[0]`)
      const y = reader.read(entry[1], `${at}[1]`)
      if (x === undefined || y === undefined) {
        fail(`${at} is a pair with non-numeric members; send ${shape}.`)
      }
      const r = wantsRadius ? reader.read(entry[2], `${at}[2]`) : undefined
      points.push(wantsRadius ? { x, y, r: r && r > 0 ? r : 6 } : { x, y })
      continue
    }
    const n = reader.read(entry, at)
    if (n === undefined) {
      fail(`${at} is ${describe(entry)}; scatter and bubble need {x, y} points: ${shape}.`)
    }
    numeric.push(n)
  }

  // A plain number array is unambiguous: index becomes x, value becomes y.
  if (numeric.length > 0) {
    if (points.length > 0) {
      fail(`${where}.data mixes coordinate objects with plain numbers; use one shape.`)
    }
    warnings.push(
      `${where}: received plain numbers, so each index was used as x and each value as y. ` +
        'Send `{x, y}` points to control both axes.'
    )
    return {
      data: numeric.map((y, i) => (wantsRadius ? { x: i, y, r: 6 } : { x: i, y })),
      warnings,
    }
  }

  return { data: points, warnings }
}

export interface NormalizeOptions {
  /** The user-facing chart type, before it is mapped onto a Chart.js type. */
  chartType: string
  /**
   * Where the chart's `labels` and `datasets` sit in the caller's arguments,
   * so messages name the field the model has to fix. Defaults to `data`.
   */
  path?: string
}

/**
 * Validate and repair the `data` argument. Throws `ChartDataError` with an
 * actionable message when the input cannot produce a meaningful chart.
 */
export function normalizeChartData(raw: unknown, opts: NormalizeOptions): NormalizedChartData {
  const { chartType } = opts
  const root = opts.path ?? 'data'

  if (raw === null || raw === undefined) {
    fail(`\`${root}\` is required: { labels: string[], datasets: [{ label, data }] }.`)
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`\`${root}\` must be an object with a \`datasets\` array; received ${describe(raw)}.`)
  }

  const obj = raw as { labels?: unknown; datasets?: unknown }
  const warnings: string[] = []

  if (!Array.isArray(obj.datasets)) {
    fail(
      `\`${root}.datasets\` must be an array of series, e.g. ` +
        '[{ "label": "Revenue", "data": [120, 190] }].'
    )
  }
  if (obj.datasets.length === 0) fail(`\`${root}.datasets\` is empty — nothing to plot.`)

  let labels: string[] | undefined
  if (Array.isArray(obj.labels)) {
    labels = obj.labels.map(l => (typeof l === 'string' ? l : String(l ?? '')))
  } else if (obj.labels !== undefined && obj.labels !== null) {
    fail(`\`${root}.labels\` must be an array of strings; received ${describe(obj.labels)}.`)
  }

  const isXY = XY_TYPES.has(chartType)
  const reader = new NumberReader(dataTexts(obj.datasets))
  const datasets: NormalizedDataset[] = []
  /** Per dataset, the label each value carried, when every value carried one. */
  const labelled: Array<string[] | undefined> = []

  obj.datasets.forEach((dsRaw, index) => {
    if (dsRaw === null || typeof dsRaw !== 'object' || Array.isArray(dsRaw)) {
      fail(`${root}.datasets[${index}] must be an object with a \`data\` array.`)
    }
    const ds = dsRaw as Record<string, unknown>
    const where = `${root}.datasets[${index}]`

    if (isXY) {
      const { data, warnings: w } = normalizeXYSeries(
        ds.data,
        where,
        chartType === 'bubble',
        reader
      )
      warnings.push(...w)
      datasets.push({ ...(carryStyle(ds) as NormalizedDataset), data })
      return
    }

    const series = normalizeSeries(ds.data, where, reader)
    warnings.push(...series.warnings)
    labelled.push(series.labels)
    datasets.push({ ...(carryStyle(ds) as NormalizedDataset), data: series.data })
  })

  if (labelled.some(Boolean)) labels = placeByLabel(labels, datasets, labelled, root, warnings)

  if (SINGLE_SERIES_TYPES.has(chartType) && datasets.length > 1) {
    warnings.push(
      `"${chartType}" draws a single series; ${datasets.length - 1} extra dataset(s) were dropped.`
    )
  }

  if (!isXY) {
    // A single-series chart draws only the first dataset, so only it sets the length.
    const counted = SINGLE_SERIES_TYPES.has(chartType) ? datasets.slice(0, 1) : datasets
    const longest = Math.max(...counted.map(d => d.data.length))

    if (!labels) {
      // A slice chart with no labels is an unreadable ring of colors; a category
      // chart at least keeps its shape, so only the former is rejected.
      if (SLICE_TYPES.has(chartType)) {
        fail(
          `"${chartType}" needs \`${root}.labels\` — one label per slice — or the chart ` +
            'cannot say what each slice is.'
        )
      }
      labels = Array.from({ length: longest }, (_, i) => String(i + 1))
      if (!UNLABELLED_TYPES.has(chartType)) {
        warnings.push(`\`${root}.labels\` was missing, so positions were numbered 1..n.`)
      }
    } else if (labels.length !== longest) {
      const before = labels.length
      if (before < longest) {
        for (let i = before; i < longest; i++) labels.push(String(i + 1))
      } else {
        labels = labels.slice(0, longest)
      }
      warnings.push(
        `\`${root}.labels\` had ${before} entries for ${longest} value(s); ` +
          (before < longest
            ? `the missing labels were numbered ${before + 1}..${longest}`
            : `the labels past ${longest} were left out`) +
          '. Send one label per value.'
      )
    }

    const plotted = datasets
      .flatMap(d => d.data as Array<number | null | NormalizedPoint>)
      .filter((v): v is number => typeof v === 'number')
    if (plotted.length > 0 && plotted.every(v => v === 0)) {
      warnings.push('every value is 0, so the chart will render as an empty plot.')
    }
    if (SHARE_TYPES.has(chartType)) {
      datasets.forEach((d, i) => {
        const below = (d.data as Array<number | null>).filter(v => v !== null && v < 0).length
        if (below === 0) return
        warnings.push(
          `\`${root}.datasets[${i}]\` has ${below} value(s) below zero, which a ${chartType} ` +
            'cannot show: it draws each value as a share of the whole. Use a bar chart for them.'
        )
      })
    }
  }

  return { labels, datasets, warnings }
}

/**
 * Values that carry their own label ({label, value} records, [label, value]
 * pairs) placed at that label, not at their position: the categories are the
 * given labels, then any new ones in the order met. A series with no value for
 * a category leaves a gap there. Returns the categories.
 */
function placeByLabel(
  given: string[] | undefined,
  datasets: NormalizedDataset[],
  labelled: Array<string[] | undefined>,
  root: string,
  warnings: string[]
): string[] {
  const categories = given ? [...given] : []
  const index = new Map<string, number>()
  categories.forEach((label, i) => {
    if (!index.has(label)) index.set(label, i)
  })
  let moved = false
  let repeated = 0
  labelled.forEach((own, d) => {
    if (!own) return
    const values = datasets[d].data as Array<number | null>
    const placed: Array<number | null> = new Array(categories.length).fill(null)
    const seen = new Set<string>()
    own.forEach((label, i) => {
      if (seen.has(label)) {
        repeated++
        return
      }
      seen.add(label)
      let at = index.get(label)
      if (at === undefined) {
        at = categories.length
        categories.push(label)
        index.set(label, at)
      }
      if (at !== i) moved = true
      placed[at] = values[i]
    })
    datasets[d] = { ...datasets[d], data: placed }
  })
  // Series without labels of their own keep their positions, padded to every category.
  for (const ds of datasets) {
    const data = ds.data as Array<number | null>
    while (data.length < categories.length) data.push(null)
  }
  if (moved) {
    warnings.push(
      `${root}: values that name their label were placed at that label, not in the order sent.`
    )
  }
  if (repeated > 0) {
    warnings.push(
      `${root}: ${repeated} value(s) repeated a label already used in the same series and were left out.`
    )
  }
  return categories
}

/** Carry through the presentation fields a caller may have set explicitly. */
function carryStyle(ds: Record<string, unknown>): Partial<NormalizedDataset> {
  const out: Partial<NormalizedDataset> = {}
  if (typeof ds.label === 'string') out.label = ds.label
  if (typeof ds.backgroundColor === 'string' || Array.isArray(ds.backgroundColor)) {
    out.backgroundColor = ds.backgroundColor as string | string[]
  }
  if (typeof ds.borderColor === 'string' || Array.isArray(ds.borderColor)) {
    out.borderColor = ds.borderColor as string | string[]
  }
  if (typeof ds.fill === 'boolean') out.fill = ds.fill
  return out
}
