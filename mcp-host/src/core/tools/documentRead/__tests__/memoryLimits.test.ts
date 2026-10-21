import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { type ChildProcess, spawn } from 'node:child_process'
import { serialize } from 'node:v8'
import type {
  DocumentJob,
  DocumentJobOutcome,
  DocumentLimitName,
  PdfVisualJob,
  XlsxOutcome,
} from '../types'
import { runDocumentJob } from '../workerRunner'
import { documentLimits, valuesWorkbook, witnessCode } from './fixtures'
import {
  aggregateWorkbook,
  inflatedImagePdf,
  inflatedTextPdf,
  inflatedWorkbook,
  sharedStringWorkbook,
  underdeclaredPartWorkbook,
  underdeclaredWorkbook,
  zip64Workbook,
} from './memoryFixtures'

// Observe real IPC messages without replacing the child or either parser.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => actual.spawn(...args)),
  }
})
afterEach(() => vi.clearAllMocks())

const MiB = 1_048_576
function expectLimit(outcome: DocumentJobOutcome<DocumentJob>, limit: DocumentLimitName): void {
  // A failed mutation reports metadata, never the document or PNG payload.
  expect(outcome.ok ? { ok: true } : outcome).toEqual({
    ok: false,
    reason: 'document_limits_exceeded',
    limit,
  })
}
function xlsx(bytes: Buffer, limits = documentLimits()): DocumentJob {
  return { kind: 'xlsx', bytes, sheet: 'Values', start: null, limits }
}

function pdfText(bytes: Buffer, limits = documentLimits()): DocumentJob {
  return { kind: 'pdf_text', bytes, pages: null, start: { page: 1, charOffset: 0 }, limits }
}

function pdfVisual(bytes: Buffer, limits = documentLimits()): PdfVisualJob {
  return {
    kind: 'pdf_visual',
    bytes,
    pages: null,
    maxDimension: 128,
    maxPixelsPerCall: 128 * 128,
    maxImageBytes: MiB,
    maxTotalImageBytes: MiB,
    limits,
  }
}

describe('document reader real-process memory limits', () => {
  it('skips unused XLSX media and keeps Host growth below 32 MiB', async () => {
    // Review baseline: 516 KB -> 1.9 GB RSS; 1.5 MB -> 4.6 GB in the Host.
    const bytes = await inflatedWorkbook(128 * MiB)
    const limits = documentLimits({ maxResidentMb: 256, maxUncompressedBytes: 256 * MiB })
    const code = witnessCode()
    const control = (await runDocumentJob(xlsx(await valuesWorkbook(code), limits))) as XlsxOutcome
    expect(control.ok).toBe(true)
    if (!control.ok) throw new Error('XLSX media control failed')
    expect(control.sheets[0]!.rows[0]![0]).toBe(code)
    const before = process.memoryUsage().rss
    const outcome = (await runDocumentJob(xlsx(bytes, limits))) as XlsxOutcome
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('XLSX media fixture failed')
    // The unused media is never inflated; the real workbook still parses.
    expect(outcome.sheets[0]!.rows.length).toBeGreaterThan(0)
    expect(outcome.sheets[0]!.lastRow).toBe(8)
    const after = process.memoryUsage().rss
    expect(after - before).toBeLessThanOrEqual(32 * MiB)
    process.stdout.write(
      'XLSX Host RSS witness ' +
        JSON.stringify({
          before,
          after,
          growth: after - before,
          bound: 32 * MiB,
          rows: outcome.sheets[0]!.rows.length,
          lastRow: outcome.sheets[0]!.lastRow,
        }) +
        '\n'
    )
    expect((await runDocumentJob(xlsx(await valuesWorkbook(witnessCode()), limits))).ok).toBe(true)
  }, 20_000)

  it('checks ZIP declared expansion before load with a normal-size control', async () => {
    const limits = documentLimits({ maxUncompressedBytes: MiB })
    const bytes = await inflatedWorkbook(8 * MiB)
    expect((await runDocumentJob(xlsx(await valuesWorkbook(witnessCode()), limits))).ok).toBe(true)
    expectLimit(await runDocumentJob(xlsx(bytes, limits)), 'uncompressed_bytes')
  }, 10_000)

  it('bounds aggregate ZIP expansion even when each entry fits, with a smaller control', async () => {
    const limits = documentLimits({ maxUncompressedBytes: MiB })
    expect((await runDocumentJob(xlsx(await aggregateWorkbook(100_000), limits))).ok).toBe(true)
    expectLimit(
      await runDocumentJob(xlsx(await aggregateWorkbook(600_000), limits)),
      'uncompressed_bytes'
    )
  }, 10_000)

  it('bounds unsigned ZIP64 entry sizes and reads a valid ZIP64-size control', async () => {
    expect((await runDocumentJob(xlsx(await zip64Workbook(1_024n)))).ok).toBe(true)
    expectLimit(await runDocumentJob(xlsx(await zip64Workbook(1n << 54n))), 'uncompressed_bytes')
  }, 10_000)

  it('does not inflate forged XLSX media sizes and parses the real workbook', async () => {
    const bytes = await underdeclaredWorkbook(128 * MiB)
    const limits = documentLimits({ maxResidentMb: 256, maxUncompressedBytes: MiB })
    const code = witnessCode()
    const control = (await runDocumentJob(xlsx(await valuesWorkbook(code), limits))) as XlsxOutcome
    expect(control.ok).toBe(true)
    if (!control.ok) throw new Error('XLSX forged-media control failed')
    expect(control.sheets[0]!.rows[0]![0]).toBe(code)
    const outcome = (await runDocumentJob(xlsx(bytes, limits))) as XlsxOutcome
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('XLSX forged-media fixture failed')
    // The forged media is not a selected part, so it is never inflated.
    expect(outcome.sheets[0]!.rows.length).toBeGreaterThan(0)
    expect(outcome.sheets[0]!.lastRow).toBe(8)
  }, 20_000)

  it('counts real inflated sheet and shared-string bytes, with a valid control', async () => {
    const limits = documentLimits({ maxUncompressedBytes: 64 * 1024 })
    const code = witnessCode()
    const control = (await runDocumentJob(xlsx(await valuesWorkbook(code), limits))) as XlsxOutcome
    expect(control.ok).toBe(true)
    if (!control.ok) throw new Error('XLSX real-counter control failed')
    expect(control.sheets[0]!.rows[0]![0]).toBe(code)
    // Both parts declare 1 KiB but inflate to 256 KiB of text.
    expectLimit(
      await runDocumentJob(xlsx(await underdeclaredPartWorkbook('sheet', 256 * 1024), limits)),
      'uncompressed_bytes'
    )
    expectLimit(
      await runDocumentJob(
        xlsx(await underdeclaredPartWorkbook('sharedStrings', 256 * 1024), limits)
      ),
      'uncompressed_bytes'
    )
  }, 20_000)

  it('RSS kills a blocking PDF FlateStream while a normal text PDF succeeds', async () => {
    // Review baseline: a 510 KB / 512 MiB content stream reached 1.28 GB RSS.
    const bytes = inflatedTextPdf(128 * MiB)
    const limits = documentLimits({ maxResidentMb: 256 })
    expect((await runDocumentJob(pdfText(inflatedTextPdf(1_024), limits))).ok).toBe(true)
    expectLimit(await runDocumentJob(pdfText(bytes, limits)), 'heap')
    expect((await runDocumentJob(pdfText(inflatedTextPdf(1_024), limits))).ok).toBe(true)
  }, 20_000)

  it('bounds a FlateDecode image before decoding and renders a normal-size control', async () => {
    // Review baseline: a 138 KB / 12000 x 12000 image reached 2.2 GB RSS.
    const limits = documentLimits({ maxRenderPixelsPerCall: MiB })
    const control = await runDocumentJob(pdfVisual(inflatedImagePdf(2480, 3508), limits))
    expect(control.ok).toBe(true)
    if (!control.ok) throw new Error('Image control failed')
    expect(control.images[0]!.png.byteLength).toBeGreaterThan(0)
    const image = await loadImage(Buffer.from(control.images[0]!.png))
    const canvas = createCanvas(image.width, image.height)
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    expect([...context.getImageData(64, 64, 1, 1).data]).toEqual([65, 65, 65, 255])
    expectLimit(await runDocumentJob(pdfVisual(inflatedImagePdf(6_500), limits)), 'pixels')
  }, 10_000)

  it('counts raw PNG bytes inside the child before IPC and renders a control', async () => {
    const bytes = inflatedImagePdf(128)
    const control = await runDocumentJob(pdfVisual(bytes))
    expect(control.ok).toBe(true)
    if (!control.ok) throw new Error('PNG control failed')
    expect(control.images[0]!.png.byteLength).toBeGreaterThan(256)
    const previousSpawns = vi.mocked(spawn).mock.calls.length
    const pending = runDocumentJob(pdfVisual(bytes, documentLimits({ maxOutputBytes: 256 })))
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(previousSpawns + 1))
    const child = vi.mocked(spawn).mock.results.at(-1)!.value as ChildProcess
    let received: { ok: unknown; reason: unknown; limit: unknown } | undefined
    child.once('message', message => {
      const result = message as { ok: unknown; reason: unknown; limit: unknown }
      received = { ok: result.ok, reason: result.reason, limit: result.limit }
    })
    expectLimit(await pending, 'output_bytes')
    expect(received).toEqual({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'output_bytes',
    })
  }, 10_000)

  it('bounds shared-string fan-out inside the child before IPC with a 32 MiB Host bound', async () => {
    // Review baseline: 100k copies of 2000 chars added about 533 MB to the Host.
    const bytes = await sharedStringWorkbook(20_000, 2_000)
    // The character budget would stop this read first; lifting it here keeps
    // the child's own output_bytes check under test.
    const limits = documentLimits({ maxOutputBytes: MiB, maxExtractedChars: 100_000_000 })
    expect((await runDocumentJob(xlsx(await valuesWorkbook(witnessCode()), limits))).ok).toBe(true)
    const before = process.memoryUsage().rss
    const previousSpawns = vi.mocked(spawn).mock.calls.length
    const pending = runDocumentJob(xlsx(bytes, limits))
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(previousSpawns + 1))
    const child = vi.mocked(spawn).mock.results.at(-1)!.value as ChildProcess
    let received: { ok: unknown; reason: unknown; limit: unknown; bytes: number } | undefined
    child.on('message', message => {
      const result = message as { ok: unknown; reason: unknown; limit: unknown }
      received = {
        ok: result.ok,
        reason: result.reason,
        limit: result.limit,
        bytes: serialize(message).byteLength,
      }
    })
    expectLimit(await pending, 'output_bytes')
    const after = process.memoryUsage().rss
    expect(received).toMatchObject({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'output_bytes',
    })
    expect(received!.bytes).toBeLessThanOrEqual(limits.maxOutputBytes)
    expect(after - before).toBeLessThanOrEqual(32 * MiB)
    process.stdout.write(
      'Fan-out Host RSS witness ' +
        JSON.stringify({
          before,
          after,
          growth: after - before,
          bound: 32 * MiB,
        }) +
        '\n'
    )
    expect((await runDocumentJob(xlsx(await valuesWorkbook(witnessCode()), limits))).ok).toBe(true)
  }, 20_000)
})
