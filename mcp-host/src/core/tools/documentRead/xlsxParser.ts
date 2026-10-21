/**
 * Streaming XLSX parsing for `clerum__document_read`, inside the isolated
 * worker.
 *
 * The selected sheets are read part by part (workbook, relationships, styles,
 * shared strings, then each selected sheet) straight from the ZIP entry
 * streams into a SAX parser: no part is materialized whole, and the real
 * inflated bytes of every part read are counted chunk by chunk against
 * `maxUncompressedBytes` before the parser sees them, so a forged central
 * directory cannot inflate past the declared bound. Unselected sheets and
 * media parts are never inflated. Strings accumulate only in the V8 heap
 * (bounded synchronously) plus one row at a time.
 *
 * Value semantics follow the earlier ExcelJS-model reader: numbers, booleans
 * and strings retain their values; empty cells become null. Formulas use
 * cached results, or `[formula] =<formula>` without one (never evaluation);
 * an empty cached string result is an empty cell. Dates become ISO 8601,
 * rich text is concatenated (phonetic guides excluded), hyperlinks use
 * display text, and errors use their error strings. Merged values appear only
 * on their master cells (merge ranges stream after the rows, so slave cells
 * of the returned window are nulled before the outcome is built). Strings
 * are returned whole: the Tool redacts each complete value before applying
 * `maxCellChars`, so a cap never cuts a secret into fragments that no longer
 * match.
 *
 * Rows preserve null gaps and stop at their last non-empty computed cell.
 * Interior empty rows remain; trailing empty rows do not. Paging returns
 * complete rows and charges their full width, including null gaps. A row
 * whose full width alone exceeds `maxExtractedChars` is not returned: it
 * keeps its slot as `[]` and is listed in `skippedRows` (the complete list
 * of the window, so `count === first.length`; the Tool applies its own
 * display cap), so one wide row never makes the whole read fail. `lastRow`
 * is the sheet's last row with a computed value; the whole selected sheet is
 * walked for it even after the returned window stops.
 *
 * Worksheet rows and cells must arrive in document order (every writer emits
 * them so); a non-increasing row number is `document_parse_failed`. A row
 * without `r` takes the row number of its first cell reference, when that
 * cell has one; otherwise it is the next row after the previous one.
 *
 * Known divergences from that reader, deliberately accepted here (this is not
 * full ExcelJS parity):
 *
 * - Rows out of document order fail the document instead of being sorted or
 *   merged into the model.
 * - A value stored on a merge slave cell (`<mergeCells>` range) is discarded,
 *   as Excel itself empties those cells, but it still counts toward `lastRow`
 *   and toward the row/character budgets that admitted the window; those
 *   counters are not recomputed after merges. A trailing row emptied only by
 *   its merge is dropped from the returned window without changing `lastRow`.
 * - Only `xl/worksheets/sheetN.xml` parts reached through the workbook
 *   relationships are worksheets; any other part naming is ignored.
 * - Date detection reads the cell style index against the global `<numFmts>`
 *   table and the built-in formats; `<dxfs>` number formats are never global.
 * - `_xHHHH_` escapes are decoded in one pass over each complete `<t>` (Excel's
 *   TextXform), in shared strings, inline strings and rich-text runs, so
 *   `_x005F_x000D_` stays the literal `_x000D_`.
 * - Cell numbers use `parseFloat`, matching ExcelJS: a decimal comma such as
 *   `1,5` reads as `1` instead of failing the whole document.
 * - An invisible cell (style only, no value) adds no width, and an empty
 *   string cell is an empty cell.
 */
import JSZip from 'jszip'
import { createRequire } from 'node:module'
import { StringDecoder } from 'node:string_decoder'
import { SaxesParser, type SaxesTag } from 'saxes'
import { isAllocationError } from './documentMemory'
import type {
  DocumentReadLimits,
  XlsxCellValue,
  XlsxJob,
  XlsxOutcome,
  XlsxPosition,
  XlsxSheetResult,
} from './types'
import { checkZipExpansion } from './zipLimits'

// ExcelJS's own helpers define the date-format detection, serial-to-date
// conversion, shared-formula sliding and built-in number formats the model
// reader used; reuse them so computed values do not drift from it. The
// package ships no type declarations for these internals.
const excelRequire = createRequire(__filename)
const { isDateFmt, excelToDate } = excelRequire('exceljs/lib/utils/utils') as {
  isDateFmt: (format: string | undefined) => boolean
  excelToDate: (value: number, date1904: boolean) => Date
}
const { slideFormula } = excelRequire('exceljs/lib/utils/shared-formula') as {
  slideFormula: (formula: string, fromCell: string, toCell: string) => string
}
const defaultNumFormats = excelRequire('exceljs/lib/xlsx/defaultnumformats') as Record<
  number,
  { f?: string }
>

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
// Excel's last sheet column is XFD.
const MAX_COLUMN = 16_384

/**
 * A cell whose stored value has no representation, such as a date-formatted
 * number outside the JavaScript Date range. It is a property of the file, so
 * the call fails as `document_parse_failed` rather than as a worker defect.
 */
class UnreadableCellError extends Error {}

/** A workbook part that cannot be found or parsed: a property of the file. */
class UnreadablePartError extends Error {}

/** The real inflated bytes of the parts read passed the configured bound. */
class InflatedLimitError extends Error {}

class InflatedCounter {
  private total = 0

  constructor(private readonly limit: number) {}

  add(bytes: number): void {
    this.total += bytes
    if (this.total > this.limit) throw new InflatedLimitError()
  }
}

/** Consumes a readable stream one chunk at a time, with backpressure. */
async function streamChunks(
  stream: NodeJS.ReadableStream,
  consume: (chunk: Buffer) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    // An abandoned JSZip stream can still emit its asynchronous end-of-stream
    // size error. Keep a sink attached so that late event is not uncaught.
    stream.on('error', () => {})
    const detach = (): void => {
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('error', onError)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      detach()
      // Destroying this adapter makes its inflater keep pushing after EOF,
      // which throws asynchronously. Pausing the adapter and its JSZip helper
      // stops the next compressed block and bounds the unconsumed tail; the
      // error sink above absorbs a late end-of-stream size error. Measured on
      // a forged 64 MiB part whose declared size was 1 KiB: after the 1 MiB
      // counter tripped, the producer emitted no further byte following the
      // rejection, so the residual is at most the already-buffered tail of one
      // chunk. Heap/RLIMIT_DATA and the job timeout stay as hard bounds if a
      // future JSZip stops honoring `pause`.
      stream.pause()
      ;(stream as { _helper?: { pause?: () => void } })._helper?.pause?.()
      reject(error)
    }
    const onData = (chunk: Buffer | string): void => {
      if (settled) return
      stream.pause()
      try {
        consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      } catch (error) {
        fail(error)
        return
      }
      stream.resume()
    }
    const onEnd = (): void => {
      if (settled) return
      settled = true
      detach()
      resolve()
    }
    const onError = (error: unknown): void => fail(error)
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onError)
    stream.resume()
  })
}

/**
 * Streams one ZIP part through a SAX parser, counting its real inflated
 * bytes before the parser sees each chunk. A missing or malformed part is
 * `UnreadablePartError`; listener errors keep their own classification.
 */
async function streamXmlPart(
  zip: JSZip,
  path: string,
  counter: InflatedCounter,
  listen: (parser: SaxesParser) => void
): Promise<void> {
  const entry = zip.file(path)
  if (!entry || entry.dir) throw new UnreadablePartError()
  const parser = new SaxesParser()
  let malformed = false
  parser.on('error', () => {
    malformed = true
  })
  listen(parser)
  const decoder = new StringDecoder('utf8')
  let stream: NodeJS.ReadableStream | undefined
  let parserFailure = false
  const write = (text: string): void => {
    if (text.length === 0) return
    try {
      parser.write(text)
    } catch (error) {
      parserFailure = true
      throw error
    }
  }
  try {
    stream = entry.nodeStream()
    await streamChunks(stream, buffer => {
      counter.add(buffer.byteLength)
      write(decoder.write(buffer))
    })
    write(decoder.end())
    try {
      parser.close()
    } catch (error) {
      parserFailure = true
      throw error
    }
  } catch (error) {
    if (
      parserFailure ||
      error instanceof InflatedLimitError ||
      error instanceof UnreadableCellError ||
      error instanceof UnreadablePartError ||
      // An allocation failure is the memory ceiling, not a property of the
      // file: the worker must classify it as `heap`, so it cannot become an
      // UnreadablePartError here.
      isAllocationError(error)
    ) {
      throw error
    }
    throw new UnreadablePartError()
  }
  if (malformed) throw new UnreadablePartError()
}

function tagAttribute(node: SaxesTag, name: string): string | undefined {
  const value = node.attributes[name]
  return typeof value === 'string' ? value : undefined
}

function columnLetters(column: number): string {
  let letters = ''
  let remaining = column
  while (remaining > 0) {
    const digit = (remaining - 1) % 26
    letters = String.fromCharCode(65 + digit) + letters
    remaining = Math.floor((remaining - 1) / 26)
  }
  return letters
}

function columnNumber(letters: string): number | undefined {
  let column = 0
  for (const char of letters.toUpperCase()) {
    const value = char.charCodeAt(0) - 64
    if (value < 1 || value > 26) return undefined
    column = column * 26 + value
    if (column > MAX_COLUMN) return undefined
  }
  return column > 0 ? column : undefined
}

interface CellReference {
  column: number
  row: number
}

/** Parses an A1-style cell reference into its 1-based column and row. */
function cellReference(ref: string): CellReference | undefined {
  const match = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim())
  if (!match) return undefined
  const column = columnNumber(match[1]!)
  const row = Number(match[2])
  if (column === undefined || !Number.isSafeInteger(row) || row < 1) return undefined
  return { column, row }
}

/**
 * Excel's `TextXform`: `_xHHHH_` names one UTF-16 code unit. It is a single
 * pass over the complete text of a `<t>` (never a chunk, or an escape split
 * between chunks would corrupt), so `_x005F_x000D_` decodes to the literal
 * `_x000D_` instead of a carriage return.
 */
function decodeTextXform(text: string): string {
  if (!text.includes('_x')) return text
  return text.replace(/_x([0-9A-F]{4})_/g, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  )
}

// ─── Workbook structure ─────────────────────────────────────

interface SheetMeta {
  name: string
  path: string
}

interface WorkbookMeta {
  sheets: SheetMeta[]
  date1904: boolean
}

/**
 * Resolves the workbook's worksheet parts exactly as the previous reader's
 * loader did: sheets appear in workbook order (hidden and veryHidden
 * included), a sheet whose relationship or worksheet part is missing is
 * ignored, and chartsheets are not worksheets.
 */
function sheetPartPath(target: string): string {
  const trimmed = target.trim()
  if (trimmed.startsWith('/xl/')) return trimmed.slice(1)
  if (trimmed.startsWith('xl/')) return trimmed
  if (trimmed.startsWith('/')) return trimmed.slice(1)
  return 'xl/' + trimmed
}

async function parseWorkbookMeta(zip: JSZip, counter: InflatedCounter): Promise<WorkbookMeta> {
  let date1904 = false
  const relationBySheet: Array<{ name: string; relationId: string | undefined }> = []
  await streamXmlPart(zip, 'xl/workbook.xml', counter, parser => {
    parser.on('opentag', node => {
      if (node.name === 'workbookPr') {
        const flag = tagAttribute(node, 'date1904')
        if (flag === '1' || flag === 'true') date1904 = true
      } else if (node.name === 'sheet') {
        const name = tagAttribute(node, 'name')
        if (name === undefined) throw new UnreadablePartError()
        relationBySheet.push({ name, relationId: tagAttribute(node, 'r:id') })
      }
    })
  })
  const targetByRelation = new Map<string, string>()
  await streamXmlPart(zip, 'xl/_rels/workbook.xml.rels', counter, parser => {
    parser.on('opentag', node => {
      if (node.name !== 'Relationship') return
      const id = tagAttribute(node, 'Id')
      const target = tagAttribute(node, 'Target')
      if (id !== undefined && target !== undefined) targetByRelation.set(id, target)
    })
  })
  const sheets: SheetMeta[] = []
  for (const { name, relationId } of relationBySheet) {
    const target = relationId === undefined ? undefined : targetByRelation.get(relationId)
    if (target === undefined) continue
    const path = sheetPartPath(target)
    // The loader only materialized entries named xl/worksheets/sheetN.xml.
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) continue
    const entry = zip.file(path)
    if (!entry || entry.dir) continue
    sheets.push({ name, path })
  }
  return { sheets, date1904 }
}

// ─── Styles and shared strings ──────────────────────────────

interface StyleTable {
  isDateStyle: (styleIndex: number | undefined) => boolean
}

async function parseStyles(zip: JSZip, counter: InflatedCounter): Promise<StyleTable> {
  const customFormats = new Map<number, string>()
  const cellFormatIds: number[] = []
  if (zip.file('xl/styles.xml')) {
    // Only the workbook's global `<numFmts>` section defines cell number
    // formats. `<dxfs>` has its own `<numFmt>` children (differential formats
    // for conditional formatting) whose ids collide with the global table;
    // reading them would overwrite a date format with a numeric one.
    let inNumFmts = false
    let inCellXfs = false
    await streamXmlPart(zip, 'xl/styles.xml', counter, parser => {
      parser.on('opentag', node => {
        if (node.name === 'numFmts') {
          inNumFmts = true
        } else if (node.name === 'numFmt' && inNumFmts) {
          const id = Number(tagAttribute(node, 'numFmtId'))
          const code = tagAttribute(node, 'formatCode')
          // ExcelJS unescapes backslash-escaped characters in format codes.
          if (Number.isSafeInteger(id) && code !== undefined) {
            customFormats.set(id, code.replace(/\\(.)/g, '$1'))
          }
        } else if (node.name === 'cellXfs') {
          inCellXfs = true
        } else if (node.name === 'xf' && inCellXfs) {
          const id = Number(tagAttribute(node, 'numFmtId') ?? '0')
          cellFormatIds.push(Number.isSafeInteger(id) ? id : 0)
        }
      })
      parser.on('closetag', node => {
        if (node.name === 'numFmts') inNumFmts = false
        else if (node.name === 'cellXfs') inCellXfs = false
      })
    })
  }
  return {
    isDateStyle: styleIndex => {
      if (styleIndex === undefined) return false
      const formatId = cellFormatIds[styleIndex]
      if (formatId === undefined) return false
      const code = customFormats.get(formatId) ?? defaultNumFormats[formatId]?.f
      return code !== undefined && isDateFmt(code)
    },
  }
}

async function parseSharedStrings(zip: JSZip, counter: InflatedCounter): Promise<string[]> {
  const strings: string[] = []
  if (!zip.file('xl/sharedStrings.xml')) return strings
  let current: string | null = null
  let inText = false
  let inPhonetic = false
  // One `<t>` can be split across parser chunks, so its complete text is
  // buffered and the TextXform decode runs once, on `</t>`.
  let textBuffer = ''
  await streamXmlPart(zip, 'xl/sharedStrings.xml', counter, parser => {
    parser.on('opentag', node => {
      if (node.name === 'si') current = ''
      else if (node.name === 'rPh') inPhonetic = true
      else if (node.name === 't' && current !== null && !inPhonetic) {
        inText = true
        textBuffer = ''
      }
    })
    parser.on('text', text => {
      if (inText) textBuffer += text
    })
    parser.on('closetag', node => {
      if (node.name === 't') {
        if (inText && current !== null) current += decodeTextXform(textBuffer)
        inText = false
      } else if (node.name === 'rPh') inPhonetic = false
      else if (node.name === 'si' && current !== null) {
        strings.push(current)
        current = null
      }
    })
  })
  return strings
}

// ─── Cell values ────────────────────────────────────────────

interface CellState {
  /** The cell address as written, or synthesized for a cell without `r`. */
  ref: string
  column: number
  type: string | undefined
  styleIndex: number | undefined
  hasValue: boolean
  valueText: string
  inlineText: string
  formulaText: string | undefined
  formulaSharedId: string | undefined
}

interface ValueContext {
  sharedStrings: string[]
  styles: StyleTable
  date1904: boolean
  sharedFormulas: Map<string, { formula: string; masterRef: string }>
}

function dateValue(serial: number, date1904: boolean): string {
  const date = excelToDate(serial, date1904)
  if (Number.isNaN(date.getTime())) throw new UnreadableCellError()
  return date.toISOString()
}

function isoDateValue(text: string): string {
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) throw new UnreadableCellError()
  return date.toISOString()
}

function numericValue(text: string, cell: CellState, context: ValueContext): XlsxCellValue {
  // ExcelJS parses a numeric cell with `parseFloat`, so a locale decimal comma
  // reads as its leading integer ("1,5" -> 1) instead of failing the document.
  const value = parseFloat(text)
  if (Number.isNaN(value)) throw new UnreadableCellError()
  return context.styles.isDateStyle(cell.styleIndex) ? dateValue(value, context.date1904) : value
}

function booleanValue(text: string): boolean {
  return text === '1' || text === 'true'
}

function formulaDisplay(cell: CellState, context: ValueContext): string {
  if (cell.formulaText !== undefined && cell.formulaText !== '') return cell.formulaText
  if (cell.formulaSharedId !== undefined) {
    const master = context.sharedFormulas.get(cell.formulaSharedId)
    if (master === undefined) throw new UnreadablePartError()
    try {
      return slideFormula(master.formula, master.masterRef, cell.ref)
    } catch {
      throw new UnreadablePartError()
    }
  }
  return cell.formulaText ?? ''
}

function sharedStringValue(text: string, context: ValueContext): XlsxCellValue {
  if (text === '') return null
  const shared = context.sharedStrings[Number(text)]
  return shared === undefined || shared === '' ? null : shared
}

function computedCellValue(cell: CellState, context: ValueContext): XlsxCellValue {
  const isFormula = cell.formulaText !== undefined || cell.formulaSharedId !== undefined
  if (isFormula) {
    // A shared formula's master registers its text for its followers.
    if (cell.formulaSharedId !== undefined && cell.formulaText) {
      context.sharedFormulas.set(cell.formulaSharedId, {
        formula: cell.formulaText,
        masterRef: cell.ref,
      })
    }
    if (!cell.hasValue) return '[formula] =' + formulaDisplay(cell, context)
    switch (cell.type) {
      case 'str':
        // An empty cached string result is an empty cell, including the
        // self-closing <v/> form.
        return cell.valueText === '' ? null : cell.valueText
      case 'b':
        return cell.valueText === '' ? null : booleanValue(cell.valueText)
      case 'e':
        return cell.valueText === '' ? null : cell.valueText
      case 's':
        return sharedStringValue(cell.valueText, context)
      case 'd':
        return cell.valueText === '' ? null : isoDateValue(cell.valueText)
      case 'inlineStr':
        return cell.inlineText === '' ? null : cell.inlineText
      default:
        // A dropped empty <v> of a numeric result is no cached result.
        if (cell.valueText === '') return '[formula] =' + formulaDisplay(cell, context)
        return numericValue(cell.valueText, cell, context)
    }
  }
  switch (cell.type) {
    case 's':
      return cell.hasValue ? sharedStringValue(cell.valueText, context) : null
    case 'inlineStr':
      return cell.inlineText === '' ? null : cell.inlineText
    case 'str':
      return !cell.hasValue || cell.valueText === '' ? null : cell.valueText
    case 'b':
      return !cell.hasValue || cell.valueText === '' ? null : booleanValue(cell.valueText)
    case 'e':
      return !cell.hasValue || cell.valueText === '' ? null : cell.valueText
    case 'd':
      return !cell.hasValue || cell.valueText === '' ? null : isoDateValue(cell.valueText)
    default:
      if (!cell.hasValue || cell.valueText === '') return null
      return numericValue(cell.valueText, cell, context)
  }
}

// ─── Window accounting ──────────────────────────────────────

type StoppedBy = 'max_rows' | 'max_cells' | 'max_extracted_chars'

interface MutableSheet {
  name: string
  startRow: number
  rows: XlsxCellValue[][]
  truncated: boolean
  lastRow: number
  skippedCount: number
  skippedFirst: number[]
}

class SheetWindow {
  rowCount = 0
  stoppedBy: StoppedBy | undefined
  next: XlsxPosition | undefined
  private cellCount = 0
  private charCount = 0

  constructor(private readonly limits: DocumentReadLimits) {}

  get stopped(): boolean {
    return this.stoppedBy !== undefined
  }

  /**
   * Charges one row to the per-call budgets. Returns false when this row is
   * where the read stops; `next` then names it for the continuation. The
   * first row of a call is always returned, so every continuation advances
   * even when one row alone is wider than the cell limit. A row that alone
   * exceeds the character limit is not charged at all: it keeps its slot as
   * `[]` and is listed in `skippedRows`.
   */
  add(
    sheet: MutableSheet,
    sheetIndex: number,
    rowNumber: number,
    values: XlsxCellValue[]
  ): boolean {
    if (this.rowCount >= this.limits.maxRowsPerCall) {
      this.stop(sheet, sheetIndex, rowNumber, 'max_rows')
      return false
    }
    const rowChars = JSON.stringify(values).length
    if (rowChars > this.limits.maxExtractedChars) {
      sheet.rows.push([])
      this.rowCount += 1
      sheet.skippedCount += 1
      // The complete list of the window: `count === first.length`. The Tool
      // applies the display cap when it builds the model-visible result.
      sheet.skippedFirst.push(rowNumber)
      return true
    }
    if (this.rowCount > 0 && this.cellCount + values.length > this.limits.maxCellsPerCall) {
      this.stop(sheet, sheetIndex, rowNumber, 'max_cells')
      return false
    }
    if (this.rowCount > 0 && this.charCount + rowChars > this.limits.maxExtractedChars) {
      this.stop(sheet, sheetIndex, rowNumber, 'max_extracted_chars')
      return false
    }
    sheet.rows.push(values)
    this.rowCount += 1
    this.cellCount += values.length
    this.charCount += rowChars
    return true
  }

  private stop(
    sheet: MutableSheet,
    sheetIndex: number,
    rowNumber: number,
    reason: StoppedBy
  ): void {
    this.stoppedBy = reason
    this.next = { sheetIndex, row: rowNumber }
    sheet.truncated = true
  }
}

// ─── Worksheet streaming ────────────────────────────────────

interface MergeRange {
  top: number
  left: number
  bottom: number
  right: number
}

interface RowPair {
  column: number
  value: XlsxCellValue
}

function mergeRange(ref: string): MergeRange {
  const match = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(ref.trim())
  if (!match) throw new UnreadablePartError()
  const firstColumn = columnNumber(match[1]!)
  const firstRow = Number(match[2])
  const lastColumn = match[3] === undefined ? firstColumn : columnNumber(match[3])
  const lastRow = match[4] === undefined ? firstRow : Number(match[4])
  if (
    firstColumn === undefined ||
    lastColumn === undefined ||
    !Number.isSafeInteger(firstRow) ||
    !Number.isSafeInteger(lastRow) ||
    firstRow < 1 ||
    lastRow < 1
  ) {
    throw new UnreadablePartError()
  }
  return {
    top: Math.min(firstRow, lastRow),
    left: Math.min(firstColumn, lastColumn),
    bottom: Math.max(firstRow, lastRow),
    right: Math.max(firstColumn, lastColumn),
  }
}

function rowValues(pairs: readonly RowPair[], sorted: boolean): XlsxCellValue[] {
  const ordered = sorted ? pairs : [...pairs].sort((left, right) => left.column - right.column)
  const values: XlsxCellValue[] = []
  for (const { column, value } of ordered) {
    const index = column - 1
    while (values.length < index) values.push(null)
    if (values.length === index) values.push(value)
    else values[index] = value
  }
  return values
}

/**
 * A merged range keeps its value only on the top-left (master) cell. Returns
 * the row indices the merge emptied completely, so the caller can drop a
 * trailing slot that holds no value any more without touching a skipped wide
 * row, which is also `[]` but keeps its slot.
 */
function applyMerges(sheet: MutableSheet, merges: readonly MergeRange[]): ReadonlySet<number> {
  const emptied = new Set<number>()
  if (merges.length === 0 || sheet.rows.length === 0) return emptied
  for (let index = 0; index < sheet.rows.length; index += 1) {
    const rowNumber = sheet.startRow + index
    const values = sheet.rows[index]!
    let changed = false
    for (const merge of merges) {
      if (rowNumber < merge.top || rowNumber > merge.bottom) continue
      const from = Math.max(1, merge.left)
      const to = Math.min(values.length, merge.right)
      for (let column = from; column <= to; column += 1) {
        if (rowNumber === merge.top && column === merge.left) continue
        if (values[column - 1] === null || values[column - 1] === undefined) continue
        values[column - 1] = null
        changed = true
      }
    }
    if (!changed) continue
    while (values.length > 0 && values[values.length - 1] === null) values.pop()
    if (values.length === 0) emptied.add(index)
  }
  return emptied
}

/**
 * Streams one worksheet. Rows with values are emitted; interior empty rows
 * are emitted only once a later row with a value confirms them, so trailing
 * empty rows are discarded. The whole part is still walked after the window
 * stops, to compute `lastRow`.
 */
async function streamSheet(
  zip: JSZip,
  sheetMeta: SheetMeta,
  counter: InflatedCounter,
  sheet: MutableSheet,
  sheetIndex: number,
  startRow: number,
  window: SheetWindow,
  context: ValueContext
): Promise<readonly MergeRange[]> {
  const merges: MergeRange[] = []
  let rowNumber = 0
  let previousRow = 0
  let rowOpen = false
  let collectRow = false
  let rowHasValue = false
  let rowPairs: RowPair[] = []
  let rowPairsSorted = true
  let previousPairColumn = 0
  let nextEmitRow = startRow
  let inSheetData = false
  let inMergeCells = false
  let currentCell: CellState | undefined
  let previousCellColumn = 0
  let inValue = false
  let inFormula = false
  let inInline = false
  let inText = false
  let inPhonetic = false
  let textBuffer = ''
  // A row without `r` takes the row number of its first cell reference,
  // when that cell has one; until then it is simply the next row.
  let rowNumberPending = false

  const closeCell = (): void => {
    const cell = currentCell
    currentCell = undefined
    if (cell === undefined) return
    const value = computedCellValue(cell, context)
    if (value === null) return
    rowHasValue = true
    if (!collectRow) return
    if (cell.column < previousPairColumn) rowPairsSorted = false
    previousPairColumn = cell.column
    rowPairs.push({ column: cell.column, value })
  }

  const addEmptyRowsUntil = (end: number): void => {
    while (nextEmitRow < end && !window.stopped) {
      const emptyRow = nextEmitRow
      if (!window.add(sheet, sheetIndex, emptyRow, [])) return
      nextEmitRow = emptyRow + 1
    }
  }

  const closeRow = (): void => {
    const closingRow = rowNumber
    const pairs = rowPairs
    const sorted = rowPairsSorted
    const hasValue = rowHasValue
    const collected = collectRow
    rowOpen = false
    collectRow = false
    rowHasValue = false
    rowPairs = []
    rowPairsSorted = true
    previousPairColumn = 0
    if (!hasValue) return
    sheet.lastRow = closingRow
    if (!collected || window.stopped) return
    addEmptyRowsUntil(closingRow)
    if (window.stopped) return
    const values = rowValues(pairs, sorted)
    if (window.add(sheet, sheetIndex, closingRow, values)) nextEmitRow = closingRow + 1
  }

  await streamXmlPart(zip, sheetMeta.path, counter, parser => {
    parser.on('opentag', node => {
      const name = node.name
      if (name === 'sheetData') {
        inSheetData = true
        return
      }
      if (name === 'mergeCells') {
        inMergeCells = true
        return
      }
      if (name === 'mergeCell') {
        if (!inMergeCells) return
        const ref = tagAttribute(node, 'ref')
        if (ref === undefined) throw new UnreadablePartError()
        merges.push(mergeRange(ref))
        return
      }
      if (!inSheetData) return
      if (name === 'row') {
        if (rowOpen) throw new UnreadablePartError()
        const raw = tagAttribute(node, 'r')
        let next: number
        if (raw === undefined) {
          next = previousRow + 1
          rowNumberPending = true
        } else {
          next = Number(raw)
          if (!Number.isSafeInteger(next) || next < 1) throw new UnreadablePartError()
          rowNumberPending = false
        }
        if (next <= previousRow) throw new UnreadablePartError()
        previousRow = next
        rowNumber = next
        rowOpen = true
        rowHasValue = false
        rowPairs = []
        rowPairsSorted = true
        previousPairColumn = 0
        previousCellColumn = 0
        collectRow = next >= nextEmitRow && !window.stopped
        return
      }
      if (name === 'c') {
        if (!rowOpen || currentCell !== undefined) throw new UnreadablePartError()
        const ref = tagAttribute(node, 'r')
        let column: number
        let address: string
        if (ref === undefined) {
          column = previousCellColumn + 1
          if (column > MAX_COLUMN) throw new UnreadablePartError()
          address = columnLetters(column) + String(rowNumber)
        } else {
          const parsed = cellReference(ref)
          if (parsed === undefined) throw new UnreadablePartError()
          column = parsed.column
          if (rowNumberPending) {
            // The row omitted `r`; its first explicit cell reference names the
            // row. Growth must still be strict.
            if (parsed.row <= previousRow) throw new UnreadablePartError()
            previousRow = parsed.row
            rowNumber = parsed.row
            collectRow = rowNumber >= nextEmitRow && !window.stopped
          }
          address = ref
        }
        rowNumberPending = false
        previousCellColumn = column
        const style = tagAttribute(node, 's')
        const styleIndex = style === undefined ? undefined : Number(style)
        currentCell = {
          ref: address,
          column,
          type: tagAttribute(node, 't'),
          styleIndex:
            styleIndex !== undefined && Number.isSafeInteger(styleIndex) && styleIndex >= 0
              ? styleIndex
              : undefined,
          hasValue: false,
          valueText: '',
          inlineText: '',
          formulaText: undefined,
          formulaSharedId: undefined,
        }
        inValue = false
        inFormula = false
        inInline = false
        inText = false
        inPhonetic = false
        textBuffer = ''
        return
      }
      if (currentCell === undefined) return
      if (name === 'f') {
        currentCell.formulaText = ''
        const sharedId = tagAttribute(node, 'si')
        if (sharedId !== undefined) currentCell.formulaSharedId = sharedId
        inFormula = true
        return
      }
      if (name === 'v') {
        currentCell.hasValue = true
        currentCell.valueText = ''
        inValue = true
        return
      }
      if (name === 'is') {
        inInline = true
        return
      }
      if (name === 'rPh') {
        inPhonetic = true
        return
      }
      if (name === 't' && inInline && !inPhonetic) {
        inText = true
        textBuffer = ''
      }
    })
    parser.on('text', text => {
      if (currentCell === undefined) return
      if (inValue) currentCell.valueText += text
      else if (inFormula) currentCell.formulaText = (currentCell.formulaText ?? '') + text
      else if (inInline && inText && !inPhonetic) textBuffer += text
    })
    parser.on('closetag', node => {
      const name = node.name
      if (name === 'sheetData') {
        inSheetData = false
        return
      }
      if (name === 'mergeCells') {
        inMergeCells = false
        return
      }
      if (name === 'row') {
        if (rowOpen) closeRow()
        return
      }
      if (name === 'c') {
        closeCell()
        return
      }
      if (name === 'v') {
        inValue = false
        return
      }
      if (name === 'f') {
        inFormula = false
        return
      }
      if (name === 't') {
        if (inText && currentCell !== undefined) {
          currentCell.inlineText += decodeTextXform(textBuffer)
        }
        inText = false
        return
      }
      if (name === 'rPh') {
        inPhonetic = false
        return
      }
      if (name === 'is') inInline = false
    })
  })
  return merges
}

// ─── Selection and outcome ──────────────────────────────────

interface WorksheetSelection {
  sheetNames: string[]
  sheetIndex: number
  row: number
  sheets: SheetMeta[]
}

/**
 * Mirrors the previous selection: all sheets in workbook order unless a name
 * is given, hidden sheets included, with the same checks in the same order.
 */
function selectWorksheets(
  job: XlsxJob,
  workbook: WorkbookMeta
): WorksheetSelection | Extract<XlsxOutcome, { ok: false }> {
  const sheetNames = workbook.sheets.map(sheet => sheet.name)
  const namedIndex = job.sheet === null ? null : sheetNames.indexOf(job.sheet)
  if (namedIndex === -1) return { ok: false, reason: 'invalid_range' }
  // A null initial cursor starts the selection; only the parser knows a named
  // sheet's workbook index before a continuation has been issued.
  const { sheetIndex, row } = job.start ?? { sheetIndex: namedIndex ?? 0, row: 1 }
  if (
    !Number.isSafeInteger(sheetIndex) ||
    !Number.isSafeInteger(row) ||
    sheetIndex < 0 ||
    row < 1 ||
    (namedIndex !== null && sheetIndex !== namedIndex)
  ) {
    return { ok: false, reason: 'invalid_range' }
  }
  if (workbook.sheets.length === 0) return { ok: false, reason: 'document_empty' }
  if (sheetIndex >= workbook.sheets.length) return { ok: false, reason: 'invalid_range' }
  return {
    sheetNames,
    sheetIndex,
    row,
    sheets: workbook.sheets.slice(sheetIndex, namedIndex === null ? undefined : sheetIndex + 1),
  }
}

function sheetResult(sheet: MutableSheet): XlsxSheetResult {
  return {
    name: sheet.name,
    startRow: sheet.startRow,
    rows: sheet.rows,
    truncated: sheet.truncated,
    lastRow: sheet.lastRow,
    ...(sheet.skippedCount > 0
      ? { skippedRows: { count: sheet.skippedCount, first: sheet.skippedFirst } }
      : {}),
  }
}

export async function parseXlsx(job: XlsxJob): Promise<XlsxOutcome> {
  if (job.bytes.byteLength > job.limits.maxSourceBytes) {
    return { ok: false, reason: 'document_limits_exceeded', limit: 'source_bytes' }
  }
  // The length guard keeps an empty source from matching the magic vacuously.
  if (
    job.bytes.byteLength >= CFB_MAGIC.length &&
    CFB_MAGIC.every((byte, index) => job.bytes[index] === byte)
  ) {
    return { ok: false, reason: 'document_encrypted' }
  }
  if (!ZIP_MAGIC.every((byte, index) => job.bytes[index] === byte)) {
    return { ok: false, reason: 'document_parse_failed' }
  }
  const zipFailure = checkZipExpansion(job.bytes, job.limits.maxUncompressedBytes)
  if (zipFailure) return zipFailure

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(job.bytes)
  } catch {
    return { ok: false, reason: 'document_parse_failed' }
  }

  try {
    const counter = new InflatedCounter(job.limits.maxUncompressedBytes)
    const workbook = await parseWorkbookMeta(zip, counter)
    const selection = selectWorksheets(job, workbook)
    if ('reason' in selection) return selection
    const styles = await parseStyles(zip, counter)
    const sharedStrings = await parseSharedStrings(zip, counter)
    const window = new SheetWindow(job.limits)
    const sheets: XlsxSheetResult[] = []
    let hasContent = false
    for (let offset = 0; offset < selection.sheets.length; offset += 1) {
      const sheetMeta = selection.sheets[offset]!
      const sheetIndex = selection.sheetIndex + offset
      const startRow = sheetIndex === selection.sheetIndex ? selection.row : 1
      const sheet: MutableSheet = {
        name: sheetMeta.name,
        startRow,
        rows: [],
        truncated: false,
        lastRow: 0,
        skippedCount: 0,
        skippedFirst: [],
      }
      const context: ValueContext = {
        sharedStrings,
        styles,
        date1904: workbook.date1904,
        sharedFormulas: new Map(),
      }
      const merges = await streamSheet(
        zip,
        sheetMeta,
        counter,
        sheet,
        sheetIndex,
        startRow,
        window,
        context
      )
      const emptiedRows = applyMerges(sheet, merges)
      // A merge can leave the last admitted row with no value (only slave
      // cells held one). `lastRow` is unchanged: the stored slave value was
      // already counted for lastRow and the window budget, which is the
      // accepted residual documented above.
      while (sheet.rows.length > 0 && emptiedRows.has(sheet.rows.length - 1)) {
        sheet.rows.pop()
      }
      if (sheet.lastRow > 0) hasContent = true
      if (sheet.rows.length > 0 || job.sheet !== null) sheets.push(sheetResult(sheet))
      if (window.stopped) {
        return {
          ok: true,
          sheetNames: selection.sheetNames,
          sheets,
          next: window.next!,
          stoppedBy: window.stoppedBy!,
        }
      }
    }
    // A selection with no computed values has no content. A named non-empty
    // sheet may still have no rows remaining at its requested cursor.
    if (!hasContent) return { ok: false, reason: 'document_empty' }
    // Continuations always name an existing row, so a start past the last
    // computed value of the selection is a cursor this tool never issued.
    if (window.rowCount === 0) return { ok: false, reason: 'invalid_range' }
    return { ok: true, sheetNames: selection.sheetNames, sheets }
  } catch (error) {
    if (error instanceof InflatedLimitError) {
      return { ok: false, reason: 'document_limits_exceeded', limit: 'uncompressed_bytes' }
    }
    if (error instanceof UnreadableCellError || error instanceof UnreadablePartError) {
      return { ok: false, reason: 'document_parse_failed' }
    }
    throw error
  }
}
