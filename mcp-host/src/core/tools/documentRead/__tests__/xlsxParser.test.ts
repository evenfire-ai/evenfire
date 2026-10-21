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
  sheetXmlWorkbook,
  surrogateWorkbook,
  valuesWorkbook,
  wideWorkbook,
  witnessCode,
} from './fixtures'
import { streamingWorkbook } from './memoryFixtures'

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

  it('skips a first row that alone exceeds maxExtractedChars as [] and keeps its neighbours', async () => {
    const limits = documentLimits({ maxExtractedChars: 100 })
    const outcome = await runDocumentJob(
      xlsxJob(await textWorkbook([['y'.repeat(200)], ['short']]), { limits })
    )
    expect(outcome).toEqual({
      ok: true,
      sheetNames: ['Text'],
      sheets: [
        {
          name: 'Text',
          startRow: 1,
          rows: [[], ['short']],
          truncated: false,
          lastRow: 2,
          skippedRows: { count: 1, first: [1] },
        },
      ],
    })

    // Witness: a narrow first row keeps its value and the wide second row
    // occupies its slot as []; neither row makes the read terminal.
    const narrow = await runDocumentJob(
      xlsxJob(await textWorkbook([['short'], ['y'.repeat(200)]]), { limits })
    )
    expect(narrow).toEqual({
      ok: true,
      sheetNames: ['Text'],
      sheets: [
        {
          name: 'Text',
          startRow: 1,
          rows: [['short'], []],
          truncated: false,
          lastRow: 2,
          skippedRows: { count: 1, first: [2] },
        },
      ],
    })
  })
})

describe('XLSX wide rows are non-terminal (zach88 M2)', () => {
  it('keeps the neighbours of a wide interior row and names it', async () => {
    const limits = documentLimits({ maxExtractedChars: 100 })
    const outcome = (await runDocumentJob(
      xlsxJob(await textWorkbook([['before'], ['y'.repeat(200)], ['after']]), { limits })
    )) as Extract<XlsxOutcome, { ok: true }>
    expect(outcome.ok).toBe(true)
    expect(outcome.sheets).toEqual([
      {
        name: 'Text',
        startRow: 1,
        rows: [['before'], [], ['after']],
        truncated: false,
        lastRow: 3,
        skippedRows: { count: 1, first: [2] },
      },
    ])
    expect(outcome.next).toBeUndefined()
    expect(outcome.stoppedBy).toBeUndefined()
  })

  it('returns only [] slots when every row is wide, with the full count', async () => {
    const limits = documentLimits({ maxExtractedChars: 100 })
    const wide = [['y'.repeat(200)], ['z'.repeat(200)], ['w'.repeat(200)]]
    const outcome = (await runDocumentJob(
      xlsxJob(await textWorkbook(wide), { limits })
    )) as Extract<XlsxOutcome, { ok: true }>
    expect(outcome.ok).toBe(true)
    expect(outcome.sheets).toEqual([
      {
        name: 'Text',
        startRow: 1,
        rows: [[], [], []],
        truncated: false,
        lastRow: 3,
        skippedRows: { count: 3, first: [1, 2, 3] },
      },
    ])
    expect(outcome.next).toBeUndefined()
    expect(outcome.stoppedBy).toBeUndefined()
  })
})

describe('XLSX streaming read (zach88 M1)', () => {
  it('reads a 150k-row window without holding the sheet and reports lastRow', async () => {
    const rowCount = 150_000
    const bytes = await streamingWorkbook(rowCount)
    const limits = documentLimits({
      maxRowsPerCall: 5_000,
      maxCellsPerCall: 100_000,
      maxExtractedChars: 400_000,
      timeoutMs: 30_000,
      maxHeapMb: 512,
      maxResidentMb: 768,
    })
    const before = process.memoryUsage().rss
    const outcome = (await runDocumentJob(xlsxJob(bytes, { limits }))) as Extract<
      XlsxOutcome,
      { ok: true }
    >
    const after = process.memoryUsage().rss
    expect(outcome.ok).toBe(true)
    expect(outcome.sheets[0]!.lastRow).toBe(rowCount)
    expect(outcome.sheets[0]!.rows).toHaveLength(5_000)
    expect(outcome.sheets[0]!.rows[0]).toEqual([10, 11, 12, 13, 14, '[formula] =1+1'])
    expect(outcome.sheets[0]!.rows[4_999]).toEqual([50_000, 50_001, 50_002, 50_003, 50_004, 50_005])
    expect(outcome.next).toEqual({ sheetIndex: 0, row: 5_001 })
    expect(outcome.stoppedBy).toBe('max_rows')
    // The Host sees only the window: the sheet itself never enters its heap.
    expect(after - before).toBeLessThanOrEqual(32 * 1_048_576)
    process.stdout.write(
      'XLSX 150k Host RSS witness ' +
        JSON.stringify({
          before,
          after,
          growth: after - before,
          bound: 32 * 1_048_576,
        }) +
        '\n'
    )
  }, 60_000)
})

describe('XLSX writer dialects', () => {
  const worksheet = (rows: string): string =>
    '<?xml version="1.0"?><worksheet ' +
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    rows +
    '</sheetData></worksheet>'

  it('reads a t="d" ISO date and rejects an invalid one with a valid control', async () => {
    const valid = await parseDirect(
      await sheetXmlWorkbook(
        worksheet(
          '<row r="1"><c r="A1" t="d"><v>2026-01-02T03:04:05.000Z</v></c>' +
            '<c r="B1"><v>42</v></c></row>'
        )
      )
    )
    expect(valid).toEqual({
      ok: true,
      sheetNames: ['Sheet1'],
      sheets: [
        {
          name: 'Sheet1',
          startRow: 1,
          rows: [['2026-01-02T03:04:05.000Z', 42]],
          truncated: false,
          lastRow: 1,
        },
      ],
    })
    const invalid = await parseDirect(
      await sheetXmlWorkbook(worksheet('<row r="1"><c r="A1" t="d"><v>not-a-date</v></c></row>'))
    )
    expect(invalid).toEqual({ ok: false, reason: 'document_parse_failed' })
  })

  it('reads rows and cells without r as sequential', async () => {
    const outcome = await parseDirect(
      await sheetXmlWorkbook(
        worksheet(
          '<row><c><v>1</v></c><c><v>2</v></c></row>' + '<row><c t="str"><v>x</v></c></row>'
        )
      )
    )
    expect(outcome).toEqual({
      ok: true,
      sheetNames: ['Sheet1'],
      sheets: [
        {
          name: 'Sheet1',
          startRow: 1,
          rows: [[1, 2], ['x']],
          truncated: false,
          lastRow: 2,
        },
      ],
    })
  })

  it('selects a 32-character sheet name exactly', async () => {
    const name = 'S'.repeat(32)
    const bytes = await sheetXmlWorkbook(
      worksheet('<row r="1"><c r="A1" t="str"><v>value</v></c></row>'),
      name
    )
    expect(await parseDirect(bytes, { sheet: name })).toEqual({
      ok: true,
      sheetNames: [name],
      sheets: [
        {
          name,
          startRow: 1,
          rows: [['value']],
          truncated: false,
          lastRow: 1,
        },
      ],
    })
  })

  it('rejects a non-increasing row number with a readable control', async () => {
    const outOfOrder = await parseDirect(
      await sheetXmlWorkbook(
        worksheet(
          '<row r="2"><c r="A2"><v>2</v></c></row>' + '<row r="1"><c r="A1"><v>1</v></c></row>'
        )
      )
    )
    expect(outOfOrder).toEqual({ ok: false, reason: 'document_parse_failed' })
    const control = await parseDirect(
      await sheetXmlWorkbook(
        worksheet(
          '<row r="1"><c r="A1"><v>1</v></c></row>' + '<row r="2"><c r="A2"><v>2</v></c></row>'
        )
      )
    )
    expect(control).toMatchObject({
      ok: true,
      sheets: [{ rows: [[1], [2]] }],
    })
  })
})
