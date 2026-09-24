/**
 * The workbook clerum__generate_xlsx writes: sheets, typed and formatted cells,
 * conditional styles and images. Everything it drops or repairs is reported in
 * `warnings`, so the agent does not describe content the file lacks.
 */
import ExcelJS from 'exceljs'
import {
  type EmbeddableImage,
  type ImageSize,
  fitImageSize,
  loadEmbeddableImage,
} from './embeddedImages'
import { headerText } from './tableRows'
import {
  type SheetCell,
  cellProblem,
  codeDigits,
  isQuantityText,
  looksLikeRefusedDate,
  looksLikeUnreadNumber,
  readCell,
  startsLikeFormula,
  visualWidth,
} from './xlsxCells'
import {
  type FormatSpec,
  NUMBER_FORMATS,
  currencyFormat,
  detectFormat,
  displayedWidth,
  formatSpec,
  headerCurrency,
  isIdentifierHeader,
  percentFormat,
} from './xlsxFormats'
import { RegexBudget, prepareRules } from './xlsxRules'
import {
  SheetNames,
  argumentColor,
  fitLength,
  resolveColumn,
  sheetTable,
  tableWidth,
} from './xlsxSheet'
import { keepZipTextWhole } from './zipText'

interface XlsxPalette {
  // ARGB hex (no leading '#'), 8 chars: AA RR GG BB
  primary: string
  primaryDark: string
  text: string
  zebra: string
}

const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`

const XLSX_PALETTES: Record<string, XlsxPalette> = {
  default: {
    primary: argb('#0f172a'),
    primaryDark: argb('#020617'),
    text: argb('#0f172a'),
    zebra: argb('#f8fafc'),
  },
  corporate: {
    primary: argb('#1e3a8a'),
    primaryDark: argb('#1e293b'),
    text: argb('#1e293b'),
    zebra: argb('#f1f5f9'),
  },
  warm: {
    primary: argb('#b45309'),
    primaryDark: argb('#78350f'),
    text: argb('#2f2823'),
    zebra: argb('#fefdfb'),
  },
  alert: {
    primary: argb('#9f1239'),
    primaryDark: argb('#4c0519'),
    text: argb('#1f2937'),
    zebra: argb('#fef2f2'),
  },
}

const WHITE = argb('#ffffff')
/** Default row height, 15 points, in pixels. */
const ROW_PX = 20
const LOGO_BOX: ImageSize = { width: 160, height: 60 }
const MIN_TEXT_WIDTH = 10
const MAX_TEXT_WIDTH = 50
/** Width Excel gives a column nobody sized, in characters. */
const DEFAULT_COLUMN_WIDTH = 8.43
/** A 14pt bold title character takes about 1.4 characters of the default font. */
const TITLE_CHAR_WIDTH = 1.4
const TITLE_ROW_HEIGHT = 28
const TITLE_LINE_HEIGHT = 19
const MAX_TITLE_COLUMN_WIDTH = 100
/** Longest text a cell holds; Excel asks to repair a file with more. */
const MAX_CELL_TEXT = 32_767

interface XlsxSheetSpec {
  name?: unknown
  rows?: unknown
  headers?: unknown
  titleRow?: unknown
  columnFormats?: unknown
  conditionalFormatting?: unknown
  freezeHeader?: unknown
  autoFilter?: unknown
  images?: unknown
}

export type XlsxBuild = { ok: true; buffer: Buffer; summary: string } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** loadEmbeddableImage, with a refused path reported against the argument that sent it. */
function loadImage(
  ref: unknown,
  outputDir: string,
  warnings: string[],
  field: string
): EmbeddableImage | undefined {
  try {
    return loadEmbeddableImage(ref, outputDir, warnings, field)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `${field}: ${message}. Pass the file name in the output folder, as ` +
        "clerum__generate_chart returns it (e.g. 'sales.png')."
    )
  }
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined
}

function columnLetter(n: number): string {
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** The last column (XFD) and row a sheet has. */
const MAX_COLUMN = 16_384
const MAX_ROW = 1_048_576

function columnNumber(letters: string): number {
  let col = 0
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return col
}

/** Whether a cell such as "F2" lies inside the sheet. */
function onSheet(letters: string, row: string): boolean {
  const r = Number(row)
  return r >= 1 && r <= MAX_ROW && columnNumber(letters) <= MAX_COLUMN
}

/** "F2" → { col: 5, row: 1 }, the zero-based anchor ExcelJS takes. */
function cellAddressToCoord(address: string, field: string): { col: number; row: number } {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(address.trim())
  if (!m || !onSheet(m[1], m[2])) {
    throw new Error(
      `Invalid cell anchor "${address}" in ${field}: use a cell such as "F2", within XFD1048576.`
    )
  }
  return { col: columnNumber(m[1]) - 1, row: Number(m[2]) - 1 }
}

function cellRange(range: string, field: string): string {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+):\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(range.trim())
  if (!m || !onSheet(m[1], m[2]) || !onSheet(m[3], m[4])) {
    throw new Error(
      `Invalid cell range "${range}" in ${field}: use a range such as "F2:M20", within XFD1048576.`
    )
  }
  return `${m[1]}${m[2]}:${m[3]}${m[4]}`.toUpperCase()
}

/** Columns and the format each was asked for; keys that name nothing are reported. */
function requestedFormats(
  columnFormats: unknown,
  header: unknown[],
  width: number,
  label: string,
  warnings: string[]
): Map<number, FormatSpec> {
  const formats = new Map<number, FormatSpec>()
  if (columnFormats === undefined || columnFormats === null) return formats
  if (!isRecord(columnFormats)) {
    warnings.push(`${label}.columnFormats must be an object such as {"Revenue": "currencyUsd"}.`)
    return formats
  }
  const setBy = new Map<number, string>()
  for (const [key, value] of Object.entries(columnFormats)) {
    const col = resolveColumn(key, header, width)
    if (col === undefined) {
      warnings.push(
        `${label}.columnFormats key '${key}' matches no column; use a header text, ` +
          "a column letter such as 'B', or a 0-based index."
      )
      continue
    }
    const spec = formatSpec(value)
    if (!spec) {
      warnings.push(
        `${label}.columnFormats['${key}'] '${String(value)}' is not a format, so the column was ` +
          'formatted automatically; use currencyUsd, currency:EUR, percent, percentPoints, ' +
          "integer, decimal, plain, date, datetime, text, or an Excel code such as '#,##0.0'."
      )
      continue
    }
    if (setBy.has(col)) {
      warnings.push(
        `${label}.columnFormats keys '${setBy.get(col)}' and '${key}' name the same column; '${key}' was used.`
      )
    }
    setBy.set(col, key)
    formats.set(col, spec)
  }
  return formats
}

interface ColumnPlan {
  spec?: FormatSpec
  explicit: boolean
  /** Format for the column's cells that fit its spec. */
  numFmt?: string
  /** Plain numbers are stored divided by it: 100 for percentage points. */
  divisor: number
  /** Some amount in the column has decimals, so currency shows cents. */
  fraction: boolean
  /** Format shared by the column's percent cells, with the places any of them needs. */
  percentFmt?: string
}

function maxAbs(values: number[]): number {
  let max = 0
  for (const v of values) if (Math.abs(v) > max) max = Math.abs(v)
  return max
}

function planColumn(
  cells: SheetCell[],
  header: unknown,
  requested: FormatSpec | undefined,
  name: string,
  warnings: string[]
): ColumnPlan {
  const numbers: number[] = []
  const currencies = new Set<string>()
  let fraction = false
  for (const cell of cells) {
    if (cell.kind === 'number') numbers.push(cell.value as number)
    if ((cell.kind === 'number' || cell.kind === 'currency') && !Number.isInteger(cell.value)) {
      fraction = true
    }
    if (cell.currency) currencies.add(cell.currency)
  }
  const spec = requested ?? detectFormat(header, numbers)
  const written = cells.flatMap(cell => (cell.kind === 'percent' ? [cell.value as number] : []))
  const plan: ColumnPlan = {
    spec,
    explicit: requested !== undefined,
    divisor: 1,
    fraction,
    ...(written.length > 0 ? { percentFmt: percentFormat(undefined, written) } : {}),
  }
  if (!spec) return plan
  if (spec.type === 'currency') {
    const symbol =
      spec.symbol ?? headerCurrency(header) ?? (currencies.size === 1 ? [...currencies][0] : '$')
    plan.numFmt = currencyFormat(symbol, spec.decimals ?? (fraction ? 2 : 0))
  } else if (spec.type === 'percent') {
    plan.divisor = spec.points ? 100 : 1
    // Cells written as percents ('12.5%') count too, or 12.5% would show as 13%.
    const shares = cells.flatMap(cell => (cell.kind === 'percent' ? [cell.value as number] : []))
    plan.numFmt = percentFormat(spec.decimals, [...numbers.map(n => n / plan.divisor), ...shares])
    const max = maxAbs(numbers)
    const key = headerText(header)
    if (spec.points && !requested) {
      warnings.push(
        `${name}: values up to ${max} were read as percentage points (45 = 45%)` +
          (max <= 1.5 ? `; if they are fractions use columnFormats {'${key}': 'percent'}.` : '.')
      )
    } else if (!requested && numbers.length > 0) {
      warnings.push(
        `${name}: values up to ${max} were read as fractions (0.8 = 80%); if they are ` +
          `percentage points use columnFormats {'${key}': 'percentPoints'}.`
      )
    } else if (!spec.points && requested && max > 1.5) {
      warnings.push(
        `${name} is formatted as a percent, which expects fractions (0.45 = 45%), but holds ` +
          `values up to ${max}; use 'percentPoints' for values such as 45.`
      )
    }
  } else if (spec.type === 'text') {
    plan.numFmt = NUMBER_FORMATS.text
  } else {
    plan.numFmt = spec.numFmt
  }
  return plan
}

/**
 * Whether every text value in column `c` is a plain integer. Identifier columns
 * are converted only then: "02134" must stay text, and converting its
 * neighbours would leave a column of numbers and text that sorts apart.
 */
function plainIntegers(rows: unknown[][], c: number): boolean {
  return rows.every(
    row => typeof row[c] !== 'string' || /^(?:0|[1-9]\d{0,14})$/.test(row[c].trim())
  )
}

/**
 * A value in column `c` that a number would change (a leading zero, more than
 * 15 digits), when every value there is a whole number: such a column is kept
 * as text throughout, so its values sort and match as one type.
 */
function codeColumn(rows: unknown[][], c: number): string | undefined {
  let code: string | undefined
  for (const row of rows) {
    const v = row[c]
    if (v === null || v === undefined || v === '') continue
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || v < 0) return undefined
    } else if (typeof v !== 'string' || !/^\s*\d+\s*$/.test(v)) {
      return undefined
    } else if (code === undefined && codeDigits(v)) {
      code = v.trim()
    }
  }
  return code
}

/** Text cut to the cell limit, recording `address` when it was cut. */
function capText<T>(value: T, address: string, cut: string[]): T {
  if (typeof value !== 'string' || value.length <= MAX_CELL_TEXT) return value
  cut.push(address)
  return fitLength(value, MAX_CELL_TEXT) as T
}

/**
 * Whether a requested format applies to `cell`. A percent or an amount in
 * another currency keeps its own format: '45%' under 'integer' would show 0,
 * and '$1,200' under 'percent' 120000%.
 */
function fits(spec: FormatSpec, cell: SheetCell): boolean {
  const { kind } = cell
  switch (spec.type) {
    case 'text':
      return true
    case 'custom':
      if (kind === 'percent') return spec.numFmt.includes('%')
      if (kind === 'currency') return !!cell.currency && spec.numFmt.includes(cell.currency.trim())
      return kind === 'number' || kind === 'date' || kind === 'datetime'
    case 'date':
      return kind === 'number' || kind === 'date' || kind === 'datetime'
    case 'percent':
      return kind === 'number' || kind === 'percent'
    case 'currency':
      return (
        kind === 'number' ||
        (kind === 'currency' && (!cell.currency || !spec.symbol || cell.currency === spec.symbol))
      )
    default:
      return kind === 'number'
  }
}

/** The value written for `cell` and the format it is shown with. */
/**
 * `numFmt` showing a "+" before a positive value, as the cell was written. A
 * format of one section gets its negative and zero sections too, since Excel
 * would otherwise print a negative as "-+5".
 */
function withPlus(numFmt: string | undefined): string {
  const format = numFmt ?? 'General'
  const sections = format.split(';')
  if (sections.length === 1) return `+${format};-${format};${format}`
  return [`+${sections[0]}`, ...sections.slice(1)].join(';')
}

function cellOutput(
  cell: SheetCell,
  plan: ColumnPlan
): { value: SheetCell['value']; numFmt?: string } {
  const out = plainCellOutput(cell, plan)
  return cell.signed && typeof out.value === 'number' && out.value > 0
    ? { ...out, numFmt: withPlus(out.numFmt) }
    : out
}

function plainCellOutput(
  cell: SheetCell,
  plan: ColumnPlan
): { value: SheetCell['value']; numFmt?: string } {
  const { spec } = plan
  const value =
    cell.kind === 'number' && plan.divisor !== 1
      ? Number(((cell.value as number) / plan.divisor).toPrecision(15))
      : cell.value
  switch (cell.kind) {
    case 'text': {
      // Under the Text format, text that starts like a formula stays text even
      // when the cell is edited, so nothing has to be added to it.
      const asText = spec?.type === 'text' || startsLikeFormula(cell.text)
      return { value, numFmt: asText ? NUMBER_FORMATS.text : undefined }
    }
    case 'boolean':
    case 'empty':
      return { value }
  }
  if (plan.explicit && spec && fits(spec, cell)) return { value, numFmt: plan.numFmt }
  switch (cell.kind) {
    case 'number':
      return { value, numFmt: plan.numFmt }
    case 'percent':
      return {
        value,
        numFmt:
          spec?.type === 'percent'
            ? plan.numFmt
            : (plan.percentFmt ?? percentFormat(undefined, [value as number])),
      }
    case 'currency':
      return { value, numFmt: currencyFormat(cell.currency ?? '$', plan.fraction ? 2 : 0) }
    case 'date':
      return { value, numFmt: NUMBER_FORMATS.date }
    default:
      return { value, numFmt: cell.seconds ? 'yyyy-mm-dd hh:mm:ss' : NUMBER_FORMATS.datetime }
  }
}

function cellWidth(value: unknown, numFmt: string | undefined): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number' || value instanceof Date) return displayedWidth(value, numFmt)
  if (typeof value === 'boolean') return 5
  return visualWidth(String(value))
}

/**
 * Keeps the whole title visible once the columns are sized. A merged cell
 * clips its text, and columns are sized from the data alone, so a title wider
 * than the table wraps onto taller rows; on a sheet without columns, column A
 * is widened for it.
 */
function fitTitle(ws: ExcelJS.Worksheet, row: ExcelJS.Row, text: string, span: number): void {
  const lines = text.split('\n').map(line => visualWidth(line) * TITLE_CHAR_WIDTH + 2)
  const column = ws.getColumn(1)
  if (span === 1 && column.width === undefined) {
    let widest = DEFAULT_COLUMN_WIDTH
    for (const needed of lines) widest = Math.max(widest, needed)
    column.width = Math.min(widest, MAX_TITLE_COLUMN_WIDTH)
  }
  let available = 0
  for (let c = 1; c <= span; c++) available += ws.getColumn(c).width ?? DEFAULT_COLUMN_WIDTH
  const count = lines.reduce((sum, needed) => sum + Math.max(1, Math.ceil(needed / available)), 0)
  if (count <= 1) return
  for (let c = 1; c <= span; c++) {
    row.getCell(c).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  }
  row.height = TITLE_ROW_HEIGHT + (count - 1) * TITLE_LINE_HEIGHT
}

function addImages(
  workbook: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  refs: unknown,
  label: string,
  startRow: number,
  outputDir: string,
  box: ImageSize,
  warnings: string[]
): number {
  if (refs === undefined || refs === null) return 0
  if (!Array.isArray(refs)) {
    warnings.push(`${label}.images must be an array such as [{"path": "sales.png"}].`)
    return 0
  }
  let row = startRow
  let placed = 0
  refs.forEach((ref, j) => {
    const field = `${label}.images[${j}]`
    const image = loadImage(ref, outputDir, warnings, field)
    if (!image) return
    const opts = isRecord(ref) ? ref : {}
    const size = fitImageSize(image, box, {
      width: positive(opts.width),
      height: positive(opts.height),
    })
    const id = workbook.addImage({
      buffer: image.data as unknown as ExcelJS.Buffer,
      extension: image.format,
    })
    if (typeof opts.range === 'string' && opts.range.trim()) {
      ws.addImage(id, cellRange(opts.range, `${field}.range`))
    } else if (typeof opts.anchor === 'string' && opts.anchor.trim()) {
      ws.addImage(id, {
        tl: cellAddressToCoord(opts.anchor, `${field}.anchor`),
        ext: size,
        editAs: 'oneCell',
      })
    } else {
      ws.addImage(id, { tl: { col: 0, row }, ext: size, editAs: 'oneCell' })
      row += Math.ceil(size.height / ROW_PX) + 1
    }
    placed++
  })
  return placed
}

interface SheetContext {
  workbook: ExcelJS.Workbook
  palette: XlsxPalette
  outputDir: string
  imageBox: ImageSize
  warnings: string[]
  /** Time the regex rules of every sheet share. */
  regexBudget: RegexBudget
}

/** Writes one sheet; returns what it holds, for the summary. */
function writeSheet(
  ws: ExcelJS.Worksheet,
  sheet: XlsxSheetSpec,
  label: string,
  ctx: SheetContext,
  logo?: EmbeddableImage
): { rows: number; columns: number; images: number; title: boolean } {
  const { warnings, palette } = ctx
  const table = sheetTable(sheet, label, warnings)
  const { header } = table
  const width = Math.max(header.length, tableWidth(table.rows))

  let rowNumber = 0
  const titleRow = isRecord(sheet.titleRow) ? sheet.titleRow : undefined
  let title: { row: ExcelJS.Row; text: string; span: number } | undefined
  if (titleRow) {
    const problem = cellProblem(titleRow.text)
    if (problem) throw new Error(`${label}.titleRow.text ${problem}.`)
    const titleCell = readCell(titleRow.text, false)
    const titleText = capText(titleCell.value, 'A1', [])
    if (titleText !== titleCell.value) {
      warnings.push(`${label}.titleRow.text was cut to 32,767 characters, Excel's cell limit.`)
    }
    const row = ws.addRow([titleText])
    rowNumber = 1
    const span = Math.max(width, 1)
    title = { row, text: typeof titleText === 'string' ? titleText : titleCell.text, span }
    if (span > 1) ws.mergeCells(1, 1, 1, span)
    const font: Partial<ExcelJS.Font> = {
      bold: true,
      size: 14,
      color: {
        argb: argumentColor(titleRow.fontColor, `${label}.titleRow.fontColor`, warnings, WHITE),
      },
    }
    const fill: ExcelJS.Fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: {
        argb: argumentColor(
          titleRow.fillColor,
          `${label}.titleRow.fillColor`,
          warnings,
          palette.primary
        ),
      },
    }
    // Fill and font go on the merged cells only, not the row: a row style is
    // written for all 16,384 columns and paints past the data area.
    for (let c = 1; c <= span; c++) {
      const cell = row.getCell(c)
      cell.font = font
      cell.fill = fill
      cell.alignment = { vertical: 'middle', horizontal: 'center' }
    }
    if (startsLikeFormula(titleCell.text)) row.getCell(1).numFmt = NUMBER_FORMATS.text
    row.height = TITLE_ROW_HEIGHT
  }

  const autoFilter = sheet.autoFilter !== false
  const widths = new Array<number>(width).fill(0)
  const headerRowNumber = rowNumber + 1
  const dataRows = table.rows.length

  if (width > 0) {
    const requested = requestedFormats(sheet.columnFormats, header, width, label, warnings)
    const columns: SheetCell[][] = Array.from({ length: width }, () => [])
    const columnName = (c: number) =>
      `${label} column ${headerText(header[c]).trim() ? `'${headerText(header[c])}'` : columnLetter(c + 1)}`
    for (let c = 0; c < width; c++) {
      const format = requested.get(c)
      const code = format ? undefined : codeColumn(table.rows, c)
      if (code !== undefined) {
        warnings.push(
          `${columnName(c)}: kept as text because '${code}' ` +
            `${code.startsWith('0') ? 'has a leading zero' : 'has more than 15 digits'}, ` +
            'which a number would lose.'
        )
        for (const row of table.rows) {
          const v = row[c]
          columns[c].push(readCell(typeof v === 'number' ? String(v) : v, false))
        }
        continue
      }
      const convert = format
        ? format.type !== 'text'
        : !isIdentifierHeader(header[c]) || plainIntegers(table.rows, c)
      // A percent or an amount of money is never an identifier.
      for (const row of table.rows) {
        columns[c].push(readCell(row[c], convert || (!format && isQuantityText(row[c]))))
      }
    }
    const plans = columns.map((cells, c) =>
      planColumn(cells, header[c], requested.get(c), columnName(c), warnings)
    )
    columns.forEach((cells, c) => {
      const ambiguous = cells.find(cell => cell.ambiguous)
      if (ambiguous) {
        warnings.push(
          `${columnName(c)}: '${ambiguous.text}' was kept as text because it reads as two ` +
            'different numbers depending on the locale; send numbers as JSON numbers.'
        )
      }
      const unread = requested.has(c)
        ? []
        : cells.filter(
            cell => cell.kind === 'text' && !cell.ambiguous && looksLikeUnreadNumber(cell.text)
          )
      if (unread.length > 0) {
        const sample = unread[0].text.trim()
        warnings.push(
          `${columnName(c)}: ` +
            (unread.length === 1
              ? `'${sample}' was kept as text`
              : `${unread.length} values such as '${sample}' were kept as text`) +
            '; send JSON numbers, or ISO 8601 dates such as 2026-09-22.'
        )
      }
      const refused = requested.has(c)
        ? []
        : cells.filter(cell => cell.kind === 'text' && looksLikeRefusedDate(cell.text))
      if (refused.length > 0) {
        const sample = refused[0].text.trim()
        warnings.push(
          `${columnName(c)}: ` +
            (refused.length === 1
              ? `'${sample}' was kept as text: it is not a real date, or it is`
              : `${refused.length} dates such as '${sample}' were kept as text: each is not a ` +
                'real date, or is') +
            ' before 1 March 1900, where Excel dates start.'
        )
      }
      if (cells.some(cell => cell.shifted)) {
        warnings.push(`${columnName(c)}: times with a UTC offset were converted to UTC.`)
      }
      const spec = requested.get(c)
      if (spec && spec.type !== 'text') {
        const misfits = cells.filter(
          cell =>
            cell.kind !== 'empty' && cell.kind !== 'boolean' && !cell.ambiguous && !fits(spec, cell)
        )
        if (misfits.length > 0) {
          const hint =
            spec.type === 'date'
              ? "ISO 8601 dates such as '2026-09-22'"
              : spec.type === 'custom'
                ? "JSON numbers or ISO 8601 dates such as '2026-09-22'"
                : 'JSON numbers such as 1234.5'
          const chars = [...misfits[0].text]
          const sample = chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : misfits[0].text
          const which =
            misfits.length === 1
              ? `'${sample}' does not fit the format columnFormats asked for, so it was`
              : `${misfits.length} values such as '${sample}' do not fit the format ` +
                'columnFormats asked for, so they were'
          warnings.push(`${columnName(c)}: ${which} written as sent; send ${hint}.`)
        }
      }
    })

    const cut: string[] = []
    const headerRow = ws.addRow(
      header.map((h, c) =>
        h === undefined ? null : capText(h, `${columnLetter(c + 1)}${headerRowNumber}`, cut)
      )
    )
    rowNumber++
    const headerFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: WHITE }, size: 11 }
    const headerFill: ExcelJS.Fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: palette.primary },
    }
    // Styles are set per cell for the same reason as the title row.
    for (let c = 0; c < width; c++) {
      const cell = headerRow.getCell(c + 1)
      cell.font = headerFont
      cell.fill = headerFill
      cell.border = { bottom: { style: 'thin', color: { argb: palette.primaryDark } } }
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
      if (typeof header[c] === 'string' && startsLikeFormula(header[c] as string)) {
        cell.numFmt = NUMBER_FORMATS.text
      }
      // The filter button takes about two characters of the header cell.
      widths[c] = cellWidth(header[c], undefined) + (autoFilter && dataRows > 0 ? 2 : 0)
    }
    headerRow.height = 22

    const dataFont: Partial<ExcelJS.Font> = { color: { argb: palette.text }, size: 10 }
    const zebraFill: ExcelJS.Fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: palette.zebra },
    }
    for (let r = 0; r < dataRows; r++) {
      const outputs = columns.map((cells, c) => {
        const out = cellOutput(cells[r], plans[c])
        const address = `${columnLetter(c + 1)}${headerRowNumber + 1 + r}`
        return { ...out, value: capText(out.value, address, cut) }
      })
      const row = ws.addRow(outputs.map(o => o.value))
      rowNumber++
      for (let c = 0; c < width; c++) {
        const cell = row.getCell(c + 1)
        cell.font = dataFont
        if (r % 2 === 1) cell.fill = zebraFill
        const { value, numFmt } = outputs[c]
        if (numFmt) cell.numFmt = numFmt
        if (typeof value === 'number' || value instanceof Date) {
          cell.alignment = { horizontal: 'right' }
        }
        const w = cellWidth(value, numFmt)
        if (w > widths[c]) widths[c] = w
      }
    }

    if (cut.length > 0) {
      const shown = cut.slice(0, 5).join(', ')
      const more = cut.length > 5 ? ` and ${cut.length - 5} more` : ''
      warnings.push(
        `${label}: ${cut.length === 1 ? `cell ${shown} was` : `cells ${shown}${more} were`} ` +
          "cut to 32,767 characters, Excel's cell limit."
      )
    }

    if (Array.isArray(sheet.conditionalFormatting)) {
      sheet.conditionalFormatting.forEach((cf, j) => {
        const cfLabel = `${label}.conditionalFormatting[${j}]`
        if (!isRecord(cf)) {
          warnings.push(`${cfLabel} must be an object with column and rules.`)
          return
        }
        const col = resolveColumn(cf.column, header, width)
        if (col === undefined) {
          warnings.push(
            `${cfLabel}.column '${String(cf.column)}' matches no column; use a header text, ` +
              "a column letter such as 'B', or a 0-based index."
          )
          return
        }
        const texts = columns[col].map(cell => cell.text)
        const rules = prepareRules(cf.rules, cfLabel, warnings, texts, ctx.regexBudget)
        for (let r = 0; r < dataRows; r++) {
          const rule = rules.find(candidate => candidate.matches(columns[col][r]))
          if (!rule) continue
          const cell = ws.getRow(headerRowNumber + 1 + r).getCell(col + 1)
          if (rule.fill)
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rule.fill } }
          if (rule.font || rule.bold !== undefined) {
            cell.font = {
              ...(cell.font as object),
              ...(rule.font ? { color: { argb: rule.font } } : {}),
              ...(rule.bold !== undefined ? { bold: rule.bold } : {}),
            }
          }
        }
      })
    } else if (sheet.conditionalFormatting !== undefined) {
      warnings.push(`${label}.conditionalFormatting must be an array of {column, rules}.`)
    }

    if (sheet.freezeHeader ?? dataRows > 0) {
      ws.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRowNumber }]
    }
    if (autoFilter && dataRows > 0) {
      ws.autoFilter = `A${headerRowNumber}:${columnLetter(width)}${headerRowNumber}`
    }
    widths.forEach((w, c) => {
      ws.getColumn(c + 1).width = Math.min(Math.max(w, MIN_TEXT_WIDTH), MAX_TEXT_WIDTH) + 2
    })
  }

  if (title) fitTitle(ws, title.row, title.text, title.span)

  let imageRow = rowNumber > 0 ? rowNumber + 1 : 0
  let images = 0
  if (logo) {
    const size = fitImageSize(logo, LOGO_BOX)
    const id = ctx.workbook.addImage({
      buffer: logo.data as unknown as ExcelJS.Buffer,
      extension: logo.format,
    })
    // Beside the data, one column apart, so it covers neither the title nor the
    // header; with no columns, below the title, which then fills column A.
    const logoRow = width > 0 ? 0 : rowNumber
    ws.addImage(id, {
      tl: { col: width > 0 ? width + 1 : 0, row: logoRow },
      ext: size,
      editAs: 'oneCell',
    })
    if (width === 0) {
      imageRow = Math.max(imageRow, logoRow + Math.ceil(size.height / ROW_PX) + 1)
    }
    images++
  }
  images += addImages(
    ctx.workbook,
    ws,
    sheet.images,
    label,
    imageRow,
    ctx.outputDir,
    ctx.imageBox,
    warnings
  )
  return { rows: dataRows, columns: width, images, title: titleRow !== undefined }
}

/** Whether top-level `images`, which belong in a sheet, go on the first sheet. */
function topLevelImagesPlaced(args: Record<string, unknown>): boolean {
  return (
    Array.isArray(args.images) &&
    args.images.length > 0 &&
    Array.isArray(args.sheets) &&
    isRecord(args.sheets[0])
  )
}

/**
 * Builds the workbook `args` describe. Throws, with a message naming the
 * argument, on input that must not be written (an object as a cell, a
 * malformed anchor); returns `ok: false` when there is nothing to write.
 */
export async function buildXlsxWorkbook(
  args: Record<string, unknown>,
  outputDir: string,
  imageBox: ImageSize,
  warnings: string[]
): Promise<XlsxBuild> {
  const requested = args.sheets
  if (!Array.isArray(requested) || requested.length === 0) {
    return {
      ok: false,
      error:
        'sheets must be a non-empty array of sheets, e.g. ' +
        '[{"name": "Sales", "rows": [["Month", "Revenue"], ["Jan", 1200]]}].',
    }
  }
  let sheets: unknown[] = requested
  // The other generators take images at the top level, so models send them there too.
  if (topLevelImagesPlaced(args)) {
    const first = sheets[0] as Record<string, unknown>
    const own = Array.isArray(first.images) ? first.images : []
    sheets = [{ ...first, images: [...own, ...(args.images as unknown[])] }, ...sheets.slice(1)]
    warnings.push(
      'images belongs inside each sheet (sheets[i].images); the top-level images were placed on the first sheet.'
    )
  }
  const palette = XLSX_PALETTES[String(args.palette ?? 'default')] ?? XLSX_PALETTES.default
  const branding = isRecord(args.branding) ? args.branding : {}
  const company = typeof branding.companyName === 'string' ? branding.companyName : ''

  const workbook = new ExcelJS.Workbook()
  workbook.creator = company
  workbook.company = company
  workbook.created = new Date()
  const ctx: SheetContext = {
    workbook,
    palette,
    outputDir,
    imageBox,
    warnings,
    regexBudget: new RegexBudget(),
  }

  let logo = branding.logoPath
    ? loadImage(branding.logoPath, outputDir, warnings, 'branding.logoPath')
    : undefined
  const names = new SheetNames()
  const parts: string[] = []
  let written = false
  sheets.forEach((sheet, i) => {
    const label = `sheets[${i}]`
    if (!isRecord(sheet)) {
      warnings.push(`${label} must be an object with a name and rows; it was left out.`)
      return
    }
    const ws = workbook.addWorksheet(names.name(sheet.name, i, warnings))
    const result = writeSheet(ws, sheet, label, ctx, logo)
    logo = undefined
    const holds: string[] = []
    if (result.columns > 0) {
      holds.push(`${count(result.rows, 'data row')}, ${count(result.columns, 'column')}`)
    }
    if (result.images > 0) holds.push(count(result.images, 'image'))
    if (holds.length > 0 || result.title) written = true
    else warnings.push(`${label} has no rows or images, so sheet '${ws.name}' is empty.`)
    parts.push(
      `sheet '${ws.name}' (${holds.join(', ') || (result.title ? 'title only' : 'empty')})`
    )
  })

  if (!written) {
    return {
      ok: false,
      error:
        'No sheet had rows or images to write, so no file was created. Send sheets[].rows as ' +
        'arrays of cells with the header row first, e.g. [["Month", "Revenue"], ["Jan", 1200]].' +
        (warnings.length > 0 ? ` Details: ${warnings.join(' ')}` : ''),
    }
  }
  keepZipTextWhole()
  const raw = (await workbook.xlsx.writeBuffer()) as unknown as ArrayBufferView
  return {
    ok: true,
    buffer: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength),
    summary: parts.join('; '),
  }
}
