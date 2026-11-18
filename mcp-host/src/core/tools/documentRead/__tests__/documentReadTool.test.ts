import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { IncomingMessage } from '../../../../server/types'
import { VisualInputBudget } from '../../../../visualInput/policy'
import { AttachmentReadLedger } from '../../../attachments/attachmentReadBudget'
import type { ExecutionContext } from '../../../interfaces'
import type { RedactionRange } from '../../../safety/safety'
import type { Attachment, ToolOutput } from '../../../types'
import type { AttachmentReadRedactor } from '../../attachmentRead'
import { DocumentReadTool } from '../index'
import { decodeCursor } from '../selection'
import type {
  DocumentJob,
  DocumentReadLimits,
  PdfTextOutcome,
  RunDocumentJob,
  XlsxCellValue,
  XlsxOutcome,
} from '../types'
import { isJobOutcome, runDocumentJob } from '../workerRunner'
import {
  admittedFile,
  boundCursor,
  documentLimits,
  imageOnlyPdf,
  surrogateWorkbook,
  textPdf,
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

/**
 * A hand-built outcome as the real runner would deliver it: the same contract
 * check runs at the process boundary, so a fixture the child could never
 * produce fails the test instead of reaching the Tool.
 */
function contractOutcome(job: DocumentJob, outcome: unknown): never {
  if (!isJobOutcome(job.kind, outcome)) {
    throw new Error(`Fake ${job.kind} outcome breaks the worker outcome contract`)
  }
  return outcome as never
}

function fakeRunner(outcome: unknown): {
  runJob: RunDocumentJob
  calls: DocumentJob[]
} {
  const calls: DocumentJob[] = []
  const runJob: RunDocumentJob = async job => {
    calls.push(job)
    return contractOutcome(job, outcome)
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
    contextWindowTokens?: number
  } = {}
): DocumentReadTool {
  return new DocumentReadTool(messageFor(attachments), {
    contextWindowTokens: options.contextWindowTokens ?? WINDOW_TOKENS,
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
    requestImages: { images: 0, bytes: 0, maxSide: 0 },
    visualInput: {
      budget: new VisualInputBudget(),
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

  it('R1-M9: the fake runner refuses an outcome the worker contract rejects', async () => {
    const file = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const page = { page: 1, text: 'text', from: 0, lowText: false }
    // A window past the end of its page: the real runner rejects it as a
    // defect, so a fixture like it must never reach the Tool.
    const malformed = fakeRunner({ ok: true, pageCount: 1, pages: [{ ...page, to: 5 }] })
    await expect(
      read(toolFor([file], malformed.runJob), { attachmentId: 'pdf-file' })
    ).rejects.toThrow('Fake pdf_text outcome breaks the worker outcome contract')
    // Control: the same page with its window inside the text is delivered.
    const valid = fakeRunner({ ok: true, pageCount: 1, pages: [{ ...page, to: 4 }] })
    await expect(
      read(toolFor([file], valid.runJob), { attachmentId: 'pdf-file' })
    ).resolves.toMatchObject({ body: { status: 'ok', pages: [{ page: 1, text: 'text' }] } })
  })

  it('rejects foreign, crossed and nonzero visual cursors and accepts a text cursor', async () => {
    const pdf = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const { runJob, calls } = fakeRunner({
      ok: true,
      pageCount: 1,
      pages: [{ page: 1, text: 'text', from: 0, to: 4, lowText: false }],
    })
    const tool = toolFor([pdf], runJob)
    for (const cursor of [
      'not-a-cursor',
      boundCursor('v1.xlsx.0.1', pdf),
      boundCursor('v1.pdf.0.0', pdf),
    ]) {
      const result = await read(tool, { attachmentId: 'pdf-file', cursor })
      expect(result.body).toMatchObject({ status: 'error', reason: 'invalid_range' })
    }
    // A visual read always carries the request image usage; the cursor is
    // refused before the model capability is asked.
    const visual = await read(
      tool,
      { attachmentId: 'pdf-file', mode: 'visual', cursor: boundCursor('v1.pdf.1.1', pdf) },
      { requestImages: { images: 0, bytes: 0, maxSide: 0 } }
    )
    expect(visual.body).toMatchObject({ status: 'error', reason: 'invalid_range' })
    expect(calls).toHaveLength(0)
    expect(
      (await read(tool, { attachmentId: 'pdf-file', cursor: boundCursor('v1.pdf.1.0', pdf) })).body
        .status
    ).toBe('ok')
    expect(calls).toHaveLength(1)
  })

  it('refuses a cursor issued for another document and resumes its own', async () => {
    const codeA = witnessCode()
    const codeB = witnessCode()
    const pdfA = admittedFile(
      'pdf-a',
      await textPdf([`A1 ${codeA}`, `A2 ${codeA}`]),
      'application/pdf'
    )
    const pdfB = admittedFile(
      'pdf-b',
      await textPdf([`B1 ${codeB}`, `B2 ${codeB}`]),
      'application/pdf'
    )
    const tool = toolFor([pdfA, pdfB], runDocumentJob, {
      limits: documentLimits({ maxTextPagesPerCall: 1 }),
    })
    const first = await read(tool, { attachmentId: 'pdf-a' })
    const cursor = (first.body.continuation as { cursor: string }).cursor
    expect(cursor).toBe(boundCursor('v1.pdf.2.0', pdfA))
    const crossed = await read(tool, { attachmentId: 'pdf-b', cursor })
    expect(crossed.body).toMatchObject({ status: 'error', reason: 'invalid_range' })
    // Witness: the same cursor resumes the document it was issued for.
    const resumed = await read(tool, { attachmentId: 'pdf-a', cursor })
    expect(resumed.body).toMatchObject({ status: 'ok', pages: [{ page: 2 }] })
    expect(JSON.stringify(resumed.body.pages)).toContain(`A2 ${codeA}`)
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
      sheets: [{ name: 'Values', startRow: 1, rows: [['value']], truncated: false, lastRow: 1 }],
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
        id: `clerum__document_read:${createHash('sha256').update(file.fileReference!.id).digest('hex')}:page-1`,
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

  it('points a PDF without a text layer to a vision-capable model when the capability has no delivery limits', async () => {
    const file = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const scanned = fakeRunner({ ok: false, reason: 'no_text_layer' })
    const withoutLimits: Partial<ExecutionContext> = {
      visualInput: {
        budget: {} as never,
        resolveCapability: async () =>
          ({
            status: 'supported',
            provider: 'fixture-provider',
            model: 'fixture-model',
            evidence: 'unit fixture',
          }) as never,
      },
    }
    const noProfile = await read(
      toolFor([file], scanned.runJob),
      { attachmentId: 'pdf-file' },
      withoutLimits
    )
    expect(noProfile.body).toMatchObject({ status: 'error', reason: 'no_text_layer' })
    expect(noProfile.body.message).toMatch(/a vision-capable model can read it/)
    // Control: with delivery limits the model is told to use mode "visual".
    const capable = await read(
      toolFor([file], fakeRunner({ ok: false, reason: 'no_text_layer' }).runJob),
      { attachmentId: 'pdf-file' },
      visualContext(true)
    )
    expect(capable.body.message).toMatch(/mode "visual"/)
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

  it('M24: follows text cursors through a page longer than two page budgets without a gap or a repeat', async () => {
    // Position-coded text: any slice of it shows where it was cut. 36,000
    // characters are more than four 2,000-token pages, so every later call
    // starts mid-page, and all but the last still have over a page left.
    const text = Array.from(
      { length: 6_000 },
      (_, index) => `${String(index).padStart(5, '0')} `
    ).join('')
    const file = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const starts: number[] = []
    const runJob: RunDocumentJob = async job => {
      if (job.kind !== 'pdf_text') throw new Error('Only PDF text is read here')
      starts.push(job.start.charOffset)
      // As the child: the whole page text, and the window from the cursor on.
      return contractOutcome(job, {
        ok: true,
        pageCount: 1,
        pages: [{ page: 1, text, from: job.start.charOffset, to: text.length, lowText: false }],
      })
    }
    const tool = toolFor([file], runJob)
    const offsets = [0]
    let cursor: string | undefined
    let emitted = ''
    for (let call = 1; call <= 20; call += 1) {
      const { body } = await read(tool, { attachmentId: 'pdf-file', ...(cursor ? { cursor } : {}) })
      expect(body.status).toBe('ok')
      const [page, ...rest] = body.pages as Array<{ page: number; text: string }>
      expect(rest).toEqual([])
      expect(page?.page).toBe(1)
      const offset = offsets.at(-1)!
      const continuation = body.continuation as { cursor: string; limit: string } | undefined
      if (!continuation) {
        expect(page!.text).toBe(text.slice(offset))
        emitted += page!.text
        break
      }
      expect(continuation.limit).toBe('page_budget')
      const next = decodeCursor(continuation.cursor, file.fileReference!.id)
      if (next?.format !== 'pdf') throw new Error('A PDF read returned a non-PDF cursor')
      expect(next.page).toBe(1)
      // Each cut lies past the previous one, and the page holds exactly the
      // text between the two cursors.
      expect(next.charOffset).toBeGreaterThan(offset)
      expect(page!.text).toBe(text.slice(offset, next.charOffset))
      emitted += page!.text
      offsets.push(next.charOffset)
      cursor = continuation.cursor
    }
    // Witnesses: at least two mid-page continuations were followed, every
    // call resumed where the previous cursor pointed, and the page was read
    // whole.
    expect(offsets.length).toBeGreaterThanOrEqual(3)
    expect(starts).toEqual(offsets)
    expect(emitted).toBe(text)
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
      cursor: boundCursor('v1.pdf.1.10', file),
    })
    expect(exhausted.body).toEqual({
      status: 'read_budget_exhausted',
      attachmentId: 'pdf-file',
      referenceId: file.fileReference!.id,
      resumeCursor: boundCursor('v1.pdf.1.10', file),
      message: expect.stringMatching(/new message/i),
    })
    expect(calls).toHaveLength(0)
    expect(ledger.snapshot().reads).toBe(32)
    const witness = await read(toolFor([file], fakeRunner(textOutcome).runJob), {
      attachmentId: 'pdf-file',
    })
    expect(witness.body.status).toBe('ok')
  })

  describe('an XLSX row wider than one page', () => {
    const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    // 10 cells at the 2000-character cell cap: about 5000 tokens, above the
    // 2000-token page of a 20k window.
    const wideRow = Array.from({ length: 10 }, () => 'w'.repeat(2_000))
    const xlsx = (
      rows: XlsxCellValue[][],
      skippedRows?: { count: number; first: number[] }
    ): XlsxOutcome => ({
      ok: true,
      sheetNames: ['Wide'],
      sheets: [
        {
          name: 'Wide',
          startRow: 1,
          rows,
          truncated: false,
          lastRow: rows.length,
          ...(skippedRows ? { skippedRows } : {}),
        },
      ],
    })

    it('emits a first wide row as [] and reads the narrow row after it', async () => {
      const file = admittedFile('xlsx-file', await valuesWorkbook(witnessCode()), XLSX_MIME)
      const result = await read(toolFor([file], fakeRunner(xlsx([wideRow, ['witness']])).runJob), {
        attachmentId: 'xlsx-file',
      })
      expect(result.output.is_error).toBe(false)
      expect(result.body).toMatchObject({
        status: 'ok',
        sheets: [
          {
            startRow: 1,
            rows: [[], ['witness']],
            skippedRows: { count: 1, first: [1] },
          },
        ],
      })
      expect(result.body.continuation).toBeUndefined()
    })

    it('merges an interior wide row with the parser skipped rows in worksheet order', async () => {
      const file = admittedFile('xlsx-file', await valuesWorkbook(witnessCode()), XLSX_MIME)
      const result = await read(
        toolFor(
          [file],
          fakeRunner(xlsx([['before'], wideRow, [], ['after']], { count: 1, first: [3] })).runJob
        ),
        { attachmentId: 'xlsx-file' }
      )
      expect(result.body).toMatchObject({
        status: 'ok',
        sheets: [
          {
            startRow: 1,
            rows: [['before'], [], [], ['after']],
            skippedRows: { count: 2, first: [2, 3] },
          },
        ],
      })
    })

    it('skips a wide last row and keeps the row before it', async () => {
      const file = admittedFile('xlsx-file', await valuesWorkbook(witnessCode()), XLSX_MIME)
      const result = await read(toolFor([file], fakeRunner(xlsx([['before'], wideRow])).runJob), {
        attachmentId: 'xlsx-file',
      })
      expect(result.body).toMatchObject({
        status: 'ok',
        sheets: [
          {
            startRow: 1,
            rows: [['before'], []],
            skippedRows: { count: 1, first: [2] },
          },
        ],
      })
      expect(result.body.continuation).toBeUndefined()
    })

    it('keeps the exhaustion notice when only the turn budget is short', async () => {
      const file = admittedFile('xlsx-file', await valuesWorkbook(witnessCode()), XLSX_MIME)
      const ledger = new AttachmentReadLedger()
      const notice = measureResult(
        JSON.stringify({
          status: 'read_budget_exhausted',
          attachmentId: 'xlsx-file',
          referenceId: file.fileReference!.id,
          message:
            'The current-turn attachment read budget is exhausted. Reattach the file in a new message and pass resumeCursor as cursor to continue; earlier pages are not stored for re-reading.',
        })
      )
      ledger.restore({ reads: 1, spentTokens: 0, bytesRead: 0 })
      const spent = Math.max(0, ledger.pageAllowance(WINDOW_TOKENS, notice) - 100)
      ledger.restore({ reads: 1, spentTokens: spent, bytesRead: 0 })
      // A row that fits a full page still does not fit the short turn allowance.
      const result = await read(
        toolFor(
          [file],
          fakeRunner(xlsx([Array.from({ length: 3 }, () => 'n'.repeat(2_000))])).runJob,
          { ledger }
        ),
        { attachmentId: 'xlsx-file' }
      )
      // A new turn restores a full page, so the notice stays truthful here.
      expect(result.body).toMatchObject({ status: 'read_budget_exhausted' })
      expect(result.output.is_error).toBe(false)
    })
  })

  describe('XLSX skippedRows accounting', () => {
    const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    const skippedRange = (from: number, count: number): number[] =>
      Array.from({ length: count }, (_, index) => from + index)
    const xlsx = (rows: XlsxCellValue[][], first: number[]): XlsxOutcome => ({
      ok: true,
      sheetNames: ['Rows'],
      sheets: [
        {
          name: 'Rows',
          startRow: 1,
          rows,
          truncated: false,
          lastRow: rows.length,
          skippedRows: { count: first.length, first },
        },
      ],
    })

    it('counts the 30 skipped rows the ledger emits and caps first at 20', async () => {
      const file = admittedFile('xlsx-file', await valuesWorkbook(witnessCode()), XLSX_MIME)
      // 30 parser-skipped rows, then rows of about 250 tokens each: the page
      // cuts before the window ends, with all 30 skipped rows inside it.
      const rows: XlsxCellValue[][] = [
        ...Array.from({ length: 30 }, () => []),
        ...Array.from({ length: 20 }, () => ['n'.repeat(1_000)]),
      ]
      const result = await read(
        toolFor([file], fakeRunner(xlsx(rows, skippedRange(1, 30))).runJob),
        { attachmentId: 'xlsx-file' }
      )
      const sheet = (result.body.sheets as Array<Record<string, unknown>>)[0]!
      expect(sheet.skippedRows).toEqual({
        count: 30,
        first: skippedRange(1, 20),
      })
      const emitted = (sheet.rows as unknown[]).length
      expect(emitted).toBeGreaterThan(30)
      expect(emitted).toBeLessThan(50)
      expect(result.body.continuation).toEqual({
        cursor: boundCursor(`v1.xlsx.0.${emitted + 1}`, file),
        limit: 'page_budget',
      })
    })

    it('counts only the skipped rows inside the emitted range', async () => {
      const file = admittedFile('xlsx-file', await valuesWorkbook(witnessCode()), XLSX_MIME)
      // Five skipped rows at the start, 40 rows of about 100 tokens each, then
      // five skipped rows the one-page cut cannot reach.
      const rows: XlsxCellValue[][] = [
        ...Array.from({ length: 5 }, () => []),
        ...Array.from({ length: 40 }, () => ['n'.repeat(400)]),
        ...Array.from({ length: 5 }, () => []),
      ]
      const result = await read(
        toolFor(
          [file],
          fakeRunner(xlsx(rows, [...skippedRange(1, 5), ...skippedRange(46, 5)])).runJob
        ),
        { attachmentId: 'xlsx-file' }
      )
      const sheet = (result.body.sheets as Array<Record<string, unknown>>)[0]!
      expect(sheet.skippedRows).toEqual({ count: 5, first: skippedRange(1, 5) })
      const emitted = (sheet.rows as unknown[]).length
      expect(emitted).toBeLessThan(46)
      expect(result.body.continuation).toEqual({
        cursor: boundCursor(`v1.xlsx.0.${emitted + 1}`, file),
        limit: 'page_budget',
      })
    })
  })
})

describe('DocumentReadTool XLSX row probe cost (review M2)', () => {
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  // Excel-legal 31-character names. Every probe and result carries the list.
  const names = (count: number): string[] =>
    Array.from({ length: count }, (_, index) =>
      `Sheet ${String(index).padStart(4, '0')} `.padEnd(31, 'n')
    )

  async function countedRead(
    outcome: XlsxOutcome,
    admitted?: Attachment,
    options: { contextWindowTokens?: number; ledger?: AttachmentReadLedger } = {}
  ): Promise<{ body: Record<string, unknown>; measures: number; measuredChars: number }> {
    const file =
      admitted ?? admittedFile('xlsx-file', await valuesWorkbook(witnessCode()), XLSX_MIME)
    let measures = 0
    let measuredChars = 0
    const counted = (raw: string): number => {
      measures += 1
      measuredChars += raw.length
      return measureResult(raw)
    }
    const { body } = await read(
      toolFor([file], fakeRunner(outcome).runJob, options),
      { attachmentId: 'xlsx-file' },
      { measureResult: counted }
    )
    return { body, measures, measuredChars }
  }

  const emittedRows = (body: Record<string, unknown>): number =>
    ((body.sheets ?? []) as Array<{ rows: unknown[] }>).reduce(
      (sum, sheet) => sum + sheet.rows.length,
      0
    )

  // The worst case for one call. Only rows up to the first one that cannot
  // join the page are probed, and each probed row costs at most three
  // measures: its own probe, its share of the halved group probes above it,
  // and one probe of the prefix it closes. The rest are searches over the
  // window (the reach of `[]` rows, the fit) and a few fixed measures. Rows
  // past the page are never probed, so the cost follows the rows a call
  // emits, not the rows the worker returned.
  const probeBound = (emitted: number, windowRows: number): number =>
    3 * (emitted + 2) + 3 * Math.ceil(Math.log2(windowRows + 1)) + 8

  it('stops probing once the page is full: 1,300 sheet names and one 900-character row per page', async () => {
    const file = admittedFile('xlsx-file', await valuesWorkbook(witnessCode()), XLSX_MIME)
    const sheetNames = names(1_300)
    const rows = Array.from({ length: 430 }, (_, index) => [`${index + 1}:`.padEnd(900, 'r')])
    const envelope = measureResult(
      JSON.stringify({
        status: 'ok',
        attachmentId: file.id,
        referenceId: file.fileReference!.id,
        format: 'xlsx',
        sheetNames,
        sheets: [{ name: sheetNames[0], startRow: 1, rows: [], truncated: true, lastRow: 430 }],
      })
    )
    // A page that holds the sheet list and one row, never two: the shape the
    // independent review measured at 821 measures per call on e1fe20095's
    // successor, each over the whole list, to emit a single row.
    const pageTokens = envelope + 340
    const { body, measures } = await countedRead(
      {
        ok: true,
        sheetNames,
        sheets: [{ name: sheetNames[0]!, startRow: 1, rows, truncated: false, lastRow: 430 }],
      },
      file,
      { contextWindowTokens: pageTokens * 10 }
    )
    expect(body.status).toBe('ok')
    const sheet = (body.sheets as Array<Record<string, unknown>>)[0]!
    expect(sheet.rows).toEqual(rows.slice(0, 1))
    expect(sheet.skippedRows).toBeUndefined()
    expect(body.continuation).toMatchObject({
      cursor: boundCursor('v1.xlsx.0.2', file),
      limit: 'page_budget',
    })
    expect(measures).toBeLessThanOrEqual(probeBound(emittedRows(body), rows.length))
  })

  it('fits a 400,000-character PDF window to a page in a few measures', async () => {
    const file = admittedFile('pdf-file', await textPdf([witnessCode()]), 'application/pdf')
    const text = Array.from({ length: 60_000 }, (_, index) => `w${index % 997} `)
      .join('')
      .slice(0, 400_000)
    let measures = 0
    const { body } = await read(
      toolFor(
        [file],
        fakeRunner({
          ok: true,
          pageCount: 1,
          pages: [{ page: 1, text, from: 0, to: text.length, lowText: false }],
        }).runJob,
        { contextWindowTokens: 200_000 }
      ),
      { attachmentId: 'pdf-file' },
      {
        measureResult: raw => {
          measures += 1
          return measureResult(raw)
        },
      }
    )
    expect(body.status).toBe('ok')
    const [page] = body.pages as Array<{ text: string }>
    // The largest prefix that fits the 20,000-token page.
    expect(text.startsWith(page!.text)).toBe(true)
    expect(page!.text.length).toBeGreaterThan(79_000)
    expect(body.continuation).toMatchObject({ limit: 'page_budget' })
    // Each measure covers up to a whole page. A bisection over the 400,000
    // characters took 22 (the notice, the whole window, 19 halvings and the
    // chosen result again); aiming at the allowance takes a handful, and
    // never more than about three per halving of the window.
    expect(measures).toBeLessThanOrEqual(8)
  })

  it('keeps the bound when every row is too wide for a page', async () => {
    const sheetNames = names(3)
    // Five 2,000-character cells: about 2,500 tokens, more than the
    // 2,000-token page, so every row becomes `[]` and is listed as skipped.
    const rows = Array.from({ length: 40 }, (_, index) =>
      Array.from({ length: 5 }, (_, cell) => `${index}.${cell}:`.padEnd(2_000, 'w'))
    )
    const { body, measures } = await countedRead({
      ok: true,
      sheetNames,
      sheets: [{ name: sheetNames[0]!, startRow: 1, rows, truncated: false, lastRow: 40 }],
    })
    expect(body.status).toBe('ok')
    const sheet = (body.sheets as Array<Record<string, unknown>>)[0]!
    expect(sheet.rows).toEqual(rows.map(() => []))
    expect(sheet.skippedRows).toEqual({
      count: 40,
      first: Array.from({ length: 20 }, (_, index) => index + 1),
    })
    expect(measures).toBeLessThanOrEqual(probeBound(emittedRows(body), rows.length))
  })

  it('measures a 5,000-row window by groups instead of once per row', async () => {
    const sheetNames = names(150)
    const rows = Array.from({ length: 5_000 }, (_, index) => [index + 1])
    const { body, measures, measuredChars } = await countedRead({
      ok: true,
      sheetNames,
      sheets: [{ name: sheetNames[0]!, startRow: 1, rows, truncated: true, lastRow: 20_000 }],
      next: { sheetIndex: 0, row: 5_001 },
      stoppedBy: 'max_rows',
    })
    expect(body.status).toBe('ok')
    const sheet = (body.sheets as Array<Record<string, unknown>>)[0]!
    const emitted = sheet.rows as number[][]
    // No row was wide; the page holds a prefix of the window, in order.
    expect(sheet.skippedRows).toBeUndefined()
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted).toEqual(rows.slice(0, emitted.length))
    expect((body.continuation as { limit: string }).limit).toBe('page_budget')
    // e1fe20095 measured one probe per row, each carrying the 150 names:
    // 5,000+ measures and over 25 MB of measured text.
    expect(measures).toBeLessThan(100)
    expect(measures).toBeLessThanOrEqual(probeBound(emitted.length, rows.length))
    expect(measuredChars).toBeLessThan(2_000_000)
  })

  it('skips every row with one measure when the sheet list alone exceeds a page', async () => {
    const sheetNames = names(600)
    const rows = Array.from({ length: 50 }, (_, index) => [index + 1])
    const { body, measures } = await countedRead({
      ok: true,
      sheetNames,
      sheets: [{ name: sheetNames[0]!, startRow: 1, rows, truncated: false, lastRow: 50 }],
    })
    expect(body).toMatchObject({
      status: 'error',
      reason: 'document_limits_exceeded',
      limit: 'row_width',
    })
    expect(measures).toBeLessThan(20)
    expect(measures).toBeLessThanOrEqual(probeBound(0, rows.length))
  })

  it('checks only the rows a page can reach when the sheet list nearly fills it', async () => {
    const file = admittedFile('xlsx-file', await valuesWorkbook(witnessCode()), XLSX_MIME)
    const rows = Array.from({ length: 5_000 }, (_, index) => [index + 1])
    const sheetNames = names(40)
    // The smallest result the Tool could emit for this sheet: no rows.
    const envelope = (list: string[]): number =>
      measureResult(
        JSON.stringify({
          status: 'ok',
          attachmentId: file.id,
          referenceId: file.fileReference!.id,
          format: 'xlsx',
          sheetNames: list,
          sheets: [{ name: list[0], startRow: 1, rows: [], truncated: true, lastRow: 20_000 }],
        })
      )
    // A crafted name leaves about 40 tokens of the 2,000-token page: room for
    // a few rows and a continuation, but no group of rows passes the margin,
    // so splitting alone measured every row about twice (10,015 measures),
    // each time with the whole sheet list.
    while (envelope(sheetNames) < 1_960) sheetNames[1] += 'p'
    expect(envelope(sheetNames)).toBeLessThanOrEqual(1_961)
    const { body, measures } = await countedRead(
      {
        ok: true,
        sheetNames,
        sheets: [{ name: sheetNames[0]!, startRow: 1, rows, truncated: true, lastRow: 20_000 }],
        next: { sheetIndex: 0, row: 5_001 },
        stoppedBy: 'max_rows',
      },
      file
    )
    expect(body.status).toBe('ok')
    const sheet = (body.sheets as Array<Record<string, unknown>>)[0]!
    const emitted = sheet.rows as number[][]
    expect(sheet.skippedRows).toBeUndefined()
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted).toEqual(rows.slice(0, emitted.length))
    // About two measures per row the page can reach (about 53 here, as `[]`)
    // plus the reach search and the fit: bounded by the page, not by the
    // 5,000-row window.
    expect(measures).toBeLessThan(300)
    expect(measures).toBeLessThanOrEqual(probeBound(emitted.length, rows.length))
  })
})

describe('DocumentReadTool configured masking', () => {
  it('applies the Tool cell cap without splitting a surrogate pair', async () => {
    const value = `a😀${'b'.repeat(12)}`
    const file = admittedFile(
      'xlsx-file',
      await surrogateWorkbook(value),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    const outcome: XlsxOutcome = {
      ok: true,
      sheetNames: ['Characters'],
      sheets: [{ name: 'Characters', startRow: 1, rows: [[value]], truncated: false, lastRow: 1 }],
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
    const pdfText = `before ${configured} after`
    const pdfOutcome: PdfTextOutcome = {
      ok: true,
      pageCount: 1,
      pages: [{ page: 1, text: pdfText, from: 0, to: pdfText.length, lowText: false }],
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
          lastRow: 1,
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

  it('replaces overlapping ranges once, as the safety layer does', async () => {
    const text = 'before ABCDEF after'
    const overlapping: AttachmentReadRedactor = {
      toolOutputRedactionRanges: (toolName, content) =>
        toolName === 'clerum__document_read' && content === text
          ? [
              { start: 7, end: 10, replacement: '[A]' },
              { start: 9, end: 13, replacement: '[B]' },
              { start: 14, end: 19, replacement: '[C]' },
            ]
          : [],
    }
    const file = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const outcome: PdfTextOutcome = {
      ok: true,
      pageCount: 1,
      pages: [{ page: 1, text, from: 0, to: text.length, lowText: false }],
    }
    const result = await read(
      toolFor([file], fakeRunner(outcome).runJob, { redactor: overlapping }),
      { attachmentId: 'pdf-file' }
    )
    // The overlap becomes one mixed replacement; the separate range keeps its own.
    expect(result.body).toMatchObject({ pages: [{ text: 'before [REDACTED] [C]' }] })
  })

  it('masks a configured value that a continuation cut splits, on both sides of the cut', async () => {
    const configured = 'fixture-configured-value'
    const text = `${'a'.repeat(100)}${configured}${'b'.repeat(100)}`
    const cut = 100 + 7
    const file = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const runJob: RunDocumentJob = async job => {
      if (job.kind !== 'pdf_text') throw new Error('Only PDF text is read here')
      const outcome: PdfTextOutcome =
        job.start.charOffset === 0
          ? {
              ok: true,
              pageCount: 1,
              pages: [{ page: 1, text, from: 0, to: cut, lowText: false }],
              next: { page: 1, charOffset: cut },
              stoppedBy: 'max_extracted_chars',
            }
          : {
              ok: true,
              pageCount: 1,
              pages: [{ page: 1, text, from: cut, to: text.length, lowText: false }],
            }
      return contractOutcome(job, outcome)
    }
    const tool = toolFor([file], runJob, { redactor: maskProvider(configured) })
    const first = await read(tool, { attachmentId: 'pdf-file' })
    const cursor = (first.body.continuation as { cursor: string }).cursor
    const second = await read(tool, { attachmentId: 'pdf-file', cursor })
    const emitted = [first, second]
      .map(result => (result.body.pages as Array<{ text: string }>)[0]!.text)
      .join('|')
    // Each side of the cut shows the masked text, never a fragment of the value.
    expect(emitted).not.toContain(configured.slice(0, 7))
    expect(emitted).not.toContain(configured.slice(7))
    expect(emitted).toContain('[MASKED]')
  })

  it('redacts a whole cell before the cell cap can cut the configured value', async () => {
    const configured = 'fixture-configured-value'
    // The value ends past maxCellChars, so capping first would cut the
    // configured value into a prefix that no longer matches it.
    const value = `${'x'.repeat(1_990)}${configured}`
    const file = admittedFile(
      'xlsx-file',
      await valuesWorkbook(witnessCode()),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    const outcome: XlsxOutcome = {
      ok: true,
      sheetNames: ['Values'],
      sheets: [{ name: 'Values', startRow: 1, rows: [[value]], truncated: false, lastRow: 1 }],
    }
    const result = await read(
      toolFor([file], fakeRunner(outcome).runJob, {
        redactor: maskProvider(configured),
        limits: documentLimits({ maxCellChars: 2_000 }),
      }),
      { attachmentId: 'xlsx-file' }
    )
    expect(result.body).toMatchObject({
      status: 'ok',
      sheets: [{ rows: [[`${'x'.repeat(1_990)}[MASKED]`]] }],
    })
    expect(result.output.content).not.toContain(configured.slice(0, 5))
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
      continuation: { cursor: boundCursor('v1.xlsx.0.2', file), limit: 'max_rows' },
    })
    const second = await read(tool, {
      attachmentId: 'xlsx-file',
      cursor: (first.body.continuation as { cursor: string }).cursor,
    })
    expect(second.body.sheets).toEqual([
      {
        name: 'Values',
        startRow: 2,
        rows: [['formula-zero', 0, false]],
        truncated: true,
        lastRow: 8,
      },
    ])
    expect(second.body.continuation).toEqual({
      cursor: boundCursor('v1.xlsx.0.3', file),
      limit: 'max_rows',
    })
  })
})
