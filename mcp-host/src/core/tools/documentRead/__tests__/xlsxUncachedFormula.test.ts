/**
 * One formula without a cached result in a selected sheet (openpyxl never
 * writes cached results) must not change how a large sheet is read (zach88
 * R2-M1). On 2398ff993..e7fa6846f it triggered a second raw-XML pass that
 * loaded the whole archive and built the full sheet XML as one string, and a
 * 150k-row sheet then failed as `document_limits_exceeded` / `heap`.
 */
import { describe, expect, it } from 'vitest'
import type { XlsxJob, XlsxOutcome } from '../types'
import { runDocumentJob } from '../workerRunner'
import { documentLimits } from './fixtures'
import { streamingWorkbook } from './memoryFixtures'

function job(bytes: Buffer): XlsxJob {
  return {
    kind: 'xlsx',
    bytes: new Uint8Array(bytes),
    sheet: null,
    start: null,
    limits: documentLimits({
      maxRowsPerCall: 5_000,
      maxCellsPerCall: 100_000,
      maxExtractedChars: 400_000,
      timeoutMs: 60_000,
      maxHeapMb: 512,
      maxResidentMb: 768,
    }),
  }
}

describe('large XLSX with one uncached formula (R2-M1)', () => {
  it('reads a 150k-row sheet whose F1 formula has no cached result, and continues past it', async () => {
    const bytes = await streamingWorkbook(150_000)
    const first = (await runDocumentJob(job(bytes))) as Extract<XlsxOutcome, { ok: true }>
    expect(first.ok).toBe(true)
    expect(first.sheets[0]!.rows[0]).toEqual([10, 11, 12, 13, 14, '[formula] =1+1'])
    expect(first.sheets[0]!.lastRow).toBe(150_000)
    expect(first.next).toEqual({ sheetIndex: 0, row: 5_001 })

    // The continuation re-reads the same part; the formula pass used to repeat
    // on every call.
    const second = (await runDocumentJob({ ...job(bytes), start: first.next! })) as Extract<
      XlsxOutcome,
      { ok: true }
    >
    expect(second.ok).toBe(true)
    expect(second.sheets[0]!.startRow).toBe(5_001)
    expect(second.sheets[0]!.rows[0]).toEqual([50_010, 50_011, 50_012, 50_013, 50_014, 50_015])
  }, 120_000)
})
