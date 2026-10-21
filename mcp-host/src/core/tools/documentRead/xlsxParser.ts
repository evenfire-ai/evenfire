/**
 * Pure XLSX parsing for `clerum__document_read`, inside the isolated worker.
 *
 * Numbers, booleans and strings retain their values; empty cells become null.
 * Formulas use cached results, or `[formula] =<formula>` without one (never
 * evaluation); an empty cached string result is an empty cell. Dates become
 * ISO 8601,
 * rich text is concatenated, hyperlinks use display text, and errors use their
 * error strings. ExcelJS resolves shared strings. Merged values appear only
 * on their master cells. Strings are returned whole: the Tool redacts each
 * complete value before applying `maxCellChars`, so a cap never cuts a secret
 * into fragments that no longer match.
 *
 * Rows preserve null gaps and stop at their last non-empty computed cell.
 * Interior empty rows remain; trailing empty rows do not. Paging returns
 * complete rows and charges their full width, including null gaps.
 */
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { SaxesParser } from 'saxes'
import type { XlsxCellValue, XlsxJob, XlsxOutcome, XlsxSheetResult } from './types'
import { checkZipExpansion } from './zipLimits'

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

/**
 * A cell whose stored value has no representation, such as a date-formatted
 * number outside the JavaScript Date range. It is a property of the file, so
 * the call fails as `document_parse_failed` rather than as a worker defect.
 */
class UnreadableCellError extends Error {}

/**
 * A workbook part that cannot be found or parsed while reading cached formula
 * results: a property of the file, like a failed load.
 */
class UnreadablePartError extends Error {}

/** Addresses of formula cells whose cached result is an empty string. */
type EmptyResults = ReadonlySet<string>

const NO_EMPTY_RESULTS: EmptyResults = new Set()

function computedValue(value: ExcelJS.CellValue): XlsxCellValue {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new UnreadableCellError()
    return value.toISOString()
  }
  if ('formula' in value || 'sharedFormula' in value) return computedValue(value.result)
  if ('richText' in value) return value.richText.map(part => part.text).join('') || null
  // A formatted display text is stored as rich text, not as a string.
  if ('hyperlink' in value) return computedValue(value.text)
  if ('error' in value) return value.error
  throw new Error('Unsupported XLSX cell value')
}

function hasNoResult(cell: ExcelJS.Cell): boolean {
  return cell.result === undefined || cell.result === null
}

function cellValue(cell: ExcelJS.Cell, emptyResults: EmptyResults): XlsxCellValue {
  if (cell.isMerged && cell.master !== cell) return null
  // ExcelJS 4.4's formula value getter omits falsy results; the dedicated
  // cached-result getter preserves both 0 and false, including shared formulas.
  if (cell.type === ExcelJS.ValueType.Formula) {
    if (!hasNoResult(cell)) return computedValue(cell.result)
    return emptyResults.has(cell.address) ? null : '[formula] =' + cell.formula
  }
  return computedValue(cell.value)
}

function lastNonEmptyRow(worksheet: ExcelJS.Worksheet, emptyResults: EmptyResults): number {
  let lastRow = 0
  worksheet.eachRow(row => {
    let hasValue = false
    row.eachCell(cell => {
      if (!hasValue && cellValue(cell, emptyResults) !== null) hasValue = true
    })
    if (hasValue) lastRow = row.number
  })
  return lastRow
}

function hasFormulaWithoutResult(worksheet: ExcelJS.Worksheet): boolean {
  let found = false
  worksheet.eachRow(row => {
    row.eachCell(cell => {
      if (!found && cell.type === ExcelJS.ValueType.Formula && hasNoResult(cell)) found = true
    })
  })
  return found
}

async function readPart(
  zip: JSZip,
  path: string,
  listen: (parser: SaxesParser) => void
): Promise<void> {
  const entry = zip.file(path)
  if (!entry) throw new UnreadablePartError()
  let xml: string
  try {
    xml = await entry.async('string')
  } catch {
    throw new UnreadablePartError()
  }
  const parser = new SaxesParser()
  let malformed = false
  parser.on('error', () => {
    malformed = true
  })
  listen(parser)
  parser.write(xml).close()
  if (malformed) throw new UnreadablePartError()
}

/**
 * ExcelJS 4.4 drops an empty cached result (`<v></v>`), so a formula whose
 * result is an empty string looks like one with no cached result at all. The
 * raw sheet XML tells them apart. It follows ExcelJS's own reading: element
 * and attribute names as written, `r` as the cell address, and the sheet part
 * resolved from the workbook relationships the same way. ExcelJS has already
 * loaded these parts with the same XML parser, so a part this scan cannot
 * read means the two readings disagree; it fails as `document_parse_failed`.
 */
async function emptyStringResults(
  bytes: Uint8Array,
  worksheets: readonly ExcelJS.Worksheet[]
): Promise<Map<ExcelJS.Worksheet, EmptyResults>> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(Uint8Array.from(bytes))
  } catch {
    throw new UnreadablePartError()
  }
  const relationIdBySheet = new Map<string, string>()
  await readPart(zip, 'xl/workbook.xml', parser => {
    parser.on('opentag', node => {
      if (node.name !== 'sheet') return
      const name = node.attributes.name
      const relationId = node.attributes['r:id']
      if (typeof name !== 'string' || typeof relationId !== 'string') return
      if (relationIdBySheet.has(name)) throw new UnreadablePartError()
      relationIdBySheet.set(name, relationId)
    })
  })
  const targetByRelation = new Map<string, string>()
  await readPart(zip, 'xl/_rels/workbook.xml.rels', parser => {
    parser.on('opentag', node => {
      if (node.name !== 'Relationship') return
      const id = node.attributes.Id
      const target = node.attributes.Target
      if (typeof id === 'string' && typeof target === 'string') targetByRelation.set(id, target)
    })
  })

  const results = new Map<ExcelJS.Worksheet, EmptyResults>()
  for (const worksheet of worksheets) {
    const relationId = relationIdBySheet.get(worksheet.name)
    const target = relationId === undefined ? undefined : targetByRelation.get(relationId)
    if (target === undefined) throw new UnreadablePartError()
    const refs = new Set<string>()
    let cell: { ref: string | undefined; str: boolean; formula: boolean; value?: string } | null =
      null
    let inValue = false
    await readPart(zip, `xl/${target.replace(/^(\s|\/xl\/)+/, '')}`, parser => {
      parser.on('opentag', node => {
        if (node.name === 'c') {
          const ref = node.attributes.r
          cell = {
            ref: typeof ref === 'string' ? ref : undefined,
            str: node.attributes.t === 'str',
            formula: false,
          }
        } else if (cell && node.name === 'f') {
          cell.formula = true
        } else if (cell && node.name === 'v') {
          cell.value = ''
          inValue = true
        }
      })
      parser.on('text', text => {
        if (cell && inValue) cell.value += text
      })
      parser.on('closetag', node => {
        if (node.name === 'v') inValue = false
        if (node.name !== 'c' || !cell) return
        if (cell.str && cell.formula && cell.value === '') {
          if (cell.ref === undefined) throw new UnreadablePartError()
          refs.add(cell.ref)
        }
        cell = null
      })
    })
    results.set(worksheet, refs)
  }
  return results
}

function readRow(row: ExcelJS.Row | undefined, emptyResults: EmptyResults): XlsxCellValue[] {
  const values: XlsxCellValue[] = []
  row?.eachCell((cell, column) => {
    const value = cellValue(cell, emptyResults)
    if (value === null) return
    while (values.length < column - 1) values.push(null)
    values.push(value)
  })
  return values
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

  const workbook = new ExcelJS.Workbook()
  try {
    // Copy exactly the supplied view, without including its backing buffer's
    // prefix/suffix or allowing the loader to mutate the caller's bytes.
    await workbook.xlsx.load(Uint8Array.from(job.bytes).buffer)
  } catch {
    // The load and an unreadable cell are properties of the file; any other
    // failure while walking a loaded workbook is a defect and crashes the worker.
    return { ok: false, reason: 'document_parse_failed' }
  }
  try {
    const selection = selectWorksheets(job, workbook)
    if ('reason' in selection) return selection
    // Only a formula without a cached result can hide an empty string result.
    const pending = selection.worksheets.filter(hasFormulaWithoutResult)
    const emptyResults =
      pending.length === 0
        ? new Map<ExcelJS.Worksheet, EmptyResults>()
        : await emptyStringResults(job.bytes, pending)
    return readWorkbook(job, selection, emptyResults)
  } catch (error) {
    if (error instanceof UnreadableCellError || error instanceof UnreadablePartError) {
      return { ok: false, reason: 'document_parse_failed' }
    }
    throw error
  }
}

interface WorksheetSelection {
  sheetNames: string[]
  sheetIndex: number
  row: number
  worksheets: ExcelJS.Worksheet[]
}

function selectWorksheets(
  job: XlsxJob,
  workbook: ExcelJS.Workbook
): WorksheetSelection | Extract<XlsxOutcome, { ok: false }> {
  const worksheets = workbook.worksheets
  // Hidden and veryHidden sheets are included in workbook order.
  const sheetNames = worksheets.map(worksheet => worksheet.name)
  const namedIndex = job.sheet === null ? null : sheetNames.indexOf(job.sheet)
  if (namedIndex === -1) return { ok: false, reason: 'invalid_range' }
  // A null initial cursor starts the selection; only the parser knows a
  // named sheet's workbook index before a continuation has been issued.
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
  if (worksheets.length === 0) return { ok: false, reason: 'document_empty' }
  if (sheetIndex >= worksheets.length) return { ok: false, reason: 'invalid_range' }
  return {
    sheetNames,
    sheetIndex,
    row,
    worksheets: worksheets.slice(sheetIndex, namedIndex === null ? undefined : sheetIndex + 1),
  }
}

function readWorkbook(
  job: XlsxJob,
  { sheetNames, sheetIndex, row, worksheets }: WorksheetSelection,
  emptyResults: ReadonlyMap<ExcelJS.Worksheet, EmptyResults>
): XlsxOutcome {
  const selection = worksheets.map((worksheet, offset) => {
    // A sheet that was not scanned has no formula without a cached result.
    const empty = emptyResults.get(worksheet) ?? NO_EMPTY_RESULTS
    return {
      worksheet,
      emptyResults: empty,
      sheetIndex: sheetIndex + offset,
      lastRow: lastNonEmptyRow(worksheet, empty),
    }
  })
  // A selection with no computed values has no content. A named non-empty sheet
  // may still have no rows remaining at its requested cursor.
  if (selection.every(sheet => sheet.lastRow === 0)) {
    return { ok: false, reason: 'document_empty' }
  }

  const sheets: XlsxSheetResult[] = []
  let rowCount = 0
  let cellCount = 0
  // Serialized row size, padding and escapes included, so the outcome the
  // Host receives and measures stays bounded whatever the cells hold.
  let charCount = 0
  for (const selected of selection) {
    const startRow = selected.sheetIndex === sheetIndex ? row : 1
    const sheet: XlsxSheetResult = {
      name: selected.worksheet.name,
      startRow,
      rows: [],
      truncated: false,
      lastRow: selected.lastRow,
    }
    for (let rowNumber = startRow; rowNumber <= selected.lastRow; rowNumber += 1) {
      const values = readRow(selected.worksheet.findRow(rowNumber), selected.emptyResults)
      const rowChars = JSON.stringify(values).length
      // A first row over the character limit can never be returned whole;
      // cells are not cut, because Host redaction needs complete values.
      if (rowCount === 0 && rowChars > job.limits.maxExtractedChars) {
        return { ok: false, reason: 'document_limits_exceeded', limit: 'row_width' }
      }
      // The first row of a call is always returned, so every continuation
      // advances even when one row alone is wider than the cell limit.
      const stoppedBy =
        rowCount >= job.limits.maxRowsPerCall
          ? 'max_rows'
          : rowCount > 0 && cellCount + values.length > job.limits.maxCellsPerCall
            ? 'max_cells'
            : rowCount > 0 && charCount + rowChars > job.limits.maxExtractedChars
              ? 'max_extracted_chars'
              : undefined
      if (stoppedBy) {
        sheet.truncated = true
        if (sheet.rows.length > 0 || job.sheet !== null) sheets.push(sheet)
        return {
          ok: true,
          sheetNames,
          sheets,
          next: { sheetIndex: selected.sheetIndex, row: rowNumber },
          stoppedBy,
        }
      }
      sheet.rows.push(values)
      rowCount += 1
      cellCount += values.length
      charCount += rowChars
    }
    if (sheet.rows.length > 0 || job.sheet !== null) sheets.push(sheet)
  }
  // Continuations always name an existing row, so a start past the last
  // computed value of the selection is a cursor this tool never issued.
  if (rowCount === 0) return { ok: false, reason: 'invalid_range' }
  return { ok: true, sheetNames, sheets }
}
