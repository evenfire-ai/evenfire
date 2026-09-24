/**
 * Column widths, type size, orientation and row splitting for PDF tables.
 *
 * pdfmake never makes a '*' column narrower than its longest unbreakable word,
 * so a table of long tokens would run past the page edge and lose the columns
 * beyond it. Numeric widths let pdfmake break an oversized token inside its
 * cell instead, and the type size or the page orientation gives way before a
 * table has to do that to ordinary words.
 */

/** Width of `text` at 1pt in the body face; widths scale linearly with size. */
export type UnitMeasure = (text: string, bold: boolean) => number

export interface PageBox {
  width: number
  height: number
}

export interface TableLayoutInput {
  headers: string[]
  /** Cell text as it will read, markdown markers removed. */
  rows: string[][]
  /** The `widths` argument, when the caller gave one. */
  requested?: unknown
  /** Horizontal padding pdfmake adds to each cell, both sides together. */
  cellPadding: number
  /** Width of the vertical rules the layout draws. */
  ruleWidth: number
  /** Whether the table may be moved onto landscape pages. */
  allowLandscape: boolean
  /** Argument path used in warnings, such as "tables[0]". */
  label: string
  /** The page's bottom margin, which a footer of several lines grows past the usual 60pt. */
  bottomMargin?: number
}

export interface TableLayout {
  widths: number[]
  fontSize: number
  landscape: boolean
  dontBreakRows: boolean
  keepWithHeaderRows: 0 | 1
}

/** A4 content boxes with the documents' 40pt side and 60pt top margins and the smallest bottom one. */
export const PORTRAIT: PageBox = { width: 515, height: 722 }
export const LANDSCAPE: PageBox = { width: 762, height: 475 }
export const MIN_BOTTOM_MARGIN = 60

export const BODY_FONT_SIZE = 11
const LINE_HEIGHT = 1.3
const ROW_PADDING = 4

/**
 * Longest a single token may make its column before it is left to break
 * inside the cell. Longer tokens are URLs and hashes, not words.
 */
const LONG_TOKEN = 140

/** Added to every measured width: pdfmake breaks a word that fills its column exactly. */
const SLACK = 2

/** Narrowest a flexible column is squeezed to beside fixed ones. */
const MIN_FLEX = 24

const ATTEMPTS: Array<[PageBox, number]> = [
  [PORTRAIT, 11],
  [PORTRAIT, 10],
  [PORTRAIT, 9],
  [PORTRAIT, 8],
  [LANDSCAPE, 11],
  [LANDSCAPE, 10],
  [LANDSCAPE, 9],
  [LANDSCAPE, 8],
  [LANDSCAPE, 7],
]

interface ColumnExtent {
  /** Longest word, capped at LONG_TOKEN, at 1pt. */
  min: number
  /** Longest line at 1pt. */
  max: number
}

function extents(input: TableLayoutInput, measure: UnitMeasure): ColumnExtent[] {
  const cols = input.headers.map(() => ({ min: 0, max: 0 }))
  const take = (text: string, col: number, bold: boolean): void => {
    for (const line of text.split('\n')) {
      cols[col].max = Math.max(cols[col].max, measure(line, bold))
      for (const word of line.split(/\s+/)) {
        if (word) cols[col].min = Math.max(cols[col].min, measure(word, bold))
      }
    }
  }
  input.headers.forEach((h, c) => take(h, c, true))
  for (const row of input.rows) row.forEach((cell, c) => c < cols.length && take(cell, c, false))
  return cols
}

type Spec =
  | { kind: 'fixed'; points: number }
  | { kind: 'share'; percent: number }
  | { kind: 'star' }
  | { kind: 'auto' }

function parseSpecs(input: TableLayoutInput, warnings: string[]): Spec[] | undefined {
  const req = input.requested
  if (req === undefined || req === null) return undefined
  if (!Array.isArray(req) || req.length !== input.headers.length) {
    warnings.push(
      `${input.label}.widths has ${Array.isArray(req) ? req.length : 0} entries for ` +
        `${input.headers.length} columns, so it was ignored; give one width per header.`
    )
    return undefined
  }
  return req.map((raw, i): Spec => {
    const text = typeof raw === 'string' ? raw.trim() : raw
    if (text === '*') return { kind: 'star' }
    if (text === 'auto') return { kind: 'auto' }
    const percent = typeof text === 'string' ? /^(\d+(?:\.\d+)?)%$/.exec(text) : null
    if (percent) return { kind: 'share', percent: Number(percent[1]) }
    const points = typeof text === 'number' ? text : typeof text === 'string' ? Number(text) : NaN
    if (Number.isFinite(points) && points > 0) return { kind: 'fixed', points }
    warnings.push(
      `${input.label}.widths[${i}] (${JSON.stringify(raw)}) is not a number of points, ` +
        `a percentage, '*' or 'auto', so that column shares the remaining space.`
    )
    return { kind: 'star' }
  })
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

/**
 * Widths between each column's minimum and its full content: the full content
 * when it fits, otherwise the minimum plus a share of what is left.
 */
function squeeze(min: number[], max: number[], room: number): number[] {
  if (sum(max) <= room) return max
  if (sum(min) <= room) {
    const spread = sum(max) - sum(min)
    return min.map((m, i) => m + ((room - sum(min)) * (max[i] - m)) / spread)
  }
  const total = sum(min)
  return min.map(m => (total > 0 ? (room * m) / total : room / min.length))
}

/** Narrowest a column can be at `size` without breaking an ordinary word. */
function minWidths(cols: ColumnExtent[], size: number): number[] {
  return cols.map(c => Math.min(c.min * size, LONG_TOKEN) + SLACK)
}

interface RequestedFit {
  widths: number[]
  /** Set when the fixed widths had to be scaled down: what they added up to, and the room left. */
  scaled?: { from: number; to: number }
}

const isFlexible = (spec: Spec): boolean => spec.kind === 'star' || spec.kind === 'auto'

/**
 * Widths from the caller's specs. Fixed widths give way before a '*' or
 * 'auto' column is made narrower than its longest word.
 */
function requestedWidths(
  specs: Spec[],
  cols: ColumnExtent[],
  size: number,
  room: number
): RequestedFit {
  const floor = minWidths(cols, size).map(m => Math.max(m, MIN_FLEX))
  const full = cols.map((c, i) => Math.max(c.max * size + SLACK, floor[i]))
  let fixed = specs.map(s =>
    s.kind === 'fixed' ? s.points : s.kind === 'share' ? (room * s.percent) / 100 : 0
  )
  const fixedSum = sum(fixed)
  const fixedCount = specs.filter(s => !isFlexible(s)).length
  const flexibleFloor = sum(specs.map((s, i) => (isFlexible(s) ? floor[i] : 0)))
  const fixedRoom = Math.max(room - flexibleFloor, Math.min(fixedSum, fixedCount * MIN_FLEX))
  let scaled: RequestedFit['scaled']
  if (fixedSum > fixedRoom) {
    fixed = fixed.map(w => (w * fixedRoom) / fixedSum)
    scaled = { from: fixedSum, to: fixedRoom }
  }
  const rest = Math.max(0, room - sum(fixed))
  const autos = specs.flatMap((s, i) => (s.kind === 'auto' ? [i] : []))
  const stars = specs.flatMap((s, i) => (s.kind === 'star' ? [i] : []))
  const starFloor = sum(stars.map(i => floor[i]))
  const autoWidths = squeeze(
    autos.map(i => floor[i]),
    autos.map(i => full[i]),
    Math.max(0, rest - starFloor)
  )
  const widths = [...fixed]
  autos.forEach((col, k) => (widths[col] = autoWidths[k]))
  // Stars share what is left evenly, as pdfmake does, unless that is narrower than a word.
  const starRoom = Math.max(0, rest - sum(autoWidths))
  const even = starRoom / Math.max(1, stars.length)
  stars.forEach(col => {
    if (stars.every(i => floor[i] <= even)) widths[col] = even
    else if (starFloor <= starRoom) widths[col] = floor[col] + (starRoom - starFloor) / stars.length
    else widths[col] = (starRoom * floor[col]) / starFloor
  })
  return { widths, scaled }
}

/** Widths that fill `room`, giving each column what its content asks for first. */
function contentWidths(cols: ColumnExtent[], size: number, room: number): number[] {
  const min = minWidths(cols, size)
  const max = cols.map((c, i) => Math.max(c.max * size + SLACK, min[i]))
  if (sum(max) <= room) {
    // Spare room goes to columns in proportion to their content; empty ones share it evenly.
    const weights = max.map(m => m || 1)
    return max.map((m, i) => m + ((room - sum(max)) * weights[i]) / sum(weights))
  }
  return squeeze(min, max, room)
}

function rowHeight(
  cells: string[],
  widths: number[],
  size: number,
  bold: boolean,
  measure: UnitMeasure
): number {
  let lines = 1
  cells.forEach((cell, c) => {
    const width = Math.max(1, widths[c] ?? 1)
    let count = 0
    for (const line of cell.split('\n'))
      count += Math.max(1, Math.ceil((measure(line, bold) * size) / width))
    lines = Math.max(lines, count)
  })
  return lines * size * LINE_HEIGHT + ROW_PADDING
}

/** Header names for a warning: the first three, then how many more. */
function columnNames(headers: string[], columns: number[]): string {
  const names = columns.map(c => `'${headers[c]?.trim() || `column ${c + 1}`}'`)
  if (names.length === 1) return names[0]
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more column(s)`
}

/** Lay out one table, reporting in `warnings` anything done to the caller's request. */
export function layoutPdfTable(
  input: TableLayoutInput,
  measure: UnitMeasure,
  warnings: string[]
): TableLayout {
  const n = Math.max(1, input.headers.length)
  const roomOn = (page: PageBox): number =>
    page.width - n * input.cellPadding - (n + 1) * input.ruleWidth
  const cols = extents(input, measure)
  const specs = parseSpecs(input, warnings)
  const plan = (page: PageBox, size: number): RequestedFit =>
    specs
      ? requestedWidths(specs, cols, size, roomOn(page))
      : { widths: contentWidths(cols, size, roomOn(page)) }
  const broken = (widths: number[], size: number): number[] =>
    minWidths(cols, size).flatMap((m, i) => (widths[i] + 0.01 < m ? [i] : []))

  const attempts = ATTEMPTS.filter(([p]) => p === PORTRAIT || input.allowLandscape)
  let chosen = attempts.find(([p, s]) => broken(plan(p, s).widths, s).length === 0)
  // Nothing holds every word: the caller's widths are kept at full size, and
  // otherwise the smallest type on the widest page breaks the fewest.
  chosen ??= specs ? attempts[0] : attempts[attempts.length - 1]
  const [page, size] = chosen
  const fit = plan(page, size)
  const widths = fit.widths

  if (fit.scaled) {
    warnings.push(
      `${input.label}.widths add up to ${Math.round(fit.scaled.from)} pt, more than the ` +
        `${Math.round(fit.scaled.to)} pt the page leaves for them, so they were scaled down to fit.`
    )
  }
  if (page === LANDSCAPE) {
    warnings.push(
      `${input.label} has more columns than a portrait page can show legibly, so it was set on ` +
        'landscape pages.'
    )
  }
  const narrow = broken(widths, size)
  if (narrow.length > 0) {
    const many = narrow.length > 1
    warnings.push(
      `${input.label}: words in ${columnNames(input.headers, narrow)} are wider than ` +
        `${many ? 'those columns' : 'that column'}, so they break across lines; ` +
        (specs
          ? `widen ${many ? 'them' : 'it'} in ${input.label}.widths, or split the table.`
          : 'split the table or leave out columns.')
    )
  }

  // pdfmake drops a row taller than a page when rows may not break, and drops
  // the header with the first row when keeping them together cannot fit.
  const usable =
    page.height - Math.max(0, (input.bottomMargin ?? MIN_BOTTOM_MARGIN) - MIN_BOTTOM_MARGIN)
  const headerHeight = rowHeight(input.headers, widths, size, true, measure)
  const heights = input.rows.map(row => rowHeight(row, widths, size, false, measure))
  return {
    widths,
    fontSize: size,
    landscape: page === LANDSCAPE,
    dontBreakRows: heights.every(h => h + headerHeight <= usable * 0.8),
    keepWithHeaderRows: headerHeight + (heights[0] ?? 0) <= usable * 0.5 ? 1 : 0,
  }
}
