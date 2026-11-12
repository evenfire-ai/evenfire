import { createHash } from 'node:crypto'
import type { IncomingMessage } from '../../../../server/types'
import { AttachmentReadLedger } from '../../../attachments/attachmentReadBudget'
import type { ExecutionContext } from '../../../interfaces'
import type { RedactionRange } from '../../../safety/safety'
import type { Attachment, ToolOutput, ToolResult } from '../../../types'
import type { AttachmentReadRedactor } from '../../attachmentRead'
import type { DocumentReadTool } from '../index'
import { encodeCursor } from '../selection'
import type {
  DocumentJob,
  PdfTextOutcome,
  PdfTextPageOutcome,
  RunDocumentJob,
  XlsxCellValue,
  XlsxOutcome,
  XlsxSheetResult,
} from '../types'
import { isJobOutcome } from '../workerRunner'
import { admittedFile, documentLimits, textPdf, valuesWorkbook } from './fixtures'

/**
 * Deterministic read chains for the budget fit (independent review M2). Each
 * scenario follows the continuation cursor through a fake worker that windows
 * a fixed document the way the real one does, and returns every result the
 * Tool emitted with the file's identity replaced by placeholders, so a
 * digest of it compares two implementations call by call.
 */
type ToolClass = new (
  message: IncomingMessage,
  options: ConstructorParameters<typeof DocumentReadTool>[1]
) => DocumentReadTool

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const measureResult = (raw: string): number => Math.ceil(Buffer.byteLength(raw, 'utf8') / 4) + 4

interface WorkbookModel {
  sheetNames: string[]
  sheets: Array<{ rows: XlsxCellValue[][]; parserSkipped?: number[] }>
}

function contract(job: DocumentJob, outcome: unknown): never {
  if (!isJobOutcome(job.kind, outcome)) throw new Error(`Fake ${job.kind} outcome breaks contract`)
  return outcome as never
}

/** A worker over `model`: up to `windowRows` rows from the cursor, across sheets. */
function workbookRunner(model: WorkbookModel, windowRows: number): RunDocumentJob {
  return async job => {
    if (job.kind !== 'xlsx') throw new Error('workbook runner received a non-xlsx job')
    let sheetIndex = job.start?.sheetIndex ?? 0
    let row = job.start?.row ?? 1
    let left = windowRows
    const sheets: XlsxSheetResult[] = []
    let next: { sheetIndex: number; row: number } | undefined
    while (sheetIndex < model.sheets.length) {
      const sheet = model.sheets[sheetIndex]!
      const lastRow = sheet.rows.length
      if (left === 0) {
        next = { sheetIndex, row }
        break
      }
      const end = Math.min(lastRow, row + left - 1)
      const skipped = new Set(sheet.parserSkipped ?? [])
      const rows = sheet.rows
        .slice(row - 1, end)
        .map((cells, index) => (skipped.has(row + index) ? [] : cells))
      const first = [...skipped]
        .filter(number => number >= row && number <= end)
        .sort((a, b) => a - b)
      sheets.push({
        name: model.sheetNames[sheetIndex]!,
        startRow: row,
        rows,
        truncated: end < lastRow,
        lastRow,
        ...(first.length > 0 ? { skippedRows: { count: first.length, first } } : {}),
      })
      left -= end - row + 1
      if (end < lastRow) {
        next = { sheetIndex, row: end + 1 }
        break
      }
      sheetIndex += 1
      row = 1
    }
    const outcome: XlsxOutcome = {
      ok: true,
      sheetNames: model.sheetNames,
      sheets,
      ...(next ? { next, stoppedBy: 'max_rows' as const } : {}),
    }
    return contract(job, outcome)
  }
}

/** A worker over `pages`: up to `windowPages` pages from the cursor. */
function pdfRunner(pages: string[], windowPages: number): RunDocumentJob {
  return async job => {
    if (job.kind !== 'pdf_text') throw new Error('pdf runner received a non-text job')
    const startPage = job.start.page
    const out: PdfTextPageOutcome[] = []
    for (let page = startPage; page < startPage + windowPages && page <= pages.length; page += 1) {
      const text = pages[page - 1]!
      out.push({
        page,
        text,
        from: page === startPage ? job.start.charOffset : 0,
        to: text.length,
        lowText: false,
      })
    }
    const last = out[out.length - 1]!.page
    const outcome: PdfTextOutcome = {
      ok: true,
      pageCount: pages.length,
      pages: out,
      ...(last < pages.length
        ? { next: { page: last + 1, charOffset: 0 }, stoppedBy: 'max_pages' as const }
        : {}),
    }
    return contract(job, outcome)
  }
}

// A synthetic configured value. It keeps the 17 characters the pinned chain
// digests were generated with: every occurrence is masked, so only its length
// reaches a result.
const SECRET = 'FIXTURE-TOKEN-424'
const secretRedactor: AttachmentReadRedactor = {
  toolOutputRedactionRanges: (_tool, value) => {
    const ranges: RedactionRange[] = []
    for (let at = value.indexOf(SECRET); at >= 0; at = value.indexOf(SECRET, at + 1)) {
      ranges.push({ start: at, end: at + SECRET.length, replacement: '[MASKED]' })
    }
    return ranges
  },
}

interface Scenario {
  name: string
  file: () => Promise<Attachment>
  runJob: RunDocumentJob
  windowTokens: number
  /** `turn`: one ledger for the chain; `fresh`: every call starts a new turn. */
  ledger: 'turn' | 'fresh'
  redactor?: AttachmentReadRedactor
  maxCalls: number
}

const sheetName = (index: number): string =>
  `Sheet ${String(index).padStart(4, '0')} `.padEnd(31, 'n')
const cells = (row: number, count: number, width: number): string[] =>
  Array.from({ length: count }, (_, cell) => `${row}.${cell}:`.padEnd(width, 'c'))

function scenarios(): Scenario[] {
  const xlsx = async () =>
    admittedFile('xlsx-file', await valuesWorkbook('fit-scenarios'), XLSX_MIME)
  const pdf = async () =>
    admittedFile('pdf-file', await textPdf(['fit-scenarios']), 'application/pdf')

  // A long sheet list and one 900-character row per page.
  const longList: WorkbookModel = {
    sheetNames: Array.from({ length: 200 }, (_, index) => sheetName(index)),
    sheets: [{ rows: Array.from({ length: 24 }, (_, row) => cells(row + 1, 1, 900)) }],
  }
  // Three sheets with small, too-wide and medium rows across the boundaries.
  const boundaries: WorkbookModel = {
    sheetNames: ['Alpha', 'Beta', 'Gamma'],
    sheets: [
      { rows: Array.from({ length: 25 }, (_, row) => [row + 1, `a${row}`]) },
      {
        rows: Array.from({ length: 10 }, (_, row) =>
          row === 3 || row === 7 ? cells(row + 1, 5, 2_000) : cells(row + 1, 2, 300)
        ),
      },
      { rows: Array.from({ length: 30 }, (_, row) => cells(row + 1, 3, 120)) },
    ],
  }
  // Parser-skipped rows next to too-wide ones and gaps.
  const parserSkipped: WorkbookModel = {
    sheetNames: ['Skips'],
    sheets: [
      {
        rows: Array.from({ length: 60 }, (_, row) =>
          row % 9 === 4 ? cells(row + 1, 5, 2_000) : row % 7 === 0 ? [] : cells(row + 1, 2, 200)
        ),
        parserSkipped: [3, 4, 18, 19, 20, 41],
      },
    ],
  }
  const allWide: WorkbookModel = {
    sheetNames: ['Wide'],
    sheets: [{ rows: Array.from({ length: 12 }, (_, row) => cells(row + 1, 5, 2_000)) }],
  }
  // A sheet list that leaves about 40 tokens of a 2,000-token page.
  const nearlyFull: WorkbookModel = {
    sheetNames: Array.from({ length: 40 }, (_, index) => sheetName(index)),
    sheets: [{ rows: Array.from({ length: 300 }, (_, row) => [row + 1]) }],
  }
  nearlyFull.sheetNames[1] += 'p'.repeat(5_850)
  const mixed: WorkbookModel = {
    sheetNames: ['Mixed', 'Tail'],
    sheets: [
      {
        rows: Array.from({ length: 80 }, (_, row) =>
          row % 5 === 2
            ? cells(row + 1, 5, 2_000)
            : cells(row + 1, 1 + (row % 4), 90 * (row % 6) + 5)
        ),
      },
      { rows: Array.from({ length: 15 }, (_, row) => cells(row + 1, 2, 400)) },
    ],
  }

  const words = (seed: number, length: number, secretEvery = 0): string => {
    let text = ''
    for (let index = 0; text.length < length; index += 1) {
      text +=
        secretEvery > 0 && index % secretEvery === 0
          ? `${SECRET} `
          : `w${(seed * 31 + index) % 997} `
    }
    return text.slice(0, length)
  }
  const longPage = [words(1, 120_000)]
  const multiPage = [500, 3_000, 12_000, 50, 7_000, 20_000].map((length, index) =>
    words(index + 2, length, 40)
  )
  const surrogates = [
    Array.from({ length: 9_000 }, (_, index) => (index % 3 === 0 ? '😀' : 'ab')).join(''),
  ]

  const xlsxCases: Array<[string, WorkbookModel, number, number]> = [
    ['long sheet list', longList, 24, 0],
    ['sheet boundaries', boundaries, 50, 20_000],
    ['parser-skipped rows', parserSkipped, 60, 20_000],
    ['all rows too wide', allWide, 12, 20_000],
    ['nearly full page', nearlyFull, 300, 20_000],
    ['mixed widths', mixed, 80, 20_000],
  ]
  const out: Scenario[] = []
  for (const [name, model, window, tokens] of xlsxCases) {
    for (const ledger of ['turn', 'fresh'] as const) {
      out.push({
        name: `xlsx ${name} (${ledger})`,
        file: xlsx,
        runJob: workbookRunner(model, window),
        // The long list sizes its page to the list plus about 1.5 rows.
        windowTokens: tokens || (measureResult(JSON.stringify(model.sheetNames)) + 420) * 10,
        ledger,
        maxCalls: 60,
      })
    }
  }
  const pdfCases: Array<[string, string[], number, AttachmentReadRedactor | undefined]> = [
    ['one long page', longPage, 1, undefined],
    ['pages with a secret', multiPage, 3, secretRedactor],
    ['surrogate pairs', surrogates, 1, undefined],
  ]
  for (const [name, pages, window, redactor] of pdfCases) {
    for (const ledger of ['turn', 'fresh'] as const) {
      out.push({
        name: `pdf ${name} (${ledger})`,
        file: pdf,
        runJob: pdfRunner(pages, window),
        windowTokens: 20_000,
        ledger,
        ...(redactor ? { redactor } : {}),
        maxCalls: 60,
      })
    }
  }
  return out
}

export interface ScenarioRun {
  name: string
  calls: number
  measures: number
  digest: string
}

/** Runs every scenario with `Tool`; the digest covers every emitted result. */
export async function runFitScenarios(Tool: ToolClass): Promise<ScenarioRun[]> {
  const runs: ScenarioRun[] = []
  for (const scenario of scenarios()) {
    const file = await scenario.file()
    const binding = encodeCursor({ format: 'pdf', page: 1, charOffset: 0 }, file.fileReference!.id)
      .split('.')
      .pop()!
    const normalize = (content: string): string =>
      content.split(file.fileReference!.id).join('<reference>').split(binding).join('<binding>')
    let ledger = new AttachmentReadLedger()
    const message: IncomingMessage = {
      content: 'Read the document',
      channelType: 'rpc',
      channelId: 'fit-agent',
      sender: 'fit-user',
      timestamp: '2026-11-12T10:00:00Z',
      messageId: 'fit-scenarios',
      hostRef: 'fit-host',
      attachments: [file],
    }
    const make = () =>
      new Tool(message, {
        contextWindowTokens: scenario.windowTokens,
        ledger,
        redactor: scenario.redactor ?? { toolOutputRedactionRanges: () => [] },
        runJob: scenario.runJob,
        limits: documentLimits(),
      })
    let tool = make()
    let measures = 0
    const context: ExecutionContext = {
      onOutput: () => undefined,
      measureResult: raw => {
        measures += 1
        return measureResult(raw)
      },
    }
    const transcript: string[] = []
    let cursor: string | undefined
    let calls = 0
    while (calls < scenario.maxCalls) {
      if (scenario.ledger === 'fresh') {
        ledger = new AttachmentReadLedger()
        tool = make()
      }
      calls += 1
      const output: ToolOutput = await tool.execute(
        { attachmentId: file.id, ...(cursor ? { cursor } : {}) },
        context
      )
      const result: ToolResult = {
        tool_call_id: `fit-${calls}`,
        name: tool.name(),
        content: output.content,
        rawContent: output.content,
        is_error: output.is_error,
        metadata: output.metadata,
        emittedMessageCost: measureResult(output.content),
      }
      const finalized = tool.finalizeResult(result, {
        measureContent: measureResult,
        renderContent: content => content,
      })
      transcript.push(
        normalize(String(finalized.rawContent ?? finalized.content)),
        JSON.stringify(finalized.metadata ?? null),
        String(Boolean(finalized.stopTurn))
      )
      const body = JSON.parse(String(finalized.rawContent ?? finalized.content)) as {
        status?: string
        continuation?: { cursor: string }
      }
      if (finalized.stopTurn || body.status !== 'ok' || !body.continuation) break
      cursor = body.continuation.cursor
    }
    runs.push({
      name: scenario.name,
      calls,
      measures,
      digest: createHash('sha256').update(transcript.join('\n')).digest('hex').slice(0, 16),
    })
  }
  return runs
}
