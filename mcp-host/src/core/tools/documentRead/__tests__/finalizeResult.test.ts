import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from '../../../../server/types'
import {
  AttachmentReadLedger,
  attachmentReadBudgets,
} from '../../../attachments/attachmentReadBudget'
import type { ExecutionContext } from '../../../interfaces'
import type { Attachment, ToolResult } from '../../../types'
import type { AttachmentReadRedactor } from '../../attachmentRead'
import { DocumentReadTool } from '../index'
import type { PdfTextOutcome, RunDocumentJob } from '../types'
import { admittedFile, documentLimits, imageOnlyPdf, witnessCode } from './fixtures'

const WINDOW_TOKENS = 20_000
const TOOL_NAME = 'clerum__document_read'
const renderContent = (raw: string): string => raw
const measureResult = (raw: string): number => Math.ceil(Buffer.byteLength(raw, 'utf8') / 4) + 4
const measureContent = measureResult

function messageFor(attachments: Attachment[]): IncomingMessage {
  return {
    content: 'Read the attached document',
    channelType: 'rpc',
    channelId: 'document-finalize-agent',
    sender: 'user-document',
    timestamp: '2026-10-13T10:00:00Z',
    messageId: 'message-document-finalize',
    hostRef: 'host-document',
    attachments,
  }
}

function redactor(): AttachmentReadRedactor {
  return { toolOutputRedactionRanges: () => [] }
}

function executionContext(): ExecutionContext {
  return { onOutput: () => undefined, measureResult }
}

function runJob(): RunDocumentJob {
  const outcome: PdfTextOutcome = {
    ok: true,
    pageCount: 1,
    pages: [{ page: 1, text: 'budget page', from: 0, to: 11, lowText: false }],
  }
  return async () => outcome as never
}

async function executedRead(ledger: AttachmentReadLedger = new AttachmentReadLedger()) {
  const file = admittedFile('pdf-file', await imageOnlyPdf(witnessCode()), 'application/pdf')
  const tool = new DocumentReadTool(messageFor([file]), {
    contextWindowTokens: WINDOW_TOKENS,
    ledger,
    redactor: redactor(),
    runJob: runJob(),
    limits: documentLimits(),
  })
  const output = await tool.execute({ attachmentId: 'pdf-file' }, executionContext())
  const result: ToolResult = {
    tool_call_id: 'call-document-finalize',
    name: TOOL_NAME,
    content: renderContent(output.content),
    is_error: output.is_error,
    metadata: output.metadata,
    rawContent: output.content,
    emittedMessageCost: measureContent(renderContent(output.content)),
  }
  return { file, tool, ledger, output, result }
}

function noticeBody(result: ToolResult): Record<string, unknown> {
  expect(result.rawContent).toBeTypeOf('string')
  return JSON.parse(result.rawContent as string) as Record<string, unknown>
}

describe('DocumentReadTool finalizeResult budget fence', () => {
  it('charges the finalized message and keeps a successful read live', async () => {
    const { ledger, result, tool } = await executedRead()
    const before = ledger.snapshot()

    const finalized = tool.finalizeResult(result, { measureContent, renderContent })

    const after = ledger.snapshot()
    expect(JSON.parse(finalized.rawContent as string)).toMatchObject({ status: 'ok' })
    expect(finalized.emittedMessageCost).toBe(measureContent(finalized.content))
    expect(after.spentTokens).toBe(before.spentTokens + finalized.emittedMessageCost!)
    expect(after.bytesRead).toBeGreaterThan(before.bytesRead)
  })

  it('replaces an over-budget result and its images with the exhausted notice', async () => {
    const { ledger, result, tool } = await executedRead()
    const before = ledger.snapshot()
    const pageImage: Attachment = {
      id: 'page-image',
      kind: 'image',
      mimeType: 'image/png',
      encoding: 'base64',
      dataBase64: Buffer.from('page image').toString('base64'),
    }
    const overgrown: ToolResult = {
      ...result,
      attachments: [pageImage],
      content: `${result.content}${' '.repeat(12_000)}`,
      emittedMessageCost: result.emittedMessageCost! + 1_500,
    }

    const finalized = tool.finalizeResult(overgrown, { measureContent, renderContent })

    const body = noticeBody(finalized)
    expect(body.status).toBe('read_budget_exhausted')
    expect(finalized.content).not.toContain('budget page')
    expect(finalized.attachments).toBeUndefined()
    expect(finalized.stopTurn).toBeUndefined()
    expect(finalized.metadata).toEqual({ documentRead: { paused: true } })
    expect(ledger.snapshot().bytesRead).toBe(before.bytesRead)
    expect(ledger.snapshot().spentTokens).toBe(before.spentTokens + finalized.emittedMessageCost!)
  })

  it('stops the turn when the exhausted notice no longer fits the overdraft', async () => {
    const ledger = new AttachmentReadLedger()
    const { turnTokens } = attachmentReadBudgets(WINDOW_TOKENS)
    ledger.restore({
      reads: 1,
      spentTokens: turnTokens + Math.floor(turnTokens / 2),
      bytesRead: 0,
    })
    const { result, tool } = await executedRead(ledger)
    const finalized = tool.finalizeResult(result, { measureContent, renderContent })

    const before = ledger.snapshot()
    expect(noticeBody(finalized).status).toBe('read_budget_exhausted')
    expect(finalized.stopTurn?.message).toContain('reading limit')
    expect(ledger.snapshot()).toEqual(before)
  })

  it('consumes its pending read exactly once', async () => {
    const { result, tool } = await executedRead()
    const context = { measureContent, renderContent }
    const finalize = DocumentReadTool.prototype.finalizeResult.bind(tool)

    const first = finalize(result, context)
    expect(first.emittedMessageCost).toBeGreaterThan(0)
    expect(() => finalize(result, context)).toThrow(/pending/i)
  })
})
