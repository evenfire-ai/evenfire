/**
 * Table layout for clerum__generate_pptx.
 *
 * A PowerPoint table grows downward past the slide instead of continuing on
 * another one, and pptxgenjs's own paging does not know how tall wrapped rows
 * are. Rows are measured here and split across slides that repeat the header,
 * with column widths following the content instead of an even split.
 */
import type { PptxTable } from './pptxInput'
import { lineHeightIn, textWidth, truncateToLines, wrapLines } from './pptxText'

/** pptxgenjs's default cell margins, top+bottom and left+right, in inches. */
const CELL_PAD_Y = 0.1
const CELL_PAD_X = 0.2

const EMU = 914400

/**
 * A column never gets narrower than this, even when others need the room,
 * unless the table has too many columns for every one to have it.
 */
const MIN_COLUMN = 0.6

export interface TablePage {
  rows: string[][]
  /** Row heights in inches, header first. */
  rowHeights: number[]
}

export interface TableLayout {
  fontSize: number
  columnWidths: number[]
  pages: TablePage[]
}

/** Body text size for a table of `columns` columns on a slide of this width class. */
export function tableFontSize(columns: number, wide: boolean): number {
  const base = wide ? 12 : 10
  return Math.max(base - (columns >= 7 ? 2 : columns >= 5 ? 1 : 0), 8)
}

/**
 * Widths proportional to how much text each column holds. A column's single
 * longest word sets its floor, so words break inside a cell only when the
 * table cannot be made to fit otherwise.
 */
function columnWidths(table: PptxTable, width: number, size: number): number[] {
  const n = table.headers.length
  const natural: number[] = []
  const floor: number[] = []
  for (let c = 0; c < n; c++) {
    const cells = [table.headers[c], ...table.rows.map(r => r[c])]
    let longestLine = 0
    let longestWord = 0
    cells.forEach((cell, i) => {
      const bold = i === 0
      longestLine = Math.max(longestLine, textWidth(cell, size, bold))
      for (const word of cell.split(/\s+/)) {
        longestWord = Math.max(longestWord, textWidth(word, size, bold))
      }
    })
    natural.push(Math.min(longestLine, width * 0.6) + CELL_PAD_X)
    floor.push(Math.max(Math.min(longestWord, width * 0.3) + CELL_PAD_X, MIN_COLUMN))
  }
  const naturalSum = natural.reduce((a, b) => a + b, 0)
  if (naturalSum <= width) return scaledTo(natural, width)
  const floorSum = floor.reduce((a, b) => a + b, 0)
  if (floorSum >= width) return scaledTo(floor, width)
  const slack = natural.map((w, c) => Math.max(w - floor[c], 0))
  const slackSum = slack.reduce((a, b) => a + b, 0)
  return floor.map((w, c) => w + (slack[c] * (width - floorSum)) / (slackSum || 1))
}

/**
 * `widths` scaled to sum to `total`. A column the scaling would leave under
 * MIN_COLUMN gets MIN_COLUMN and the others share the rest; when the columns
 * cannot all have it, they get equal widths.
 */
function scaledTo(widths: number[], total: number): number[] {
  if (widths.length * MIN_COLUMN >= total) return widths.map(() => total / widths.length)
  const pinned = new Set<number>()
  for (;;) {
    const freeSum = widths.reduce((sum, w, i) => (pinned.has(i) ? sum : sum + w), 0)
    const scale = (total - pinned.size * MIN_COLUMN) / freeSum
    const under = widths
      .map((_, i) => i)
      .filter(i => !pinned.has(i) && widths[i] * scale < MIN_COLUMN)
    if (under.length === 0) return widths.map((w, i) => (pinned.has(i) ? MIN_COLUMN : w * scale))
    for (const i of under) pinned.add(i)
  }
}

function rowHeight(cells: string[], widths: number[], size: number, bold: boolean): number {
  let tallest = 0
  cells.forEach((cell, c) => {
    const lines = wrapLines(cell, size, widths[c] - CELL_PAD_X, bold).length
    tallest = Math.max(tallest, lines * lineHeightIn(size, cell))
  })
  return tallest + CELL_PAD_Y
}

/** Rounded up to the EMU, so the height written is never below the height measured. */
function ceilEmu(inches: number): number {
  return Math.ceil(inches * EMU) / EMU
}

/**
 * Lay `table` out in a box `box.w` wide, splitting its rows over as many
 * pages of height `box.h` as it needs. A row taller than a page on its own is
 * cut to fit and reported in `warnings`.
 */
export function layoutTable(
  table: PptxTable,
  box: { w: number; h: number },
  wide: boolean,
  where: string,
  warnings: string[]
): TableLayout {
  const fontSize = tableFontSize(table.headers.length, wide)
  // Measured at the width that will be written, so rounding to EMU cannot add a line.
  const widths = columnWidths(table, box.w, fontSize).map(w => Math.floor(w * EMU) / EMU)
  const headerHeight = ceilEmu(rowHeight(table.headers, widths, fontSize, true))
  const room = box.h - headerHeight
  let cut = 0
  const rows = table.rows.map(original => {
    let row = original
    let height = rowHeight(row, widths, fontSize, false)
    if (height > room) {
      cut++
      row = row.map((cell, c) => {
        const maxLines = Math.max(Math.floor((room - CELL_PAD_Y) / lineHeightIn(fontSize, cell)), 1)
        return truncateToLines(cell, fontSize, widths[c] - CELL_PAD_X, maxLines)
      })
      height = rowHeight(row, widths, fontSize, false)
    }
    return { cells: row, height: ceilEmu(height) }
  })
  const paginate = (maxRows: number): TablePage[] => {
    const out: TablePage[] = []
    let current: TablePage = { rows: [table.headers], rowHeights: [headerHeight] }
    let used = 0
    for (const row of rows) {
      const full = used + row.height > room + 1e-9 || current.rows.length - 1 >= maxRows
      if (full && current.rows.length > 1) {
        out.push(current)
        current = { rows: [table.headers], rowHeights: [headerHeight] }
        used = 0
      }
      current.rows.push(row.cells)
      current.rowHeights.push(row.height)
      used += row.height
    }
    out.push(current)
    return out
  }
  let pages = paginate(Infinity)
  if (pages.length > 1) {
    // The same number of slides with the rows spread evenly, so the last one
    // does not carry a single orphaned row.
    const even = paginate(Math.ceil(rows.length / pages.length))
    if (even.length === pages.length) pages = even
  }
  if (cut > 0) {
    warnings.push(
      `${where}: ${cut} row(s) held more text than fits on a slide and were shortened; ` +
        'split long cells into more rows.'
    )
  }
  if (pages.length > 1) {
    warnings.push(
      `${where}: ${table.rows.length} rows did not fit on one slide, so the table continues on ` +
        `${pages.length - 1} more slide(s) with the header repeated.`
    )
  }
  return { fontSize, columnWidths: widths, pages }
}
