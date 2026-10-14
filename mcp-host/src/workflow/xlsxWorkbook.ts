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
import { choose } from './ownEntry'
import { headerText } from './tableRows'
import {
  type SheetCell,
  cellProblem,
  isQuantityText,
  looksLikeRefusedDate,
  looksLikeUnreadNumber,
  readCell,
  startsLikeFormula,
  visualWidth,
} from './xlsxCells'
import {
  capText,
  cellOutput,
  cellWidth,
  codeColumn,
  count,
  fits,
  isRecord,
  plainIntegers,
  planColumn,
  requestedFormats,
} from './xlsxColumns'
import { NUMBER_FORMATS, isIdentifierHeader } from './xlsxFormats'
import { RegexBudget, prepareRules } from './xlsxRules'
import { SheetNames, argumentColor, resolveColumn, sheetTable, tableWidth } from './xlsxSheet'
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
        // A rule compares each cell as written: '50%' as 50 and 0.45 as 0.45.
        const numeric =
          Array.isArray(cf.rules) &&
          cf.rules.some(
            rule =>
              isRecord(rule) &&
              (rule.greaterThan !== undefined ||
                rule.lessThan !== undefined ||
                rule.between !== undefined)
          )
        const kinds = new Set(columns[col].map(cell => cell.kind))
        if (numeric && kinds.has('percent') && kinds.has('number')) {
          warnings.push(
            `${cfLabel}: the column holds percents written as text ('50%') and plain numbers ` +
              '(0.45); numeric rules compare each as written, 50 and 0.45, so send the column ' +
              'one way.'
          )
        }
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
  const palette =
    XLSX_PALETTES[choose(args.palette, Object.keys(XLSX_PALETTES), 'default', 'palette', warnings)]
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
