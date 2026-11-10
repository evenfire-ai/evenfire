/**
 * Rows that are wide in the child's budget (zach88 R2-M2, R1-M6): a wide row
 * is skipped and named, never terminal, so the rows after it stay reachable.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { IncomingMessage } from '../../../../server/types'
import { AttachmentReadLedger } from '../../../attachments/attachmentReadBudget'
import type { ExecutionContext } from '../../../interfaces'
import { OpenAITokenCounter } from '../../../tokenizer/openaiTokenCounter'
import { DocumentReadTool } from '../index'
import { runDocumentJob } from '../workerRunner'
import { admittedFile, documentLimits } from './fixtures'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const counter = new OpenAITokenCounter('gpt-4o-mini')
const CONTEXT_WINDOWS = [128_000, 200_000]

function toolFor(
  bytes: Buffer,
  contextWindowTokens: number,
  limits = documentLimits()
): { tool: DocumentReadTool; file: ReturnType<typeof admittedFile> } {
  const file = admittedFile('wide-file', bytes, XLSX_MIME)
  const message: IncomingMessage = {
    content: 'Read the attached workbook',
    channelType: 'rpc',
    channelId: 'document-agent',
    sender: 'user-document',
    timestamp: '2026-10-21T10:00:00Z',
    messageId: 'message-row-width',
    hostRef: 'host-document',
    attachments: [file],
  }
  const tool = new DocumentReadTool(message, {
    contextWindowTokens,
    ledger: new AttachmentReadLedger(),
    redactor: { toolOutputRedactionRanges: () => [] },
    runJob: runDocumentJob,
    limits,
  })
  return { tool, file }
}

async function read(
  tool: DocumentReadTool,
  params: Record<string, unknown>
): Promise<Record<string, any>> {
  const context: ExecutionContext = {
    onOutput: () => undefined,
    measureResult: raw => counter.countSync([{ role: 'tool', content: raw }]),
  }
  const output = await tool.execute(params, context)
  return JSON.parse(output.content) as Record<string, any>
}

async function workbook(fill: (sheet: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  fill(book.addWorksheet('Data'))
  return Buffer.from(await book.xlsx.writeBuffer())
}

beforeAll(async () => {
  await counter.warmup()
})

const longCell = (index: number): string => String.fromCharCode(97 + index).repeat(32_767)

describe('XLSX rows wide in the reader child (R2-M2)', () => {
  it('13 cells of 32,767 characters skip that row and keep every other row readable', async () => {
    // Excel's maximum cell length: 13 of them serialize to about 426k
    // characters, over the 400k per-call budget the child applies to untrimmed
    // values. On e7fa6846f the second call failed as row_width and rows 3-4
    // were unreachable; if it had been row 1 the whole sheet was unreadable.
    const bytes = await workbook(sheet => {
      sheet.addRow(['header'])
      sheet.addRow(Array.from({ length: 13 }, (_, index) => longCell(index)))
      sheet.addRow(['after'])
      sheet.addRow(['tail'])
    })
    for (const window of CONTEXT_WINDOWS) {
      const { tool, file } = toolFor(bytes, window)
      const body = await read(tool, { attachmentId: file.id })
      expect(body.status).toBe('ok')
      expect(body.continuation).toBeUndefined()
      expect(body.sheets).toEqual([
        {
          name: 'Data',
          startRow: 1,
          rows: [['header'], [], ['after'], ['tail']],
          truncated: false,
          lastRow: 4,
          skippedRows: { count: 1, first: [2] },
        },
      ])
    }
  }, 60_000)

  it('a wide first row does not make the sheet unreadable', async () => {
    const bytes = await workbook(sheet => {
      sheet.addRow(Array.from({ length: 13 }, (_, index) => longCell(index)))
      sheet.addRow(['second'])
    })
    const { tool, file } = toolFor(bytes, 200_000)
    const body = await read(tool, { attachmentId: file.id })
    expect(body.status).toBe('ok')
    expect(body.sheets[0]).toMatchObject({
      startRow: 1,
      rows: [[], ['second']],
      skippedRows: { count: 1, first: [1] },
    })
  }, 60_000)

  it('control: 12 of those cells fit the budget and arrive cut to the Tool cell cap', async () => {
    // The boundary is the child's character budget, not the cells or the sheet.
    const bytes = await workbook(sheet => {
      sheet.addRow(['header'])
      sheet.addRow(Array.from({ length: 12 }, (_, index) => longCell(index)))
      sheet.addRow(['after'])
    })
    const { tool, file } = toolFor(bytes, 200_000)
    const body = await read(tool, { attachmentId: file.id })
    expect(body.status).toBe('ok')
    expect(body.sheets[0].skippedRows).toBeUndefined()
    expect(body.sheets[0].rows[1]).toHaveLength(12)
    for (const cell of body.sheets[0].rows[1]) expect(cell.length).toBeLessThanOrEqual(2_000)
    expect(body.sheets[0].rows[2]).toEqual(['after'])
  }, 60_000)
})

describe('XLSX stray far-column cell (R1-M6)', () => {
  const stray = async (): Promise<Buffer> =>
    workbook(sheet => {
      sheet.getCell('A1').value = 'one'
      sheet.getCell('A2').value = 'two'
      sheet.getCell('XFD2').value = 'stray'
      sheet.getCell('A3').value = 'three'
    })

  it('A1, A2, XFD2, A3: the row after the stray cell is readable at 128k and 200k', async () => {
    // On e7fa6846f the second call returned row_width because row 2 serialized
    // 16,384 entries, and row 3 was never readable at either window.
    const bytes = await stray()
    for (const window of CONTEXT_WINDOWS) {
      const { tool, file } = toolFor(bytes, window)
      const body = await read(tool, { attachmentId: file.id })
      expect(body.status).toBe('ok')
      expect(JSON.stringify(body)).not.toContain('row_width')
      const rows = body.sheets[0].rows
      expect(rows).toHaveLength(3)
      expect(rows[0]).toEqual(['one'])
      expect(rows[2]).toEqual(['three'])
      // Row 2 is delivered in full when its 16,384 entries fit one page, and
      // otherwise named as skipped; it is never silently dropped.
      if (rows[1].length === 0) {
        expect(body.sheets[0].skippedRows).toEqual({ count: 1, first: [2] })
      } else {
        expect(rows[1]).toHaveLength(16_384)
        expect(rows[1][0]).toBe('two')
        expect(rows[1][16_383]).toBe('stray')
      }
    }
  }, 60_000)

  it('following the continuation cursor reaches row 3', async () => {
    const bytes = await stray()
    const { tool, file } = toolFor(bytes, 128_000, documentLimits({ maxRowsPerCall: 2 }))
    const first = await read(tool, { attachmentId: file.id })
    expect(first.status).toBe('ok')
    expect(first.sheets[0].rows[0]).toEqual(['one'])
    expect(first.continuation?.cursor).toBeDefined()
    const second = await read(tool, { attachmentId: file.id, cursor: first.continuation.cursor })
    expect(second.status).toBe('ok')
    expect(second.sheets[0]).toMatchObject({ startRow: 3, rows: [['three']] })
  }, 60_000)
})

describe('XLSX row width is measured without serializing the row', () => {
  it('a 50 KB file that repeats one long shared string across a row reads, with that row skipped', async () => {
    // One 32,767-character shared string in all 16,384 cells of row 2: the row
    // serializes to about 537 MB. Measuring it with JSON.stringify exceeded
    // V8's maximum string length and the child heap, so the whole call (rows 1
    // and 3 included, on every continuation) failed as `heap`.
    const bytes = await workbook(sheet => {
      sheet.addRow(['head'])
      sheet.addRow(Array.from({ length: 16_384 }, () => longCell(0)))
      sheet.addRow(['after'])
    })
    expect(bytes.length).toBeLessThan(100_000)
    const outcome = await runDocumentJob({
      kind: 'xlsx',
      bytes: new Uint8Array(bytes),
      sheet: null,
      start: null,
      limits: documentLimits(),
    })
    expect(outcome).toEqual({
      ok: true,
      sheetNames: ['Data'],
      sheets: [
        {
          name: 'Data',
          startRow: 1,
          rows: [['head'], [], ['after']],
          truncated: false,
          lastRow: 3,
          skippedRows: { count: 1, first: [2] },
        },
      ],
    })
  }, 60_000)
})
