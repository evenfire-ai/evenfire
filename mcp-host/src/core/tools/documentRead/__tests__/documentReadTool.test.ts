import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from '../../../../server/types'
import { AttachmentReadLedger } from '../../../attachments/attachmentReadBudget'
import type { ExecutionContext } from '../../../interfaces'
import type { RedactionRange } from '../../../safety/safety'
import type { Attachment, ToolOutput } from '../../../types'
import type { AttachmentReadRedactor } from '../../attachmentRead'
import { DocumentReadTool } from '../index'
import type {
  DocumentJob,
  DocumentReadLimits,
  PdfTextOutcome,
  RunDocumentJob,
  XlsxOutcome,
} from '../types'
import { runDocumentJob } from '../workerRunner'
import {
  admittedFile,
  documentLimits,
  imageOnlyPdf,
  surrogateWorkbook,
  valuesWorkbook,
  witnessCode,
} from './fixtures'

const WINDOW_TOKENS = 20_000
const measureResult = (raw: string): number => Math.ceil(Buffer.byteLength(raw, 'utf8') / 4) + 4

function messageFor(attachments: Attachment[]): IncomingMessage {
  return {
    content: 'Read the attached document',
    channelType: 'rpc',
    channelId: 'document-agent',
    sender: 'user-document',
    timestamp: '2026-10-13T10:00:00Z',
    messageId: 'message-document',
    hostRef: 'host-document',
    attachments,
  }
}

function executionContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return { onOutput: () => undefined, measureResult, ...overrides }
}

function fakeRunner(outcome: unknown): {
  runJob: RunDocumentJob
  calls: DocumentJob[]
} {
  const calls: DocumentJob[] = []
  const runJob: RunDocumentJob = async job => {
    calls.push(job)
    return outcome as never
  }
  return { runJob, calls }
}

function toolFor(
  attachments: Attachment[],
  runJob: RunDocumentJob,
  options: {
    ledger?: AttachmentReadLedger
    limits?: DocumentReadLimits
    redactor?: AttachmentReadRedactor
  } = {}
): DocumentReadTool {
  return new DocumentReadTool(messageFor(attachments), {
    contextWindowTokens: WINDOW_TOKENS,
    ledger: options.ledger ?? new AttachmentReadLedger(),
    redactor:
      options.redactor ??
      ({ toolOutputRedactionRanges: () => [] } satisfies AttachmentReadRedactor),
    runJob,
    limits: options.limits ?? documentLimits(),
  })
}

async function read(
  tool: DocumentReadTool,
  params: Record<string, unknown>,
  context: Partial<ExecutionContext> = {}
): Promise<{ output: ToolOutput; body: Record<string, unknown> }> {
  const output = await tool.execute(params, executionContext(context))
  return { output, body: JSON.parse(output.content) as Record<string, unknown> }
}

function visualContext(supported: boolean): Partial<ExecutionContext> {
  return {
    visualInput: {
      budget: {} as never,
      resolveCapability: async () =>
        supported
          ? {
              status: 'supported',
              provider: 'fixture-provider',
              model: 'fixture-model',
              evidence: 'unit fixture',
              deliveryLimits: {
                maxImages: 4,
                maxVisualRequestBytes: 32_000_000,
                maxDimension: 1_024,
                maxPixels: 4_000_000,
              },
            }
          : { status: 'unsupported' },
    },
  }
}

function maskProvider(...values: string[]): AttachmentReadRedactor {
  return {
    toolOutputRedactionRanges(toolName: string, content: string): RedactionRange[] {
      if (toolName !== 'clerum__document_read') return []
      return values.flatMap(value => {
        const start = content.indexOf(value)
        return start < 0 ? [] : [{ start, end: start + value.length, replacement: '[MASKED]' }]
      })
    },
  }
}

describe('DocumentReadTool dispatch and identity', () => {
  it('rejects cross-format arguments and reads an admitted PDF as a control', async () => {
    const workbookBytes = await valuesWorkbook(witnessCode())
    const pdf = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const workbook = admittedFile(
      'xlsx-file',
      workbookBytes,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    expect(pdf.fileReference?.reader).toBe('pdf')
    expect(workbook.fileReference?.reader).toBe('xlsx')
    const { runJob, calls } = fakeRunner({
      ok: true,
      pageCount: 1,
      pages: [{ page: 1, text: 'text', from: 0, to: 4, lowText: false }],
    })
    const tool = toolFor([pdf, workbook], runJob)
    expect(tool.name()).toBe('clerum__document_read')
    expect(tool.requiresSanitization()).toBe(true)
    expect(tool.requiresApproval()).toBe(false)
    expect(tool.spilloverExempt()).toBe(true)

    const pdfWithSheet = await read(tool, { attachmentId: 'pdf-file', sheet: 'Values' })
    const xlsxWithPages = await read(tool, {
      attachmentId: 'xlsx-file',
      pages: '1',
      mode: 'text',
    })
    expect(pdfWithSheet.body).toMatchObject({ status: 'error', reason: 'invalid_range' })
    expect(xlsxWithPages.body).toMatchObject({ status: 'error', reason: 'invalid_range' })
    expect(calls).toHaveLength(0)
    await expect(read(tool, { attachmentId: 'pdf-file' })).resolves.toMatchObject({
      body: { status: 'ok', format: 'pdf', mode: 'text' },
    })
  })

  it('rejects foreign, crossed and visual cursors before dispatching a job', async () => {
    const pdf = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const { runJob, calls } = fakeRunner({ ok: true, pageCount: 1, pages: [] })
    const tool = toolFor([pdf], runJob)
    for (const cursor of ['not-a-cursor', 'v1.xlsx.0.1', 'v1.pdf.0.0']) {
      const result = await read(tool, { attachmentId: 'pdf-file', cursor })
      expect(result.body).toMatchObject({ status: 'error', reason: 'invalid_range' })
    }
    const visual = await read(tool, {
      attachmentId: 'pdf-file',
      mode: 'visual',
      cursor: 'v1.pdf.1.0',
    })
    expect(visual.body).toMatchObject({ status: 'error', reason: 'invalid_range' })
    expect(calls).toHaveLength(0)
  })

  it('reports access failures and proves that an admitted read succeeds on the same path', async () => {
    const file = admittedFile(
      'file-1',
      await valuesWorkbook(witnessCode()),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    const missing = { ...file, id: 'missing' }
    const { runJob } = fakeRunner({
      ok: true,
      sheetNames: ['Values'],
      sheets: [{ name: 'Values', startRow: 1, rows: [['value']], truncated: false }],
    })
    const tool = toolFor([file, missing], runJob)
    const unknown = await read(tool, { attachmentId: 'absent' })
    expect(unknown.output.is_error).toBe(true)
    expect(unknown.body.error).toBe('attachment_not_found')

    const text = { ...file, fileReference: { ...file.fileReference!, reader: 'text' as const } }
    const wrongReader = await read(toolFor([text], runJob), { attachmentId: 'file-1' })
    expect(wrongReader.body.error).toBe('not_a_document')
    const control = await read(tool, { attachmentId: 'file-1' })
    expect(control.body).toMatchObject({
      status: 'ok',
      attachmentId: 'file-1',
      referenceId: file.fileReference!.id,
    })
  })
})

describe('DocumentReadTool visual mode', () => {
  const visualOutcome = {
    ok: true,
    pageCount: 1,
    images: [{ page: 1, width: 64, height: 64, png: new Uint8Array([1, 2, 3]) }],
  }

  it('refuses an unsupported model and returns typed images for a capable model', async () => {
    const file = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const unsupportedRunner = fakeRunner(visualOutcome)
    const unsupported = await read(
      toolFor([file], unsupportedRunner.runJob),
      { attachmentId: 'pdf-file', mode: 'visual' },
      visualContext(false)
    )
    expect(unsupported.body).toMatchObject({ status: 'error', reason: 'visual_not_supported' })
    expect(unsupportedRunner.calls).toHaveLength(0)

    const supportedRunner = fakeRunner(visualOutcome)
    const supported = await read(
      toolFor([file], supportedRunner.runJob),
      { attachmentId: 'pdf-file', mode: 'visual' },
      visualContext(true)
    )
    expect(supported.body).toEqual({
      status: 'ok',
      attachmentId: 'pdf-file',
      referenceId: file.fileReference!.id,
      format: 'pdf',
      mode: 'visual',
      pageCount: 1,
      images: [{ page: 1, width: 64, height: 64 }],
    })
    expect(supported.output.attachments).toEqual([
      expect.objectContaining({
        id: `clerum__document_read:${file.fileReference!.id}:page-1`,
        kind: 'image',
        mimeType: 'image/png',
        sourceTool: 'clerum__document_read',
      }),
    ])
    expect(supportedRunner.calls[0]).toMatchObject({ kind: 'pdf_visual', maxDimension: 1_024 })
  })

  it('offers low-text visual candidates only when image input is supported', async () => {
    const outcome: PdfTextOutcome = {
      ok: true,
      pageCount: 1,
      pages: [{ page: 1, text: 'short', from: 0, to: 5, lowText: true }],
    }
    const file = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const unsupported = await read(toolFor([file], fakeRunner(outcome).runJob), {
      attachmentId: 'pdf-file',
    })
    expect(unsupported.body).toMatchObject({ status: 'ok' })
    expect(unsupported.body.visualCandidates).toBeUndefined()
    const supported = await read(
      toolFor([file], fakeRunner(outcome).runJob),
      { attachmentId: 'pdf-file' },
      visualContext(true)
    )
    expect(supported.body).toMatchObject({ status: 'ok', visualCandidates: [1] })
  })
})

describe('DocumentReadTool budgets', () => {
  const textOutcome: PdfTextOutcome = {
    ok: true,
    pageCount: 1,
    pages: [{ page: 1, text: 'p'.repeat(24_000), from: 0, to: 24_000, lowText: false }],
  }

  it('names the page budget on a fresh ledger', async () => {
    const file = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const result = await read(toolFor([file], fakeRunner(textOutcome).runJob), {
      attachmentId: 'pdf-file',
    })
    expect(result.body.status).toBe('ok')
    expect(result.body.continuation).toMatchObject({ limit: 'page_budget' })
    expect(result.body.pages).toHaveLength(1)
  })

  it('names the turn budget when only a sub-page allowance remains', async () => {
    const file = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const ledger = new AttachmentReadLedger()
    // The allowance used by fit depends on the exact notice estimate. Spend
    // all but 100 tokens of that same allowance, so a partial page must be
    // selected and the limit must name the turn, not the page.
    const notice = measureResult(
      JSON.stringify({
        status: 'read_budget_exhausted',
        attachmentId: 'pdf-file',
        referenceId: file.fileReference!.id,
        message:
          'The current-turn attachment read budget is exhausted. Reattach the file in a new message and pass resumeCursor as cursor to continue; earlier pages are not stored for re-reading.',
      })
    )
    ledger.restore({ reads: 1, spentTokens: 0, bytesRead: 0 })
    const allowanceAtZero = ledger.pageAllowance(WINDOW_TOKENS, notice)
    const spent = Math.max(0, allowanceAtZero - 100)
    ledger.restore({ reads: 1, spentTokens: spent, bytesRead: 0 })
    const result = await read(toolFor([file], fakeRunner(textOutcome).runJob, { ledger }), {
      attachmentId: 'pdf-file',
    })
    expect(result.body.continuation).toMatchObject({ limit: 'turn_budget' })
    expect(ledger.snapshot().reads).toBe(2)
  })

  it('returns a resumeCursor exhaustion notice without dispatching, with a fresh-ledger witness', async () => {
    const file = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const ledger = new AttachmentReadLedger()
    ledger.restore({ reads: 32, spentTokens: 0, bytesRead: 0 })
    const { runJob, calls } = fakeRunner(textOutcome)
    const exhausted = await read(toolFor([file], runJob, { ledger }), {
      attachmentId: 'pdf-file',
      cursor: 'v1.pdf.1.10',
    })
    expect(exhausted.body).toEqual({
      status: 'read_budget_exhausted',
      attachmentId: 'pdf-file',
      referenceId: file.fileReference!.id,
      resumeCursor: 'v1.pdf.1.10',
      message: expect.stringMatching(/new message/i),
    })
    expect(calls).toHaveLength(0)
    expect(ledger.snapshot().reads).toBe(32)
    const witness = await read(toolFor([file], fakeRunner(textOutcome).runJob), {
      attachmentId: 'pdf-file',
    })
    expect(witness.body.status).toBe('ok')
  })
})

describe('DocumentReadTool configured masking', () => {
  it('applies the Tool cell cap after whole-value redaction and preserves surrogate pairs', async () => {
    const value = `a😀${'b'.repeat(12)}`
    const file = admittedFile(
      'xlsx-file',
      await surrogateWorkbook(value),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    const outcome: XlsxOutcome = {
      ok: true,
      sheetNames: ['Characters'],
      sheets: [{ name: 'Characters', startRow: 1, rows: [[value]], truncated: false }],
    }
    const result = await read(
      toolFor([file], fakeRunner(outcome).runJob, {
        limits: documentLimits({ maxCellChars: 3 }),
      }),
      { attachmentId: 'xlsx-file' }
    )
    expect(result.body).toMatchObject({
      status: 'ok',
      sheets: [{ rows: [['a…']] }],
    })
    expect(result.output.content).not.toContain('\ud83d')
  })

  it('masks configured values in PDF text, XLSX cells and sheet names', async () => {
    const configured = 'fixture-configured-value'
    const redactor = maskProvider(configured)
    const pdfFile = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const workbookFile = admittedFile(
      'file-1',
      await valuesWorkbook(configured),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    const pdfOutcome: PdfTextOutcome = {
      ok: true,
      pageCount: 1,
      pages: [{ page: 1, text: `before ${configured} after`, from: 0, to: 48, lowText: false }],
    }
    const pdf = await read(toolFor([pdfFile], fakeRunner(pdfOutcome).runJob, { redactor }), {
      attachmentId: 'pdf-file',
    })
    expect(JSON.parse(pdf.output.content)).toMatchObject({
      pages: [{ text: 'before [MASKED] after' }],
    })
    expect(pdf.output.content).not.toContain(configured)

    const xlsxOutcome: XlsxOutcome = {
      ok: true,
      sheetNames: [`sheet ${configured}`],
      sheets: [
        {
          name: `sheet ${configured}`,
          startRow: 1,
          rows: [[configured, 'plain']],
          truncated: false,
        },
      ],
    }
    const workbook = await read(
      toolFor([workbookFile], fakeRunner(xlsxOutcome).runJob, { redactor }),
      { attachmentId: 'file-1' }
    )
    expect(workbook.body).toMatchObject({
      sheetNames: ['sheet [MASKED]'],
      sheets: [{ name: 'sheet [MASKED]', rows: [['[MASKED]', 'plain']] }],
    })
    expect(workbook.output.content).not.toContain(configured)
  })
})

describe('DocumentReadTool with the real worker', () => {
  it('walks XLSX continuations and returns the body-only random code by the parser path', async () => {
    const code = witnessCode()
    const file = admittedFile(
      'xlsx-file',
      await valuesWorkbook(code),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    const tool = toolFor([file], runDocumentJob, {
      limits: documentLimits({ maxRowsPerCall: 1 }),
    })
    const first = await read(tool, { attachmentId: 'xlsx-file' })
    expect(first.body).toMatchObject({
      status: 'ok',
      attachmentId: 'xlsx-file',
      referenceId: file.fileReference!.id,
      format: 'xlsx',
      sheetNames: ['Values', 'Hidden'],
      sheets: [{ name: 'Values', startRow: 1, rows: [[code, 42, true]], truncated: true }],
      continuation: { cursor: 'v1.xlsx.0.2', limit: 'max_rows' },
    })
    const second = await read(tool, {
      attachmentId: 'xlsx-file',
      cursor: (first.body.continuation as { cursor: string }).cursor,
    })
    expect(second.body.sheets).toEqual([
      { name: 'Values', startRow: 2, rows: [['formula-zero', 0, false]], truncated: true },
    ])
    expect(second.body.continuation).toEqual({
      cursor: 'v1.xlsx.0.3',
      limit: 'max_rows',
    })
  })
})
