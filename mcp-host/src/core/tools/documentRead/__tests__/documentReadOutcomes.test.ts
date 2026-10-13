import { describe, expect, it } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { createHash } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import type { IncomingMessage } from '../../../../server/types'
import type { VisualDeliveryLimits } from '../../../../visualInput/deliveryLimits'
import { AttachmentReadLedger } from '../../../attachments/attachmentReadBudget'
import type { ExecutionContext } from '../../../interfaces'
import type { Attachment } from '../../../types'
import { DocumentReadTool } from '../index'
import type { DocumentReadLimits, RunDocumentJob } from '../types'
import { runDocumentJob } from '../workerRunner'
import {
  admittedFile,
  documentLimits,
  emptySelectionWorkbook,
  imageOnlyPdf,
  malformedPdf,
  textPdf,
  valuesWorkbook,
  witnessCode,
} from './fixtures'
import { inflatedImagePdf } from './memoryFixtures'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const profile: VisualDeliveryLimits = {
  maxImages: 4,
  maxVisualRequestBytes: 32_000_000,
  maxDimension: 64,
  maxPixels: 8_000_000,
}

function context(deliveryLimits: VisualDeliveryLimits | null = null): ExecutionContext {
  return {
    onOutput: () => undefined,
    measureResult: raw => Math.ceil(Buffer.byteLength(raw) / 4) + 4,
    visualInput: {
      budget: {} as never,
      resolveCapability: async () =>
        deliveryLimits
          ? {
              status: 'supported',
              provider: 'fixture-provider',
              model: 'fixture-model',
              evidence: 'test fixture',
              deliveryLimits,
            }
          : { status: 'unsupported' },
    },
  }
}

function tool(
  file: Attachment,
  limits: DocumentReadLimits = documentLimits(),
  runJob = runDocumentJob
): DocumentReadTool {
  const message: IncomingMessage = {
    content: 'Read the document',
    channelType: 'rpc',
    channelId: 'document-agent',
    sender: 'document-user',
    timestamp: '2026-10-13T10:00:00Z',
    messageId: 'document-outcomes',
    hostRef: 'document-host',
    attachments: [file],
  }
  return new DocumentReadTool(message, {
    contextWindowTokens: 100_000,
    ledger: new AttachmentReadLedger(),
    redactor: { toolOutputRedactionRanges: () => [] },
    runJob,
    limits,
  })
}

async function imagePages(codes: string[]): Promise<Buffer> {
  const document = await PDFDocument.create()
  for (const code of codes) {
    const source = await PDFDocument.load(await imageOnlyPdf(code))
    const [page] = await document.copyPages(source, [0])
    document.addPage(page)
  }
  return Buffer.from(await document.save())
}

async function gridMatches(dataBase64: string, code: string): Promise<boolean> {
  const image = await loadImage(Buffer.from(dataBase64, 'base64'))
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const digest = createHash('sha256').update(code).digest()
  for (let bit = 0; bit < 64; bit += 1) {
    const x = Math.floor((((bit % 8) + 0.5) * image.width) / 8)
    const y = Math.floor(((Math.floor(bit / 8) + 0.5) * image.height) / 8)
    const black = ctx.getImageData(x, y, 1, 1).data[0]! < 128
    if (black !== ((digest[Math.floor(bit / 8)]! & (1 << (bit % 8))) !== 0)) return false
  }
  return true
}

describe('document reader Tool outcomes through real child readers', () => {
  it.each([undefined, '1-7'])(
    'paginates seven visual pages with pages=%j and renders page seven on call two',
    async pages => {
      const codes = Array.from({ length: 7 }, () => witnessCode())
      const file = admittedFile('seven-pages', await imagePages(codes), 'application/pdf')
      const reader = tool(file)
      const args = { attachmentId: file.id, mode: 'visual', ...(pages ? { pages } : {}) }
      const first = await reader.execute(args, context(profile))
      const firstBody = JSON.parse(first.content)
      expect(firstBody.status).toBe('ok')
      expect(firstBody.images.map((image: { page: number }) => image.page)).toEqual([1, 2, 3, 4])
      expect(firstBody.continuation).toEqual({ cursor: 'v1.pdf.5.0', limit: 'max_pages' })
      expect(first.attachments).toHaveLength(4)
      expect(await gridMatches(first.attachments![0]!.dataBase64!, codes[0]!)).toBe(true)
      const second = await reader.execute(
        { ...args, cursor: firstBody.continuation.cursor },
        context(profile)
      )
      const secondBody = JSON.parse(second.content)
      expect(secondBody.status).toBe('ok')
      expect(secondBody.images.map((image: { page: number }) => image.page)).toEqual([5, 6, 7])
      expect(secondBody.continuation).toBeUndefined()
      expect(second.attachments).toHaveLength(3)
      expect(await gridMatches(second.attachments![2]!.dataBase64!, codes[6]!)).toBe(true)
    },
    15_000
  )

  it('returns page_count through the Tool and reads the same pages within the cap', async () => {
    const file = admittedFile(
      'page-limit',
      await textPdf(['one', 'two', 'three']),
      'application/pdf'
    )
    const limited = await tool(file, documentLimits({ maxPageCount: 2 })).execute(
      { attachmentId: file.id },
      context()
    )
    expect(JSON.parse(limited.content)).toMatchObject({
      status: 'error',
      reason: 'document_limits_exceeded',
      limit: 'page_count',
    })
    const control = await tool(file, documentLimits({ maxPageCount: 3 })).execute(
      { attachmentId: file.id },
      context()
    )
    const body = JSON.parse(control.content)
    expect(body.status).toBe('ok')
    expect(body.pageCount).toBe(3)
    expect(body.pages.map((page: { page: number }) => page.page)).toEqual([1, 2, 3])
  })

  it('returns pixels for an embedded image above 40 MP and renders a 300-dpi A4 scan', async () => {
    const oversized = admittedFile('oversized-image', inflatedImagePdf(6500), 'application/pdf')
    const rejected = await tool(oversized).execute(
      { attachmentId: oversized.id, mode: 'visual' },
      context(profile)
    )
    expect(JSON.parse(rejected.content)).toMatchObject({
      status: 'error',
      reason: 'document_limits_exceeded',
      limit: 'pixels',
    })
    const scan = admittedFile('a4-scan', inflatedImagePdf(2480, 3508), 'application/pdf')
    const accepted = await tool(scan).execute(
      { attachmentId: scan.id, mode: 'visual' },
      context(profile)
    )
    const body = JSON.parse(accepted.content)
    expect(body.status).toBe('ok')
    expect(body.images).toHaveLength(1)
    const image = await loadImage(Buffer.from(accepted.attachments![0]!.dataBase64!, 'base64'))
    const canvas = createCanvas(image.width, image.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    expect([...ctx.getImageData(32, 32, 1, 1).data]).toEqual([65, 65, 65, 255])
  }, 15_000)

  it.each([false, true])(
    'explains no_text_layer for image_input=%j and proves the file renders',
    async supported => {
      const file = admittedFile('scanned', await imageOnlyPdf(witnessCode()), 'application/pdf')
      const result = await tool(file).execute(
        { attachmentId: file.id },
        context(supported ? profile : null)
      )
      const body = JSON.parse(result.content)
      expect(body.reason).toBe('no_text_layer')
      expect(body.message).toContain(
        supported ? 'mode "visual"' : 'Tell the user this file is scanned'
      )
      if (!supported) expect(body.message).toContain('vision-capable model')
      const rendered = await tool(file).execute(
        { attachmentId: file.id, mode: 'visual' },
        context(profile)
      )
      expect(JSON.parse(rendered.content).status).toBe('ok')
      expect(rendered.attachments?.[0]?.dataBase64?.length).toBeGreaterThan(0)
    }
  )

  it('distinguishes malformed/mismatched content from an empty selection and reads a populated control', async () => {
    const malformed = admittedFile(
      'malformed',
      await malformedPdf('garbage', witnessCode()),
      'text/plain'
    )
    expect(malformed.fileReference?.mismatch).toBe(true)
    const failure = await tool(malformed).execute({ attachmentId: malformed.id }, context())
    const failed = JSON.parse(failure.content)
    expect(failed.reason).toBe('document_parse_failed')
    expect(failed.message).toContain('malformed or its content has the wrong format')
    expect(failed.message).toContain('file name or declared media type does not match')
    const workbook = admittedFile(
      'empty-selection',
      await emptySelectionWorkbook(witnessCode()),
      XLSX_MIME
    )
    const empty = await tool(workbook).execute(
      { attachmentId: workbook.id, sheet: 'Empty' },
      context()
    )
    const emptyBody = JSON.parse(empty.content)
    expect(emptyBody.reason).toBe('document_empty')
    expect(emptyBody.message).toContain('holds no content')
    const control = await tool(workbook).execute(
      { attachmentId: workbook.id, sheet: 'Values' },
      context()
    )
    expect(JSON.parse(control.content).status).toBe('ok')
    expect(JSON.parse(control.content).sheets[0].rows.length).toBeGreaterThan(0)
  })

  it('applies the delivery dimension threshold to the actual rendered image count', async () => {
    const file = admittedFile(
      'dimension-pages',
      await textPdf(['one', 'two', 'three']),
      'application/pdf'
    )
    const delivery = { ...profile, maxDimensionAboveImageCount: { count: 2, maxDimension: 32 } }
    const below = await tool(file).execute(
      { attachmentId: file.id, mode: 'visual', pages: '1-2' },
      context(delivery)
    )
    const above = await tool(file).execute(
      { attachmentId: file.id, mode: 'visual' },
      context(delivery)
    )
    const smaller = await tool(file).execute(
      { attachmentId: file.id, mode: 'visual' },
      context({ ...delivery, maxDimension: 24 })
    )
    for (const [result, dimension, count] of [
      [below, 64, 2],
      [above, 32, 3],
      [smaller, 24, 3],
    ] as const) {
      const body = JSON.parse(result.content)
      expect(body.status).toBe('ok')
      expect(body.images).toHaveLength(count)
      expect(
        body.images.every(
          (image: { width: number; height: number }) =>
            Math.max(image.width, image.height) === dimension
        )
      ).toBe(true)
      expect(result.attachments).toHaveLength(count)
    }
  }, 15_000)

  it('caps visual candidates at the next visual call capacity while returning all low-text pages', async () => {
    const file = admittedFile('candidates', await textPdf(['short']), 'application/pdf')
    const runJob: RunDocumentJob = async () =>
      ({
        ok: true,
        pageCount: 7,
        pages: Array.from({ length: 7 }, (_, i) => ({
          page: i + 1,
          text: 'a',
          from: 0,
          to: 1,
          lowText: true,
        })),
      }) as never
    const result = await tool(file, documentLimits(), runJob).execute(
      { attachmentId: file.id },
      context(profile)
    )
    const body = JSON.parse(result.content)
    expect(body.status).toBe('ok')
    expect(body.visualCandidates).toEqual([1, 2, 3, 4])
    expect(body.pages.map((page: { page: number }) => page.page)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const narrower = await tool(file, documentLimits(), runJob).execute(
      { attachmentId: file.id },
      context({ ...profile, maxImages: 2 })
    )
    expect(JSON.parse(narrower.content).visualCandidates).toEqual([1, 2])
    expect(JSON.parse(narrower.content).pages).toHaveLength(7)
  })

  it('documents the deterministic marker for formulas without a cached result', async () => {
    const file = admittedFile('formulas', await valuesWorkbook(witnessCode()), XLSX_MIME)
    expect(tool(file).description()).toContain('[formula] =<formula>')
  })
})
