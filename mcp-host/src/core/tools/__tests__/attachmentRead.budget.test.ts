/**
 * C16 — current-turn budget fencing for `clerum__attachment_read`.
 *
 * Measurement mirrors production: BasicSafety's pure sanitize+wrap preview,
 * then a BPE-style bytes/4 estimate, so JSON quoting growth is visible to the
 * fitter. Every test drives the real execute -> finalize contract once.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { validateIncomingAttachments } from '../../../agent/incomingAttachments'
import type { IncomingMessage } from '../../../server'
import { AttachmentReadLedger } from '../../attachments/attachmentReadBudget'
import { BasicSafety } from '../../safety/safety'
import type { Attachment, ToolResult } from '../../types'
import { AttachmentReadTool } from '../attachmentRead'

const TOOL_NAME = 'clerum__attachment_read'
const READ_LIMIT = 65_536
const WINDOW_TOKENS = 20_000
const safety = new BasicSafety()

const bpe = (content: string): number => Math.ceil(Buffer.byteLength(content, 'utf8') / 4) + 4
const renderContent = (raw: string): string => safety.previewOutputForLlm(TOOL_NAME, raw)
const measureContent = (finalContent: string): number => bpe(finalContent)
const measureResult = (raw: string): number => measureContent(renderContent(raw))

function rawFile(id: string, filename: string, mimeType: string, bytes: Buffer) {
  return {
    id,
    kind: 'file',
    mimeType,
    detectedMediaType: mimeType,
    encoding: 'base64',
    dataBase64: bytes.toString('base64'),
    filename,
    sizeBytes: bytes.length,
    digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
  }
}

function admitted(raw: unknown[]): Attachment[] {
  const result = validateIncomingAttachments(raw, {
    maxCount: 20,
    maxBytes: 4_000_000,
    maxFileBytes: 4_000_000,
    messageId: 'message-budget',
  })
  if (!result.ok) throw new Error(`fixture rejected: ${result.error.code}`)
  return result.attachments!
}

function messageFor(attachments: Attachment[]): IncomingMessage {
  return {
    content: 'Read the attached file',
    channelType: 'rpc',
    channelId: 'agent-budget',
    sender: 'user-budget',
    timestamp: '2026-10-02T10:00:00Z',
    messageId: 'message-budget',
    hostRef: 'host-budget',
    attachments,
  }
}

function toolFor(
  attachments: Attachment[],
  options: { ledger?: AttachmentReadLedger; windowTokens?: number } = {}
) {
  const ledger = options.ledger ?? new AttachmentReadLedger()
  return {
    tool: new AttachmentReadTool(messageFor(attachments), READ_LIMIT, {
      contextWindowTokens: options.windowTokens ?? WINDOW_TOKENS,
      ledger,
    }),
    ledger,
  }
}

interface RunResult {
  outputBody: Record<string, unknown>
  finalized: ToolResult
  rawOutput: string
}

async function runRead(
  tool: AttachmentReadTool,
  params: Record<string, unknown>,
  options: { transform?: (content: string) => string } = {}
): Promise<RunResult> {
  const output = await tool.execute(params, { onOutput: () => {}, measureResult })
  let content = renderContent(output.content)
  if (options.transform) content = options.transform(content)
  const result: ToolResult = {
    tool_call_id: 'tc_budget',
    name: TOOL_NAME,
    content,
    is_error: output.is_error,
    metadata: output.metadata,
    rawContent: output.content,
    emittedMessageCost: measureContent(content),
  }
  const finalized = tool.finalizeResult!(result, { measureContent, renderContent })
  return {
    outputBody: JSON.parse(output.content) as Record<string, unknown>,
    finalized,
    rawOutput: output.content,
  }
}

describe('C16 constructor contract', () => {
  it('requires the budget options as a mandatory third constructor argument', () => {
    expect(() => new AttachmentReadTool(messageFor([]), READ_LIMIT, undefined as never)).toThrow(
      /attachment read options/i
    )
  })
})

describe('C16 page fitting', () => {
  it('walks CJK and emoji pages through nextOffset without splitting code points', async () => {
    const original = `漢字📚${'😀'.repeat(20_000)}fin`
    const bytes = Buffer.from(original, 'utf8')
    const [file] = admitted([rawFile('file-cjk', 'walk.txt', 'text/plain', bytes)])
    const { tool } = toolFor([file!], { windowTokens: 100_000 })

    const parts: string[] = []
    const origins: string[] = []
    let offset = 0
    let guard = 0
    while (guard++ < 100) {
      const { outputBody, finalized } = await runRead(tool, { attachmentId: 'file-cjk', offset })
      const range = outputBody.byteRange as { offset: number; length: number }
      expect(range.offset).toBe(offset)
      expect(range.length).toBeGreaterThan(0)
      parts.push(outputBody.text as string)
      origins.push(
        ((finalized.metadata as Record<string, unknown>).attachmentRead as Record<string, unknown>)
          .origin as string
      )
      offset += range.length
      if (outputBody.truncated === true) {
        expect(outputBody.nextOffset).toBe(offset)
        expect(typeof outputBody.limit).toBe('string')
      } else {
        expect(outputBody.nextOffset).toBeUndefined()
        expect(outputBody.limit).toBeUndefined()
        break
      }
    }
    expect(parts.join('')).toBe(original)
    expect(parts.join('')).not.toContain('\uFFFD')
    expect(origins[0]).toBe('current')
    expect(origins[1]).toBe('current_resumed')
  })

  it('shrinks quote-dense JSON more than plain ASCII under the real wrapper measurement', async () => {
    const dense = '"'.repeat(120_000)
    const plain = 'a'.repeat(120_000)
    const [denseFile, plainFile] = admitted([
      rawFile('file-dense', 'dense.json', 'application/json', Buffer.from(dense)),
      rawFile('file-plain', 'plain.txt', 'text/plain', Buffer.from(plain)),
    ])
    const denseTool = toolFor([denseFile!]).tool
    const plainTool = toolFor([plainFile!]).tool

    const densePage = await runRead(denseTool, { attachmentId: 'file-dense' })
    const plainPage = await runRead(plainTool, { attachmentId: 'file-plain' })
    const denseRange = densePage.outputBody.byteRange as { length: number }
    const plainRange = plainPage.outputBody.byteRange as { length: number }
    // Quotes double in JSON (" -> \"); the fitter must see that growth.
    expect(denseRange.length).toBeLessThan(plainRange.length)
    expect(densePage.outputBody.limit).toBe('page_budget')
    expect(plainPage.outputBody.limit).toBe('page_budget')
  })

  it('caps a page by the 10% page budget', async () => {
    const [file] = admitted([
      rawFile('file-page', 'page.txt', 'text/plain', Buffer.alloc(120_000, 'x')),
    ])
    const { tool, ledger } = toolFor([file!])
    const before = ledger.snapshot()
    const { outputBody, finalized } = await runRead(tool, { attachmentId: 'file-page' })
    const range = outputBody.byteRange as { length: number }

    expect(outputBody.limit).toBe('page_budget')
    expect(range.length).toBeLessThan(READ_LIMIT)
    expect(finalized.emittedMessageCost).toBeLessThanOrEqual(Math.floor(WINDOW_TOKENS * 0.1))
    expect(ledger.snapshot().spentTokens).toBeGreaterThan(before.spentTokens)
    expect(ledger.snapshot().bytesRead).toBe(range.length)
  })

  it('caps later pages by the remaining 30% turn budget', async () => {
    const [file] = admitted([
      rawFile('file-turn', 'turn.txt', 'text/plain', Buffer.alloc(400_000, 'y')),
    ])
    const { tool, ledger } = toolFor([file!])

    let offset = 0
    const limits: string[] = []
    for (let page = 0; page < 3; page++) {
      const { outputBody } = await runRead(tool, { attachmentId: 'file-turn', offset })
      limits.push(outputBody.limit as string)
      offset += (outputBody.byteRange as { length: number }).length
    }
    expect(limits[0]).toBe('page_budget')
    expect(limits[limits.length - 1]).toBe('turn_budget')
    expect(ledger.snapshot().spentTokens).toBeLessThanOrEqual(Math.floor(WINDOW_TOKENS * 0.3))
  })
})

describe('C16 read count and exhaustion', () => {
  it('allows the 32nd read and answers the 33rd with a success notice', async () => {
    const [file] = admitted([
      rawFile('file-32', 'count.txt', 'text/plain', Buffer.from('countable page body')),
    ])
    const { tool, ledger } = toolFor([file!])

    for (let call = 1; call <= 32; call++) {
      const { outputBody } = await runRead(tool, { attachmentId: 'file-32', maxBytes: 4 })
      expect(outputBody.kind).toBe('text')
    }
    expect(ledger.snapshot().reads).toBe(32)

    const thirtyThird = await runRead(tool, { attachmentId: 'file-32', offset: 4 })
    expect(thirtyThird.finalized.is_error).toBe(false)
    expect(thirtyThird.outputBody.kind).toBe('read_budget_exhausted')
    expect(thirtyThird.outputBody.resumeOffset).toBe(4)
    const message = thirtyThird.outputBody.message as string
    expect(message).toMatch(/new message/i)
    expect(message).toMatch(/current-turn|current turn/i)
    expect(message).not.toMatch(/earlier (pages )?(are |is )?stored/i)
    expect(thirtyThird.rawOutput).not.toContain('countable')
    expect(ledger.snapshot().reads).toBe(32)
  })

  it('charges native errors in finalize', async () => {
    const [file] = admitted([rawFile('file-err', 'errors.txt', 'text/plain', Buffer.from('aé!'))])
    const { tool, ledger } = toolFor([file!])
    const before = ledger.snapshot()

    const bad = await runRead(tool, { attachmentId: 'file-err', offset: 2 })
    const missing = await runRead(tool, { attachmentId: 'file-other' })
    expect(bad.outputBody.error).toBe('range_invalid')
    expect(missing.outputBody.error).toBe('attachment_not_found')
    expect(ledger.snapshot().reads).toBe(before.reads + 2)
    expect(ledger.snapshot().spentTokens).toBeGreaterThan(before.spentTokens)
  })
})

describe('C16 finalize fence', () => {
  it('replaces post-transform growth with a trusted exhausted notice at the original offset', async () => {
    const [file] = admitted([
      rawFile('file-grow', 'grow.txt', 'text/plain', Buffer.from('growth page body ')),
    ])
    const { tool, ledger } = toolFor([file!])

    const { outputBody, finalized } = await runRead(
      tool,
      { attachmentId: 'file-grow' },
      { transform: content => content + ' '.repeat(4_000) }
    )
    expect(outputBody.kind).toBe('text')
    expect(finalized.is_error).toBe(false)
    const body = JSON.parse(finalized.rawContent as string) as Record<string, unknown>
    expect(body.kind).toBe('read_budget_exhausted')
    expect(body.resumeOffset).toBe(0)
    expect(finalized.content).not.toContain('growth page body')
    expect(finalized.emittedMessageCost).toBeLessThanOrEqual(120)
    expect(ledger.snapshot().bytesRead).toBe(0)
  })

  it('fails closed when even the trusted notice cannot fit the remaining budget', async () => {
    const [file] = admitted([
      rawFile('file-tight', 'tight.txt', 'text/plain', Buffer.from('tight page body')),
    ])
    const ledger = new AttachmentReadLedger()
    const spent = Math.floor(WINDOW_TOKENS * 0.3) - 1
    ledger.restore({ reads: 1, spentTokens: spent, bytesRead: 0 })
    const { tool } = toolFor([file!], { ledger })

    await expect(runRead(tool, { attachmentId: 'file-tight' })).rejects.toThrow(
      /cannot fit|budget/i
    )
  })

  it('finalizes exactly once without another tool execution', async () => {
    const [file] = admitted([
      rawFile('file-once', 'once.txt', 'text/plain', Buffer.from('single page body')),
    ])
    const { tool } = toolFor([file!])
    const output = await tool.execute(
      { attachmentId: 'file-once' },
      { onOutput: () => {}, measureResult }
    )
    const result: ToolResult = {
      tool_call_id: 'tc_once',
      name: TOOL_NAME,
      content: renderContent(output.content),
      is_error: output.is_error,
      emittedMessageCost: measureContent(renderContent(output.content)),
    }
    const first = tool.finalizeResult!(result, { measureContent, renderContent })
    expect(first.emittedMessageCost).toBeGreaterThan(0)
    expect(() => tool.finalizeResult!(result, { measureContent, renderContent })).toThrow(
      /pending/i
    )
  })
})

describe('C16 metadata and measurement gates', () => {
  it('emits only numbers and enums in attachmentRead metadata', async () => {
    const [file] = admitted([
      rawFile(
        'file-meta',
        'metadata-filename.txt',
        'text/plain',
        Buffer.from('metadata page body')
      ),
    ])
    const { tool } = toolFor([file!])
    const { finalized } = await runRead(tool, { attachmentId: 'file-meta' })

    const meta = (finalized.metadata as Record<string, unknown>).attachmentRead as Record<
      string,
      unknown
    >
    expect(Object.keys(meta).sort()).toEqual(
      ['fileBytes', 'length', 'offset', 'origin', 'paused', 'truncated'].sort()
    )
    expect(meta.origin).toBe('current')
    expect(meta.paused).toBe(false)
    expect(JSON.stringify(meta)).not.toContain('metadata-filename.txt')
    expect(JSON.stringify(meta)).not.toContain('metadata page body')
  })

  it('fails a text read closed without measureResult while the same read succeeds with it', async () => {
    const [file] = admitted([
      rawFile('file-measure', 'measure.txt', 'text/plain', Buffer.from('measurable page body')),
    ])
    const { tool, ledger } = toolFor([file!])
    const before = ledger.snapshot()

    const output = await tool.execute({ attachmentId: 'file-measure' }, { onOutput: () => {} })
    expect(output.is_error).toBe(true)
    expect(JSON.parse(output.content).error).toBe('measurement_unavailable')
    expect(ledger.snapshot().reads).toBe(before.reads + 1)

    const witness = await runRead(tool, { attachmentId: 'file-measure' })
    expect(witness.outputBody.kind).toBe('text')
  })
})
