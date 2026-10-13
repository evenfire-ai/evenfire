import { describe, expect, it } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { createHash } from 'node:crypto'
import type { PdfVisualJob, PdfVisualOutcome } from '../types'
import { runDocumentJob } from '../workerRunner'
import { documentLimits, emptyPdf, imageOnlyPdf, textPdf, witnessCode } from './fixtures'

function pdfVisualJob(
  bytes: Buffer,
  overrides: Partial<Omit<PdfVisualJob, 'kind' | 'bytes'>> = {}
): PdfVisualJob {
  return {
    kind: 'pdf_visual',
    bytes: new Uint8Array(bytes),
    pages: null,
    maxDimension: 64,
    maxPixelsPerCall: 4_096,
    maxImageBytes: 1_000_000,
    maxTotalImageBytes: 8_000_000,
    limits: documentLimits(),
    ...overrides,
  }
}

function bitFor(code: string, index: number): boolean {
  const digest = createHash('sha256').update(code).digest()
  return (digest[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0
}

async function samplePng(png: Uint8Array): Promise<Array<boolean>> {
  const image = await loadImage(Buffer.from(png))
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const { data } = context.getImageData(0, 0, image.width, image.height)
  const sampleAt = (x: number, y: number): boolean => {
    const offset = (y * image.width + x) * 4
    return data[offset]! < 128
  }
  const observed: boolean[] = []
  for (let index = 0; index < 64; index += 1) {
    observed.push(sampleAt((index % 8) * 8 + 4, Math.floor(index / 8) * 8 + 4))
  }
  return observed
}

describe('PDF visual rendering through the real worker', () => {
  it('reports a zero-page PDF as document_empty and renders a readable control', async () => {
    expect(await runDocumentJob(pdfVisualJob(await emptyPdf()))).toEqual({
      ok: false,
      reason: 'document_empty',
    })
    expect((await runDocumentJob(pdfVisualJob(await imageOnlyPdf(witnessCode())))).ok).toBe(true)
  })
  it('delivers a random pixel-only code at the requested dimension limit', async () => {
    const code = witnessCode()
    const outcome = (await runDocumentJob(
      pdfVisualJob(await imageOnlyPdf(code), { maxDimension: 64 })
    )) as Extract<PdfVisualOutcome, { ok: true }>

    expect(outcome.ok).toBe(true)
    expect(outcome.pageCount).toBe(1)
    expect(outcome.images).toHaveLength(1)
    const image = outcome.images[0]!
    expect(image.page).toBe(1)
    expect(image.width).toBe(64)
    expect(image.height).toBe(64)
    expect(image.width * image.height).toBeLessThanOrEqual(4_096)
    expect(image.png.byteLength).toBeGreaterThan(0)
    // The same random code is present as the sampled black/white pixel grid;
    // the PDF has no text operator, so this is a pixel-path witness.
    expect(await samplePng(image.png)).toEqual(
      Array.from({ length: 64 }, (_, i) => bitFor(code, i))
    )
  })

  it('paginates a selection wider than the visual page limit and renders its continuation', async () => {
    const bytes = await textPdf([witnessCode(), witnessCode()])
    const first = await runDocumentJob(
      pdfVisualJob(bytes, {
        pages: '1-2',
        limits: documentLimits({ maxVisualPagesPerCall: 1 }),
      })
    )
    expect(first).toMatchObject({
      ok: true,
      images: [{ page: 1 }],
      next: { page: 2, charOffset: 0 },
      stoppedBy: 'max_pages',
    })
    const witness = await runDocumentJob(
      pdfVisualJob(bytes, {
        pages: '1-2',
        start: { page: 2, charOffset: 0 },
        limits: documentLimits({ maxVisualPagesPerCall: 1 }),
      })
    )
    expect(witness).toMatchObject({ ok: true, images: [{ page: 2 }] })
    expect(witness.ok && witness.next).toBeUndefined()
  })

  it('applies the shared pixel budget across every selected page', async () => {
    const bytes = await textPdf([witnessCode(), witnessCode()])
    const outcome = (await runDocumentJob(
      pdfVisualJob(bytes, { pages: '1-2', maxPixelsPerCall: 2 })
    )) as Extract<PdfVisualOutcome, { ok: true }>
    expect(outcome.images.map(image => [image.width, image.height])).toEqual([
      [1, 1],
      [1, 1],
    ])
  })

  it('resolves image_bytes after retries while the same renderer succeeds with its normal bound', async () => {
    const bytes = await imageOnlyPdf(witnessCode())
    expect(await runDocumentJob(pdfVisualJob(bytes, { maxImageBytes: 1 }))).toEqual({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'image_bytes',
    })
    expect(await runDocumentJob(pdfVisualJob(bytes))).toMatchObject({ ok: true })
  })
})
