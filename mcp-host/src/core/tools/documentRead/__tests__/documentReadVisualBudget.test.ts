/**
 * Visual reads share the request's image bounds and the turn's image memory
 * (zach88 H2), and their image ids fit the provider id alphabet (N1).
 */
import { describe, expect, it, vi } from 'vitest'
import { parseCodexCompletionRequest } from '@clerum/llm-provider-attempt-contract'
import { PNG_2X2_BASE64 } from '../../../../llm/__tests__/codexImageFixtures'
import type { IncomingMessage } from '../../../../server/types'
import {
  type VisualDeliveryLimits,
  resolveOfficialVisualDeliveryLimits,
  resolveVisualDeliveryLimits,
} from '../../../../visualInput/deliveryLimits'
import { VisualInputBudget } from '../../../../visualInput/policy'
import { AttachmentReadLedger } from '../../../attachments/attachmentReadBudget'
import { makeFakeConversation } from '../../../conversation/__testing__/makeFakeConversation'
import type {
  ExecutionContext,
  ReasoningPort,
  RequestImageUsage,
  ToolRegistry,
} from '../../../interfaces'
import { SimpleEventEmitter } from '../../../orchestration/eventEmitter'
import { buildLoopConfig } from '../../../orchestration/loopConfig'
import { requestImageUsage } from '../../../orchestration/toolUseLoopMessages'
import { executeSingleTool } from '../../../orchestration/toolUseLoopSingleTool'
import { executeToolCalls } from '../../../orchestration/toolUseLoopToolBatch'
import { BasicSafety } from '../../../safety/safety'
import type { Attachment, ChatMessage, ToolResult } from '../../../types'
import { DocumentReadTool } from '../index'
import type { DocumentJob, RunDocumentJob } from '../types'
import { runDocumentJob } from '../workerRunner'
import {
  admittedFile,
  boundCursor,
  documentLimits,
  imageOnlyPdf,
  textPdf,
  witnessCode,
} from './fixtures'

const IMAGE_MESSAGE =
  'The current request already carries as many images as the model accepts, or the turn image memory is spent. Reattach the file in a new message and pass resumeCursor as cursor to continue.'
const CODEX = resolveVisualDeliveryLimits('codex-subscription')!
const ANTHROPIC = resolveOfficialVisualDeliveryLimits(
  'claude',
  'https://api.anthropic.com/',
  'completeWithTools'
)!
const PNG_2X2_BYTES = Buffer.from(PNG_2X2_BASE64, 'base64').length

/** The real child reader, with every job it receives recorded. */
function countingRunner(): { runJob: RunDocumentJob; jobs: DocumentJob[] } {
  const jobs: DocumentJob[] = []
  const runJob: RunDocumentJob = (job, signal) => {
    jobs.push(job)
    return runDocumentJob(job, signal)
  }
  return { runJob, jobs }
}

function documentTool(file: Attachment, runJob: RunDocumentJob): DocumentReadTool {
  const message: IncomingMessage = {
    content: 'Read the document',
    channelType: 'rpc',
    channelId: 'document-agent',
    sender: 'document-user',
    timestamp: '2026-10-20T10:00:00Z',
    messageId: 'document-visual-budget',
    hostRef: 'document-host',
    attachments: [file],
  }
  return new DocumentReadTool(message, {
    contextWindowTokens: 200_000,
    ledger: new AttachmentReadLedger(),
    redactor: { toolOutputRedactionRanges: () => [] },
    runJob,
    limits: documentLimits(),
  })
}

function visualInput(profile: VisualDeliveryLimits, budget = new VisualInputBudget()) {
  return {
    budget,
    resolveCapability: async () => ({
      status: 'supported' as const,
      provider: 'fixture-provider',
      model: 'fixture-model',
      evidence: 'test fixture',
      deliveryLimits: profile,
    }),
  }
}

function context(
  profile: VisualDeliveryLimits,
  requestImages: RequestImageUsage | undefined,
  budget = new VisualInputBudget()
): ExecutionContext {
  return {
    onOutput: () => undefined,
    measureResult: raw => Math.ceil(Buffer.byteLength(raw) / 4) + 4,
    ...(requestImages ? { requestImages } : {}),
    visualInput: visualInput(profile, budget),
  }
}

/**
 * A user message carrying `count` earlier images, as a composer would send;
 * `side` gives them a producer-measured square shape.
 */
function earlierImages(count: number, side?: number): ChatMessage {
  return {
    role: 'user',
    content: 'Earlier images',
    contentParts: [
      { type: 'text', text: 'Earlier images' },
      ...Array.from({ length: count }, (_, index) => ({
        type: 'image' as const,
        mimeType: 'image/png' as const,
        data: PNG_2X2_BASE64,
        ...(side === undefined ? {} : { width: side, height: side }),
        source: { kind: 'attachment' as const, attachmentId: `att-${index}`, messageId: 'msg-1' },
      })),
    ],
  }
}

function toolResult(
  id: string,
  output: { content: string; is_error: boolean },
  attachments?: Attachment[]
): ToolResult {
  return {
    tool_call_id: id,
    name: 'clerum__document_read',
    content: output.content,
    is_error: output.is_error,
    attachments,
  }
}

function pages(body: { images?: Array<{ page: number }> }): number[] {
  return (body.images ?? []).map(image => image.page)
}

function codexRequest(attachmentId: string, data: string) {
  return parseCodexCompletionRequest({
    schemaVersion: 'codex-completion-request.v2',
    requestId: 'req-document',
    idempotencyKey: 'idem-document',
    provider: 'codex-subscription',
    model: 'gpt-5.1',
    deadlineMs: 1000,
    messages: [
      {
        role: 'user',
        content: 'Rendered page',
        contentParts: [
          { type: 'text', text: 'Rendered page' },
          {
            type: 'image',
            mimeType: 'image/png',
            data,
            source: { kind: 'tool', attachmentId, toolCallId: 'call-document-1' },
          },
        ],
      },
    ],
  })
}

describe('document visual reads and the request image bounds', () => {
  it('N1: a rendered page id is accepted by the Codex request contract', async () => {
    const file = admittedFile('scan', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const output = await documentTool(file, runDocumentJob).execute(
      { attachmentId: file.id, mode: 'visual' },
      context(CODEX, { images: 0, bytes: 0, maxSide: 0 })
    )
    // Witness: a real page was rendered.
    expect(JSON.parse(output.content)).toMatchObject({ status: 'ok', images: [{ page: 1 }] })
    const [image] = output.attachments!
    expect(image!.id).toMatch(/^clerum__document_read:[0-9a-f]{64}:page-1$/)
    expect(codexRequest(image!.id, image!.dataBase64!).ok).toBe(true)
    // Control: the id built from the raw reference id is refused.
    const rawId = `clerum__document_read:${file.fileReference!.id}:page-1`
    expect(codexRequest(rawId, image!.dataBase64!).ok).toBe(false)
  }, 15_000)

  it('delivers at most the request image cap over a 24-page document and then pauses', async () => {
    const file = admittedFile(
      'long-scan',
      await textPdf(Array.from({ length: 24 }, () => witnessCode())),
      'application/pdf'
    )
    const { runJob, jobs } = countingRunner()
    const reader = documentTool(file, runJob)
    const results: ToolResult[] = []
    let cursor: string | undefined
    const delivered: number[] = []
    for (let call = 1; call <= 5; call += 1) {
      const output = await reader.execute(
        { attachmentId: file.id, mode: 'visual', ...(cursor ? { cursor } : {}) },
        context(CODEX, requestImageUsage([], results))
      )
      const body = JSON.parse(output.content)
      expect(body.status).toBe('ok')
      delivered.push(...pages(body))
      cursor = body.continuation?.cursor
      results.push(toolResult(`call-${call}`, output, output.attachments))
    }
    expect(delivered).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    expect(cursor).toBe(boundCursor('v1.pdf.21.0', file))
    expect(jobs).toHaveLength(5)

    const sixth = await reader.execute(
      { attachmentId: file.id, mode: 'visual', cursor },
      context(CODEX, requestImageUsage([], results))
    )
    expect(JSON.parse(sixth.content)).toEqual({
      status: 'read_budget_exhausted',
      attachmentId: file.id,
      referenceId: file.fileReference!.id,
      resumeCursor: boundCursor('v1.pdf.21.0', file),
      message: IMAGE_MESSAGE,
    })
    expect(sixth.attachments).toBeUndefined()
    expect(jobs).toHaveLength(5)
  }, 60_000)

  it('counts the batch results before each call of the same batch', async () => {
    const run = async (earlier: number) => {
      const file = admittedFile(
        'batch-scan',
        await textPdf(Array.from({ length: 8 }, () => witnessCode())),
        'application/pdf'
      )
      const reader = documentTool(file, runDocumentJob)
      const registry: ToolRegistry = {
        get: name => (name === reader.name() ? reader : null),
        listDefinitions: () => [],
        register: vi.fn(),
      }
      const reasoning: ReasoningPort = {
        respondWithTools: vi.fn(),
        continueWithToolResults: vi.fn(),
      }
      const config = buildLoopConfig({
        reasoning,
        toolRegistry: registry,
        safety: new BasicSafety(),
        events: new SimpleEventEmitter(),
        conversation: makeFakeConversation(),
        maxIterations: 10,
      })
      config.measureToolMessage = message => Math.ceil((message.content ?? '').length / 4) + 4
      config.visualInput = visualInput(CODEX)
      const batch = await executeToolCalls(
        [
          {
            id: 'call-a',
            name: reader.name(),
            arguments: { attachmentId: file.id, mode: 'visual' },
          },
          {
            id: 'call-b',
            name: reader.name(),
            arguments: {
              attachmentId: file.id,
              mode: 'visual',
              cursor: boundCursor('v1.pdf.5.0', file),
            },
          },
        ],
        config,
        0,
        [earlierImages(earlier)]
      )
      return { file, bodies: batch.toolResults.map(result => JSON.parse(result.rawContent!)) }
    }

    const narrow = await run(18)
    const [first, second] = narrow.bodies
    expect(first.status).toBe('ok')
    expect(pages(first)).toEqual([1, 2])
    expect(first.continuation).toEqual({
      cursor: boundCursor('v1.pdf.3.0', narrow.file),
      limit: 'image_budget',
    })
    expect(second).toMatchObject({ status: 'read_budget_exhausted', message: IMAGE_MESSAGE })

    // Witness: with 16 earlier images the first call fills its page cap.
    const open = await run(16)
    const [wide] = open.bodies
    expect(pages(wide)).toEqual([1, 2, 3, 4])
    expect(wide.continuation).toEqual({
      cursor: boundCursor('v1.pdf.5.0', open.file),
      limit: 'max_pages',
    })
  }, 60_000)

  it('requestImageUsage counts every image the next request carries', () => {
    const image = (id: string, extra: Partial<Attachment> = {}): Attachment => ({
      id,
      kind: 'image',
      mimeType: 'image/png',
      encoding: 'base64',
      dataBase64: PNG_2X2_BASE64,
      ...extra,
    })
    const messages: ChatMessage[] = [
      earlierImages(2),
      {
        role: 'user',
        content: 'GFS image',
        contentParts: [
          { type: 'text', text: 'GFS image' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: PNG_2X2_BASE64,
            source: {
              kind: 'gfs',
              drive: 'personal',
              resourceId: 'res-1',
              gfsUri: 'gfs://personal/res-1',
              version: 1,
              name: 'photo.png',
            },
          },
        ],
      },
    ]
    const ok = { content: '{}', is_error: false }
    const results = [
      // The same bytes from two calls are two images of the request.
      toolResult('call-1', ok, [image('a')]),
      toolResult('call-2', ok, [image('b'), image('gif', { mimeType: 'image/gif' })]),
      toolResult('call-3', { content: 'failed', is_error: true }, [image('c')]),
    ]
    // Images without producer geometry make the longest side unknown.
    expect(requestImageUsage(messages, results)).toEqual({
      images: 5,
      bytes: 5 * PNG_2X2_BYTES,
      maxSide: Infinity,
    })
    expect(requestImageUsage(messages, [])).toEqual({
      images: 3,
      bytes: 3 * PNG_2X2_BYTES,
      maxSide: Infinity,
    })
    expect(requestImageUsage([], [])).toEqual({ images: 0, bytes: 0, maxSide: 0 })
  })

  it('requestImageUsage reports the longest side of composer and tool images', () => {
    const measured = (id: string, width?: number, height?: number): Attachment => ({
      id,
      kind: 'image',
      mimeType: 'image/png',
      encoding: 'base64',
      dataBase64: PNG_2X2_BASE64,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    })
    const ok = { content: '{}', is_error: false }
    const composer = [earlierImages(2, 1500)]
    expect(requestImageUsage(composer, []).maxSide).toBe(1500)
    expect(
      requestImageUsage(composer, [toolResult('call-1', ok, [measured('page', 2400, 10)])]).maxSide
    ).toBe(2400)
    // A tool image with one side missing counts as unknown.
    expect(
      requestImageUsage(composer, [toolResult('call-1', ok, [measured('page', 2400)])]).maxSide
    ).toBe(Infinity)
    // A failed result never reaches the request.
    expect(
      requestImageUsage(composer, [
        toolResult('call-1', { content: 'failed', is_error: true }, [measured('page', 4032, 3024)]),
      ]).maxSide
    ).toBe(1500)
  })

  it.each([
    [
      'full',
      () => {
        const budget = new VisualInputBudget()
        budget.reserve(budget.remainingResidentBytes)
        return budget
      },
    ],
    [
      'overflowed',
      () => {
        const budget = new VisualInputBudget(1_000)
        budget.observeExternalImage('A'.repeat(501))
        return budget
      },
    ],
  ])(
    'pauses without a worker when the turn image memory is %s',
    async (_label, spent) => {
      const file = admittedFile('scan', await imageOnlyPdf(witnessCode()), 'application/pdf')
      const { runJob, jobs } = countingRunner()
      const output = await documentTool(file, runJob).execute(
        { attachmentId: file.id, mode: 'visual' },
        context(CODEX, { images: 0, bytes: 0, maxSide: 0 }, spent())
      )
      expect(JSON.parse(output.content)).toMatchObject({
        status: 'read_budget_exhausted',
        message: IMAGE_MESSAGE,
      })
      expect(output.attachments).toBeUndefined()
      expect(jobs).toHaveLength(0)

      // Witness: a fresh budget renders the same page through the same runner.
      const fresh = await documentTool(file, runJob).execute(
        { attachmentId: file.id, mode: 'visual' },
        context(CODEX, { images: 0, bytes: 0, maxSide: 0 })
      )
      expect(fresh.attachments).toHaveLength(1)
      expect(jobs).toHaveLength(1)
    },
    15_000
  )

  it('renders pages at the many-image dimension on a threshold profile only', async () => {
    const file = admittedFile('wide-page', await textPdf([witnessCode()]), 'application/pdf')
    const longest = async (profile: VisualDeliveryLimits) => {
      const output = await documentTool(file, runDocumentJob).execute(
        { attachmentId: file.id, mode: 'visual' },
        context(profile, { images: 0, bytes: 0, maxSide: 0 })
      )
      const [image] = output.attachments!
      return Math.max(image!.width!, image!.height!)
    }
    expect(await longest(ANTHROPIC)).toBe(2000)
    // Witness: a profile without the threshold renders the same page at the
    // tool's own bound.
    expect(await longest(CODEX)).toBe(2048)
  }, 30_000)

  it('keeps a request with a large image at the threshold count', async () => {
    const file = admittedFile(
      'threshold-scan',
      await textPdf(Array.from({ length: 4 }, () => witnessCode())),
      'application/pdf'
    )
    const read = async (images: number, maxSide: number) => {
      const { runJob, jobs } = countingRunner()
      const output = await documentTool(file, runJob).execute(
        { attachmentId: file.id, mode: 'visual' },
        context(ANTHROPIC, { images, bytes: images * PNG_2X2_BYTES, maxSide })
      )
      return { body: JSON.parse(output.content), output, jobs }
    }

    const cut = await read(18, 4032)
    expect(pages(cut.body)).toEqual([1, 2])
    expect(cut.body.continuation).toEqual({
      cursor: boundCursor('v1.pdf.3.0', file),
      limit: 'image_budget',
    })

    const full = await read(20, 4032)
    expect(full.body).toMatchObject({ status: 'read_budget_exhausted', message: IMAGE_MESSAGE })
    expect(full.output.attachments).toBeUndefined()
    expect(full.jobs).toHaveLength(0)

    // Witness: earlier images within the threshold dimension leave the page cap.
    const small = await read(18, 1500)
    expect(pages(small.body)).toEqual([1, 2, 3, 4])
    expect(small.jobs).toHaveLength(1)
  }, 30_000)

  it('counts a large composer image before each call of a Claude batch', async () => {
    const run = async (largeSide: number) => {
      const file = admittedFile(
        'claude-batch-scan',
        await textPdf(Array.from({ length: 8 }, () => witnessCode())),
        'application/pdf'
      )
      const reader = documentTool(file, runDocumentJob)
      const config = buildLoopConfig({
        reasoning: { respondWithTools: vi.fn(), continueWithToolResults: vi.fn() },
        toolRegistry: {
          get: name => (name === reader.name() ? reader : null),
          listDefinitions: () => [],
          register: vi.fn(),
        },
        safety: new BasicSafety(),
        events: new SimpleEventEmitter(),
        conversation: makeFakeConversation(),
        maxIterations: 10,
      })
      config.measureToolMessage = message => Math.ceil((message.content ?? '').length / 4) + 4
      config.visualInput = visualInput(ANTHROPIC)
      const batch = await executeToolCalls(
        [
          {
            id: 'call-a',
            name: reader.name(),
            arguments: { attachmentId: file.id, mode: 'visual' },
          },
          {
            id: 'call-b',
            name: reader.name(),
            arguments: { attachmentId: file.id, mode: 'visual', pages: '5-8' },
          },
        ],
        config,
        0,
        [earlierImages(18, 1000), earlierImages(1, largeSide)]
      )
      return batch.toolResults.map(result => JSON.parse(result.rawContent!))
    }

    const [first, second] = await run(4032)
    expect(pages(first)).toEqual([1])
    expect(first.continuation).toMatchObject({ limit: 'image_budget' })
    expect(second).toMatchObject({ status: 'read_budget_exhausted', message: IMAGE_MESSAGE })

    // Witness: the same composer image at 1500 px leaves both calls their page cap.
    const [wideA, wideB] = await run(1500)
    expect(pages(wideA)).toEqual([1, 2, 3, 4])
    expect(pages(wideB)).toEqual([5, 6, 7, 8])
  }, 60_000)

  it('reports a page that does not fit the bytes the request has left as a pause', async () => {
    const file = admittedFile('scan', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const { runJob, jobs } = countingRunner()
    const tight = await documentTool(file, runJob).execute(
      { attachmentId: file.id, mode: 'visual' },
      context(CODEX, { images: 0, bytes: CODEX.maxTotalImageBytes! - 64, maxSide: 0 })
    )
    expect(jobs).toHaveLength(1)
    expect(JSON.parse(tight.content)).toMatchObject({
      status: 'read_budget_exhausted',
      message: IMAGE_MESSAGE,
    })
    expect(tight.is_error).toBe(false)

    // Witness: the full allowance renders the same page.
    const full = await documentTool(file, runJob).execute(
      { attachmentId: file.id, mode: 'visual' },
      context(CODEX, { images: 0, bytes: 0, maxSide: 0 })
    )
    expect(full.attachments).toHaveLength(1)
  }, 15_000)

  it('refuses a visual read without the request image usage', async () => {
    const file = admittedFile('scan', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const { runJob, jobs } = countingRunner()
    await expect(
      documentTool(file, runJob).execute(
        { attachmentId: file.id, mode: 'visual' },
        context(CODEX, undefined)
      )
    ).rejects.toThrow('Document visual read requires the request image usage')
    expect(jobs).toHaveLength(0)

    // Witness: the same call with a usage value renders.
    const rendered = await documentTool(file, runJob).execute(
      { attachmentId: file.id, mode: 'visual' },
      context(CODEX, { images: 0, bytes: 0, maxSide: 0 })
    )
    expect(rendered.attachments).toHaveLength(1)
  }, 15_000)

  it('executeSingleTool hands the resumed call the usage of its frozen request', async () => {
    const file = admittedFile('scan', await imageOnlyPdf(witnessCode()), 'application/pdf')
    const reader = documentTool(file, runDocumentJob)
    const config = buildLoopConfig({
      reasoning: { respondWithTools: vi.fn(), continueWithToolResults: vi.fn() },
      toolRegistry: {
        get: name => (name === reader.name() ? reader : null),
        listDefinitions: () => [],
        register: vi.fn(),
      },
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 10,
    })
    config.measureToolMessage = message => Math.ceil((message.content ?? '').length / 4) + 4
    config.visualInput = visualInput(CODEX)
    const call = {
      id: 'call-resumed',
      name: reader.name(),
      arguments: { attachmentId: file.id, mode: 'visual' },
    }
    const completed = [
      toolResult('call-before', { content: '{}', is_error: false }, [
        {
          id: 'img',
          kind: 'image',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: PNG_2X2_BASE64,
        },
      ]),
    ]

    const paused = await executeSingleTool(
      call,
      config,
      undefined,
      undefined,
      requestImageUsage([earlierImages(19)], completed)
    )
    expect(JSON.parse(paused.rawContent!)).toMatchObject({
      status: 'read_budget_exhausted',
      message: IMAGE_MESSAGE,
    })

    // Witness: the same call with room in the frozen request renders.
    const rendered = await executeSingleTool(
      call,
      config,
      undefined,
      undefined,
      requestImageUsage([earlierImages(18)], completed)
    )
    expect(JSON.parse(rendered.rawContent!)).toMatchObject({ status: 'ok', images: [{ page: 1 }] })
    expect(rendered.attachments).toHaveLength(1)
  }, 15_000)
})
