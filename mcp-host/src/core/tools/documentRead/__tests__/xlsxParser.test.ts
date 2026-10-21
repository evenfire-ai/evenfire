import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { XlsxJob, XlsxOutcome } from '../types'
import { runDocumentJob } from '../workerRunner'
import {
  cachedFormulaWorkbook,
  cfbBytes,
  continuationWorkbook,
  documentLimits,
  emptySelectionWorkbook,
  emptyWorkbook,
  longRunningWorkbook,
  mergedWorkbook,
  outOfRangeNumberWorkbook,
  richHyperlinkWorkbook,
  sheetlessWorkbook,
  surrogateWorkbook,
  valuesWorkbook,
  wideWorkbook,
  witnessCode,
} from './fixtures'

function xlsxJob(bytes: Buffer, overrides: Partial<Omit<XlsxJob, 'kind' | 'bytes'>> = {}): XlsxJob {
  return {
    kind: 'xlsx',
    bytes: new Uint8Array(bytes),
    sheet: null,
    start: null,
    limits: documentLimits({ maxCellsPerCall: 100_000 }),
    ...overrides,
  }
}

async function parseDirect(bytes: Buffer, overrides: Partial<XlsxJob> = {}): Promise<XlsxOutcome> {
  const { parseXlsx } = await import('../xlsxParser')
  return parseXlsx(xlsxJob(bytes, overrides))
}

describe('XLSX parser cell shapes from other writers', () => {
  it('reads a hyperlink whose display text is rich text as its plain text', async () => {
    const outcome = (await runDocumentJob(xlsxJob(await richHyperlinkWorkbook()))) as Extract<
      XlsxOutcome,
      { ok: true }
    >
    expect(outcome).toMatchObject({ ok: true })
    expect(outcome.sheets).toEqual([
      {
        name: 'Links',
        startRow: 1,
        rows: [['bold label', 'after link']],
        truncated: false,
        lastRow: 1,
      },
    ])
  })

  it('fails a date-formatted number outside the Date range as document_parse_failed', async () => {
    // Control: the same number without a date format is read as a number.
    expect(await runDocumentJob(xlsxJob(await outOfRangeNumberWorkbook(false)))).toMatchObject({
      ok: true,
      sheets: [{ name: 'Dates', rows: [[1e20]] }],
    })
    expect(await runDocumentJob(xlsxJob(await outOfRangeNumberWorkbook(true)))).toEqual({
      ok: false,
      reason: 'document_parse_failed',
    })
  })
})

describe('XLSX parser values and selection', () => {
  it('marks uncached and shared formulas as formula text while retaining cached zero and false', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Formulas')
    sheet.getCell('A1').value = { formula: 'SUM(1,2)' }
    sheet.getCell('A2').value = { sharedFormula: 'A1' }
    sheet.getCell('B1').value = { formula: '0', result: 0 }
    sheet.getCell('C1').value = { formula: 'FALSE()', result: false }
    const outcome = await runDocumentJob(xlsxJob(Buffer.from(await workbook.xlsx.writeBuffer())))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('Formula reader failed')
    expect(outcome.sheets[0]?.rows).toEqual([
      ['[formula] =SUM(1,2)', 0, false],
      ['[formula] =SUM(1,2)'],
    ])
  })
  it('returns computed values in workbook order through the real worker', async () => {
    const code = witnessCode()
    const bytes = await valuesWorkbook(code)
    const outcome = (await runDocumentJob(xlsxJob(bytes))) as Extract<XlsxOutcome, { ok: true }>

    expect(outcome.ok).toBe(true)
    expect(outcome.sheetNames).toEqual(['Values', 'Hidden'])
    expect(outcome.sheets).toEqual([
      {
        name: 'Values',
        startRow: 1,
        truncated: false,
        lastRow: 8,
        rows: [
          [code, 42, true],
          ['formula-zero', 0, false],
          ['2026-01-02T03:04:05.000Z'],
          ['rich text'],
          ['Example'],
          ['#DIV/0!'],
          [],
          ['tail'],
        ],
      },
      { name: 'Hidden', startRow: 1, rows: [['hidden cell']], truncated: false, lastRow: 1 },
    ])
    expect(outcome.sheets[0]!.rows).toHaveLength(8)
  })

  it('includes a hidden sheet by name when start is null and selection has only that sheet', async () => {
    const bytes = await valuesWorkbook(witnessCode())
    const outcome = await parseDirect(bytes, { sheet: 'Hidden' })
    expect(outcome).toEqual({
      ok: true,
      sheetNames: ['Values', 'Hidden'],
      sheets: [
        { name: 'Hidden', startRow: 1, rows: [['hidden cell']], truncated: false, lastRow: 1 },
      ],
    })
  })

  // Merged values appear only on their master cell, and a row stops at its
  // last non-empty cell: a trailing merged span adds no width, while an
  // interior one becomes null gaps before the next value.
  it('keeps merged values on the master and nulls the merged span only as an interior gap', async () => {
    const outcome = await parseDirect(await mergedWorkbook())
    expect(outcome).toEqual({
      ok: true,
      sheetNames: ['Merged'],
      sheets: [
        {
          name: 'Merged',
          startRow: 1,
          rows: [['merged value'], ['merged master', null, null, 'after merge']],
          truncated: false,
          lastRow: 2,
        },
      ],
    })
  })

  it('returns an interior empty row and omits trailing empty rows', async () => {
    const workbook = await valuesWorkbook(witnessCode())
    const outcome = (await parseDirect(workbook)) as Extract<XlsxOutcome, { ok: true }>
    const rows = outcome.sheets[0]!.rows
    expect(rows[6]).toEqual([])
    expect(rows[7]).toEqual(['tail'])
    expect(rows).toHaveLength(8)
  })

  it('rejects an unknown sheet with invalid_range and admits the same name as a control', async () => {
    const bytes = await valuesWorkbook(witnessCode())
    expect(await parseDirect(bytes, { sheet: 'Missing' })).toEqual({
      ok: false,
      reason: 'invalid_range',
    })
    expect(await parseDirect(bytes, { sheet: 'Values' })).toMatchObject({ ok: true })
  })
})

describe('XLSX limits and malformed files', () => {
  it('rejects a CFB payload as encrypted while the same parser reads a workbook', async () => {
    const bytes = await valuesWorkbook(witnessCode())
    expect(await parseDirect(cfbBytes())).toEqual({ ok: false, reason: 'document_encrypted' })
    expect(await parseDirect(bytes)).toMatchObject({ ok: true })
  })

  it('distinguishes malformed bytes from an empty workbook with a readable control', async () => {
    expect(await parseDirect(Buffer.from('this is not a zip document'))).toEqual({
      ok: false,
      reason: 'document_parse_failed',
    })
    expect(await parseDirect(await emptyWorkbook())).toEqual({
      ok: false,
      reason: 'document_empty',
    })
    expect(await parseDirect(await valuesWorkbook(witnessCode()))).toMatchObject({ ok: true })
  })

  it('reports an empty selected sheet while reading the populated sheet of the same file', async () => {
    const bytes = await emptySelectionWorkbook(witnessCode())
    expect(await runDocumentJob(xlsxJob(bytes, { sheet: 'Empty' }))).toEqual({
      ok: false,
      reason: 'document_empty',
    })
    expect((await runDocumentJob(xlsxJob(bytes, { sheet: 'Values' }))).ok).toBe(true)
  })

  it('reports a sheetless workbook as empty and reads a normal workbook', async () => {
    expect(await runDocumentJob(xlsxJob(await sheetlessWorkbook()))).toEqual({
      ok: false,
      reason: 'document_empty',
    })
    expect((await runDocumentJob(xlsxJob(await valuesWorkbook(witnessCode())))).ok).toBe(true)
  })

  it('resolves source_bytes before launching a worker while a smaller source succeeds', async () => {
    const bytes = await valuesWorkbook(witnessCode())
    const limited = documentLimits({ maxSourceBytes: bytes.length - 1 })
    expect(await parseDirect(bytes, { limits: limited })).toEqual({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'source_bytes',
    })
    expect(await parseDirect(bytes)).toMatchObject({ ok: true })
  })

  it('returns a complete cell so the Tool can redact before applying its character cap', async () => {
    const value = `a😀${'b'.repeat(12)}`
    const outcome = await parseDirect(await surrogateWorkbook(value), {
      limits: documentLimits({ maxCellChars: 3 }),
    })
    expect(outcome).toMatchObject({ ok: true, sheets: [{ rows: [[value]] }] })
  })
})

describe('XLSX continuation', () => {
  it('continues across sheets by max_rows, and every continuation advances', async () => {
    const bytes = await continuationWorkbook()
    const first = (await runDocumentJob(
      xlsxJob(bytes, { limits: documentLimits({ maxRowsPerCall: 3 }) })
    )) as Extract<XlsxOutcome, { ok: true }>
    expect(first.sheets).toEqual([
      {
        name: 'Alpha',
        startRow: 1,
        rows: [['alpha-1'], ['alpha-2'], ['alpha-3']],
        truncated: true,
        lastRow: 4,
      },
    ])
    expect(first.next).toEqual({ sheetIndex: 0, row: 4 })

    const second = (await runDocumentJob(
      xlsxJob(bytes, {
        limits: documentLimits({ maxRowsPerCall: 3 }),
        start: { sheetIndex: 0, row: 4 },
      })
    )) as Extract<XlsxOutcome, { ok: true }>
    expect(second.sheets).toEqual([
      { name: 'Alpha', startRow: 4, rows: [['alpha-4']], truncated: false, lastRow: 4 },
      {
        name: 'Beta',
        startRow: 1,
        rows: [['beta-1'], ['beta-2']],
        truncated: true,
        lastRow: 3,
      },
    ])
    expect(second.next).toEqual({ sheetIndex: 1, row: 3 })
  })

  it('always returns the first row even when that row alone exceeds max_cells', async () => {
    const bytes = await wideWorkbook()
    const outcome = (await runDocumentJob(
      xlsxJob(bytes, { limits: documentLimits({ maxCellsPerCall: 5 }) })
    )) as Extract<XlsxOutcome, { ok: true }>
    expect(outcome.sheets).toEqual([
      {
        name: 'Wide',
        startRow: 1,
        rows: [
          [
            'first-0',
            'first-1',
            'first-2',
            'first-3',
            'first-4',
            'first-5',
            'first-6',
            'first-7',
            'first-8',
            'first-9',
          ],
        ],
        truncated: true,
        lastRow: 2,
      },
    ])
    expect(outcome.next).toEqual({ sheetIndex: 0, row: 2 })
  })

  it('runs a larger workbook through the worker and reports its own stop reason', async () => {
    const outcome = (await runDocumentJob(
      xlsxJob(await longRunningWorkbook(), {
        limits: documentLimits({ maxRowsPerCall: 7, timeoutMs: 15_000, maxHeapMb: 256 }),
      })
    )) as Extract<XlsxOutcome, { ok: true }>
    expect(outcome.ok).toBe(true)
    expect(outcome.sheets[0]?.rows).toHaveLength(7)
    expect(outcome.sheets[0]?.startRow).toBe(1)
    expect(outcome.next).toEqual({ sheetIndex: 0, row: 8 })
    expect(outcome.stoppedBy).toBe('max_rows')
    // Building and parsing the 400k-cell workbook takes about 1 s alone and
    // several under a full-suite load; the bound is the worker's, not vitest's.
  }, 20_000)
})

describe('XLSX empty cached formula results (zach88 M5)', () => {
  it('reads an empty cached string result as an empty cell through the real worker', async () => {
    const outcome = await runDocumentJob(xlsxJob(await cachedFormulaWorkbook()))
    // The column of empty results below the data adds no rows.
    expect(outcome).toEqual({
      ok: true,
      sheetNames: ['Data'],
      sheets: [
        {
          name: 'Data',
          startRow: 1,
          rows: [['label', null, '[formula] =1+1', 'x']],
          truncated: false,
          lastRow: 1,
        },
      ],
    })
  })

  it('reads a self-closing empty result as an empty cell', async () => {
    const outcome = await parseDirect(
      await cachedFormulaWorkbook(xml => xml.replaceAll('<v></v>', '<v/>'))
    )
    expect(outcome).toMatchObject({
      ok: true,
      sheets: [{ rows: [['label', null, '[formula] =1+1', 'x']] }],
    })
  })
})

async function textWorkbook(rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Text').addRows(rows)
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

describe('XLSX serialized size budget (zach88 H1)', () => {
  it('stops before the row that would take the outcome over maxExtractedChars', async () => {
    const limits = documentLimits()
    const wide = Array.from({ length: 5_000 }, (_, row) =>
      Array.from({ length: 20 }, (_, column) => `${row}:${column}:${'x'.repeat(300)}`)
    )
    const bytes = await textWorkbook(wide)
    const first = (await runDocumentJob(
      xlsxJob(bytes, { limits: { ...limits, timeoutMs: 30_000 } })
    )) as Extract<XlsxOutcome, { ok: true }>
    expect(first.ok).toBe(true)
    expect(first.stoppedBy).toBe('max_extracted_chars')
    const rows = first.sheets[0]!.rows
    // The rows the budget admits, each counted as it serializes.
    const rowChars = rows.reduce((sum, row) => sum + JSON.stringify(row).length, 0)
    expect(rowChars).toBeLessThanOrEqual(limits.maxExtractedChars)
    expect(rowChars + JSON.stringify(wide[rows.length]).length).toBeGreaterThan(
      limits.maxExtractedChars
    )
    // The whole outcome is the rows plus separators and a fixed sheet header.
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(
      limits.maxExtractedChars + rows.length + 512
    )
    expect(first.next).toEqual({ sheetIndex: 0, row: rows.length + 1 })

    const second = (await runDocumentJob(
      xlsxJob(bytes, { start: first.next!, limits: { ...limits, timeoutMs: 30_000 } })
    )) as Extract<XlsxOutcome, { ok: true }>
    expect(second.sheets[0]!.startRow).toBe(rows.length + 1)
    expect(second.sheets[0]!.rows[0]![0]).toBe(wide[rows.length]![0])
  }, 60_000)

  it('refuses a first row that alone exceeds maxExtractedChars as row_width', async () => {
    const limits = documentLimits({ maxExtractedChars: 100 })
    const outcome = await runDocumentJob(
      xlsxJob(await textWorkbook([['y'.repeat(200)], ['short']]), { limits })
    )
    expect(outcome).toEqual({ ok: false, reason: 'document_limits_exceeded', limit: 'row_width' })

    // Witness: a narrow first row under the same limit is read, and the wide
    // second row becomes the continuation.
    const narrow = await runDocumentJob(
      xlsxJob(await textWorkbook([['short'], ['y'.repeat(200)]]), { limits })
    )
    expect(narrow).toMatchObject({
      ok: true,
      sheets: [{ rows: [['short']], truncated: true }],
      next: { sheetIndex: 0, row: 2 },
      stoppedBy: 'max_extracted_chars',
    })
  })
})
