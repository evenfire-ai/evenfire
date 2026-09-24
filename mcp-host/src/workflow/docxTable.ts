import { type SKRSContext2D, createCanvas } from '@napi-rs/canvas'
import {
  BorderStyle,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  WidthType,
} from 'docx'
import { inlineRuns } from './docxInline'
import { docxDirection, isRtlText } from './docxScript'
import {
  DOCX_CONTENT_WIDTH_TWIPS,
  DOCX_LANDSCAPE_CONTENT_WIDTH_TWIPS,
  type DocxPalette,
  docxHex,
} from './docxStyle'
import { CHART_FONT_FAMILY, ensureFontsReady } from './fonts'
import { inlineSpans } from './inlineMarkup'
import { headerText } from './tableRows'

export type DocxTableLayout = 'striped' | 'minimal' | 'grid'

function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return ''
  return typeof cell === 'object' ? JSON.stringify(cell) : String(cell)
}

/** Page and type size tried in turn; the first that holds every word wins. */
const ATTEMPTS: Array<{ landscape: boolean; size: number }> = [
  { landscape: false, size: 11 },
  { landscape: false, size: 10 },
  { landscape: false, size: 9 },
  { landscape: false, size: 8 },
  { landscape: true, size: 11 },
  { landscape: true, size: 10 },
  { landscape: true, size: 9 },
  { landscape: true, size: 8 },
  { landscape: true, size: 7 },
]

/** Beyond this many columns Word's autofit lets the table run past the margin. */
const AUTOFIT_MAX_COLUMNS = 8

/** Twips a word may claim before it is left to break: longer ones are URLs and hashes. */
const LONG_TOKEN_TWIPS = 2800

/** Added to every column: Word wraps a word that fills its cell exactly. */
const SLACK_TWIPS = 40

/**
 * CJK characters, counted one em wide as every CJK face sets them, and the
 * characters Roboto has no glyph for, counted at a generous 0.6 em, so neither
 * depends on the faces the runtime image happens to ship.
 */
const WIDE_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6]/u
const MEASURED_CHAR = /[\u0000-\u052F\u1E00-\u206F\u20A0-\u20BF]/u

let context: SKRSContext2D | undefined
const advances = [new Map<string, number>(), new Map<string, number>()]

/**
 * Advance of one character at 1pt in ems. Characters in MEASURED_CHAR are
 * measured once each in Roboto, which runs about 7-10% wider than Calibri
 * (Medium against Bold included), so a sum of advances errs toward fitting.
 */
function advanceEm(ch: string, bold: boolean): number {
  if (!MEASURED_CHAR.test(ch)) return WIDE_CHAR.test(ch) ? 1 : 0.6
  const cache = advances[bold ? 1 : 0]
  const known = cache.get(ch)
  if (known !== undefined) return known
  if (!context) {
    ensureFontsReady()
    context = createCanvas(4, 4).getContext('2d')
  }
  context.font = `100px "${bold ? `${CHART_FONT_FAMILY} Bold` : CHART_FONT_FAMILY}"`
  const em = context.measureText(ch).width / 100
  cache.set(ch, em)
  return em
}

/** The text a cell prints, markdown markers and link targets removed, for measuring. */
function printedText(markdown: string): string {
  return inlineSpans(markdown)
    .map(span => span.text)
    .join('')
}

interface ColumnExtent {
  /** Longest word at 1pt, in twips. */
  word: number
  /** Longest line at 1pt, in twips. */
  line: number
}

/** Widen `extent` to hold the longest word and line of `cell`, in one pass over it. */
function takeCell(extent: ColumnExtent, cell: string, bold: boolean): void {
  let word = 0
  let line = 0
  for (const ch of printedText(cell)) {
    if (ch === '\n') {
      extent.line = Math.max(extent.line, line * 20)
      line = 0
      word = 0
      continue
    }
    const em = advanceEm(ch, bold)
    line += em
    word = /\s/.test(ch) ? 0 : word + em
    extent.word = Math.max(extent.word, word * 20)
  }
  extent.line = Math.max(extent.line, line * 20)
}

function extents(head: string[], body: string[][]): ColumnExtent[] {
  return head.map((h, col) => {
    const extent = { word: 0, line: 0 }
    takeCell(extent, h, true)
    for (const row of body) takeCell(extent, row[col], false)
    return extent
  })
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

interface DocxTableFit {
  widths: number[]
  /** Points. */
  size: number
  /** Left and right cell margin, in twips. */
  side: number
  landscape: boolean
  fixed: boolean
  /** Columns whose longest word is still wider than the column. */
  broken: number[]
}

/**
 * Column widths in twips, type size and page for one table: the first attempt
 * whose columns hold their longest words. Each column then gets its full
 * content when that fits, otherwise its longest word and a share of the rest,
 * and spare room goes to columns by their content.
 */
function fitTable(cols: ColumnExtent[]): DocxTableFit {
  const n = cols.length
  const plan = ({ landscape, size }: { landscape: boolean; size: number }) => {
    const fixed = landscape || size < 11 || n > AUTOFIT_MAX_COLUMNS
    const side = fixed ? 60 : 120
    const pad = 2 * side + SLACK_TWIPS
    const room = landscape ? DOCX_LANDSCAPE_CONTENT_WIDTH_TWIPS : DOCX_CONTENT_WIDTH_TWIPS
    const min = cols.map(c => Math.min(c.word * size, LONG_TOKEN_TWIPS) + pad)
    const max = cols.map((c, i) => Math.max(c.line * size + pad, min[i]))
    let widths: number[]
    if (sum(max) <= room) {
      widths = max.map(m => m + ((room - sum(max)) * m) / sum(max))
    } else if (sum(min) <= room) {
      const spread = sum(max) - sum(min)
      widths = min.map((m, i) => m + ((room - sum(min)) * (max[i] - m)) / spread)
    } else {
      widths = min.map(m => (room * m) / sum(min))
    }
    const whole = widths.map(Math.floor)
    const broken = whole.flatMap((w, i) => (w + 1 < min[i] ? [i] : []))
    return { widths: whole, size, side, landscape, fixed, broken }
  }
  for (const attempt of ATTEMPTS) {
    const fit = plan(attempt)
    if (fit.broken.length === 0) return fit
  }
  return plan(ATTEMPTS[ATTEMPTS.length - 1])
}

/** Header names for a warning: the first three, then how many more. */
function columnNames(headers: string[], columns: number[]): string {
  const names = columns.map(c => `'${headers[c]?.trim() || `column ${c + 1}`}'`)
  if (names.length === 1) return names[0]
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more column(s)`
}

const LANDSCAPE_TABLES = new WeakSet<Table>()

/**
 * The body in sections by page orientation. A table set on a landscape page
 * takes the paragraph after it, the spacer every table is followed by, into
 * its section.
 */
export function docxSections<T extends object>(
  children: T[]
): Array<{ landscape: boolean; children: T[] }> {
  const out: Array<{ landscape: boolean; children: T[] }> = []
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    const landscape = child instanceof Table && LANDSCAPE_TABLES.has(child)
    const run = landscape && i + 1 < children.length ? [child, children[++i]] : [child]
    const last = out[out.length - 1]
    if (last && last.landscape === landscape) last.children.push(...run)
    else out.push({ landscape, children: run })
  }
  return out
}

function padRow(row: string[], width: number): string[] {
  if (row.length >= width) return row.slice(0, width)
  return [...row, ...Array<string>(width - row.length).fill('')]
}

function borders(layout: DocxTableLayout, palette: DocxPalette) {
  const none = { style: BorderStyle.NONE, color: 'auto', size: 0 }
  const light = { style: BorderStyle.SINGLE, color: docxHex(palette.border), size: 4 }
  if (layout === 'minimal') {
    return {
      top: light,
      bottom: light,
      left: none,
      right: none,
      insideHorizontal: none,
      insideVertical: none,
    }
  }
  if (layout === 'grid') {
    return {
      top: light,
      bottom: light,
      left: light,
      right: light,
      insideHorizontal: light,
      insideVertical: light,
    }
  }
  const strong = { style: BorderStyle.SINGLE, color: docxHex(palette.primaryDark), size: 6 }
  return {
    top: strong,
    bottom: strong,
    left: none,
    right: none,
    insideHorizontal: { style: BorderStyle.SINGLE, color: docxHex(palette.border), size: 2 },
    insideVertical: none,
  }
}

/**
 * A table with a header row. Headers may be numbers (a year is a common
 * heading); cells carry inline markdown, and <br> breaks a line inside one.
 * Ragged rows are padded or cut to the header count. A table too wide for the
 * portrait page is set in smaller type or on a landscape page, which
 * docxSections puts in a section of its own; `label` names it in warnings.
 */
export function buildDocxTable(
  headers: unknown[],
  rows: unknown[][],
  palette: DocxPalette,
  layout: DocxTableLayout,
  warnings: string[],
  label: string
): Table {
  const head = headers.map(headerText)
  const long = rows.filter(row => row.length > head.length).length
  if (long > 0) {
    warnings.push(
      `${label} had ${long} row(s) with more cells than its ${head.length} headers; the extra ` +
        'cells were left out. Add a header for every column.'
    )
  }
  const body = rows.map(row => padRow(row.map(cellText), head.length))
  const fit = fitTable(extents(head, body))
  if (fit.landscape) {
    warnings.push(
      `${label} has more columns than a portrait page can show legibly, so it was set on ` +
        'a landscape page.'
    )
  }
  if (fit.broken.length > 0) {
    const many = fit.broken.length > 1
    warnings.push(
      `${label}: words in ${columnNames(head, fit.broken)} are wider than ` +
        `${many ? 'those columns' : 'that column'}, so they break across lines; ` +
        'split the table or leave out columns.'
    )
  }
  const size = fit.size * 2
  const { side, widths } = fit

  const headerRow = new TableRow({
    tableHeader: true,
    children: head.map(
      (h, i) =>
        new TableCell({
          width: { size: widths[i], type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: docxHex(palette.primary), color: 'auto' },
          children: [
            new Paragraph({
              ...docxDirection(h),
              children: inlineRuns(h, { color: 'FFFFFF', bold: true, size }, warnings),
            }),
          ],
          margins: { top: 80, bottom: 80, left: side, right: side },
        })
    ),
  })

  const bodyRows = body.map(
    (row, r) =>
      new TableRow({
        children: row.map((cell, i) => {
          const fill = layout === 'striped' && r % 2 === 1 ? docxHex(palette.zebra) : undefined
          return new TableCell({
            width: { size: widths[i], type: WidthType.DXA },
            ...(fill ? { shading: { type: ShadingType.CLEAR, fill, color: 'auto' } } : {}),
            children: [
              new Paragraph({
                ...docxDirection(cell),
                children: inlineRuns(cell, { color: docxHex(palette.text), size }, warnings),
              }),
            ],
            margins: { top: 60, bottom: 60, left: side, right: side },
          })
        }),
      })
  )

  const table = new Table({
    width: { size: sum(widths), type: WidthType.DXA },
    columnWidths: widths,
    ...(fit.fixed ? { layout: TableLayoutType.FIXED } : {}),
    ...(isRtlText(head.join(' ')) ? { visuallyRightToLeft: true } : {}),
    rows: [headerRow, ...bodyRows],
    borders: borders(layout, palette),
  })
  if (fit.landscape) LANDSCAPE_TABLES.add(table)
  return table
}
