import { afterEach, describe, expect, it, vi } from 'vitest'
import * as pdfLoad from '../pdfLoad'
import { parsePdfText } from '../pdfText'
import type { PdfTextJob, PdfTextOutcome } from '../types'
import { runDocumentJob } from '../workerRunner'
import {
  documentLimits,
  emptyPdf,
  encryptedPdf,
  imageOnlyPdf,
  malformedPdf,
  textPdf,
  witnessCode,
} from './fixtures'

function pdfTextJob(
  bytes: Buffer,
  overrides: Partial<Omit<PdfTextJob, 'kind' | 'bytes'>> = {}
): PdfTextJob {
  return {
    kind: 'pdf_text',
    bytes: new Uint8Array(bytes),
    pages: null,
    start: { page: 1, charOffset: 0 },
    limits: documentLimits(),
    ...overrides,
  }
}

async function readPdf(job: PdfTextJob): Promise<PdfTextOutcome> {
  return runDocumentJob(job)
}

afterEach(() => vi.restoreAllMocks())

describe('PDF textless-window inspection', () => {
  it('inspects beyond the returned-page budget until text is found and keeps the returned window capped', async () => {
    const inspected: number[] = []
    const getPage = async (page: number) => {
      inspected.push(page)
      return {
        getTextContent: async () => ({
          items: page === 3 ? [{ str: 'later text', hasEOL: false }] : [],
        }),
        cleanup: () => undefined,
      }
    }
    const load = vi
      .spyOn(pdfLoad, 'withPdfDocument')
      .mockImplementationOnce(async (_job, read) => read({ numPages: 3, getPage } as never))
    const job = pdfTextJob(Buffer.alloc(0), {
      limits: documentLimits({
        maxTextPagesPerCall: 1,
        maxExtractedChars: 1,
        maxPageCount: 3,
        timeoutMs: 1_000,
      }),
    })
    const outcome = await parsePdfText(job)
    expect(outcome).toMatchObject({
      ok: true,
      pages: [{ page: 1, text: '', lowText: true }],
      next: { page: 2, charOffset: 0 },
      stoppedBy: 'max_pages',
    })
    expect(inspected).toEqual([1, 2, 3])
    expect(load.mock.calls[0]?.[0].limits).toMatchObject({
      maxTextPagesPerCall: 1,
      maxExtractedChars: 1,
      maxPageCount: 3,
      timeoutMs: 1_000,
    })
    const textless = vi.fn(async () => ({
      getTextContent: async () => ({ items: [] }),
      cleanup: () => undefined,
    }))
    load.mockImplementationOnce(async (_job, read) =>
      read({ numPages: 3, getPage: textless } as never)
    )
    expect(await parsePdfText(job)).toEqual({ ok: false, reason: 'no_text_layer' })
    expect(textless).toHaveBeenCalledTimes(3)
  })

  it('inspects before a resume cursor when its returned window has no text', async () => {
    const inspected: number[] = []
    vi.spyOn(pdfLoad, 'withPdfDocument').mockImplementationOnce(async (_job, read) =>
      read({
        numPages: 3,
        getPage: async (page: number) => {
          inspected.push(page)
          return {
            getTextContent: async () => ({
              items: page === 1 ? [{ str: 'earlier text', hasEOL: false }] : [],
            }),
            cleanup: () => undefined,
          }
        },
      } as never)
    )
    const outcome = await parsePdfText(
      pdfTextJob(Buffer.alloc(0), {
        start: { page: 3, charOffset: 0 },
        limits: documentLimits({ maxTextPagesPerCall: 1 }),
      })
    )
    expect(outcome).toMatchObject({ ok: true, pages: [{ page: 3, text: '', lowText: true }] })
    expect(inspected).toEqual([3, 1])
  })
})

describe('PDF text through the real worker', () => {
  it('extracts the body-only random code and records a low-text page', async () => {
    const code = witnessCode()
    const bytes = await textPdf([code, 'short'])
    const outcome = (await readPdf(pdfTextJob(bytes))) as Extract<PdfTextOutcome, { ok: true }>

    expect(outcome.ok).toBe(true)
    expect(outcome.pageCount).toBe(2)
    expect(outcome.pages[0]).toMatchObject({ page: 1, lowText: false })
    expect(outcome.pages[0]?.text).toContain(code)
    expect(outcome.pages[1]).toMatchObject({
      page: 2,
      lowText: true,
      text: 'short content',
      from: 0,
      to: 'short content'.length,
    })
    expect(outcome.next).toBeUndefined()
  })

  it('stops by max_pages and puts the next selected page in the cursor', async () => {
    const bytes = await textPdf(['one', 'two', 'three'])
    const first = (await readPdf(
      pdfTextJob(bytes, {
        pages: '2-3',
        start: { page: 2, charOffset: 0 },
        limits: documentLimits({ maxTextPagesPerCall: 1 }),
      })
    )) as Extract<PdfTextOutcome, { ok: true }>
    expect(first.pages.map(page => page.page)).toEqual([2])
    expect(first.pages[0]).toMatchObject({ text: 'two content', from: 0, to: 'two content'.length })
    expect(first.next).toEqual({ page: 3, charOffset: 0 })
    expect(first.stoppedBy).toBe('max_pages')

    const second = (await readPdf(
      pdfTextJob(bytes, {
        pages: '2-3',
        start: first.next!,
        limits: documentLimits({ maxTextPagesPerCall: 1 }),
      })
    )) as Extract<PdfTextOutcome, { ok: true }>
    expect(second.pages.map(page => page.page)).toEqual([3])
    expect(second.pages[0]).toMatchObject({ text: 'three content', from: 0 })
    expect(second.next).toBeUndefined()
  })

  it('stops by max_extracted_chars and resumes at the exact UTF-16 offset', async () => {
    const bytes = await textPdf(['abcdefghijklmnopqrst'])
    const first = (await readPdf(
      pdfTextJob(bytes, { limits: documentLimits({ maxExtractedChars: 10 }) })
    )) as Extract<PdfTextOutcome, { ok: true }>
    expect(first.pages[0]).toMatchObject({ from: 0, to: 10 })
    expect(first.next).toEqual({ page: 1, charOffset: 10 })
    expect(first.stoppedBy).toBe('max_extracted_chars')

    const second = (await readPdf(
      pdfTextJob(bytes, { start: first.next!, limits: documentLimits({ maxExtractedChars: 100 }) })
    )) as Extract<PdfTextOutcome, { ok: true }>
    expect(second.pages[0]).toMatchObject({ from: 10, to: 28 })
    expect(second.next).toBeUndefined()
  })

  it('rejects a start cursor outside the selected pages while accepting the selected start', async () => {
    const bytes = await textPdf(['one', 'two'])
    expect(
      await readPdf(pdfTextJob(bytes, { pages: '1-2', start: { page: 5, charOffset: 0 } }))
    ).toEqual({ ok: false, reason: 'invalid_range' })
    expect(
      await readPdf(pdfTextJob(bytes, { pages: '1-2', start: { page: 1, charOffset: 0 } }))
    ).toMatchObject({ ok: true })
  })

  it('reports an image-only selection as no_text_layer, not an empty success', async () => {
    const bytes = await imageOnlyPdf(witnessCode())
    expect(await readPdf(pdfTextJob(bytes))).toEqual({ ok: false, reason: 'no_text_layer' })
    const textWitness = (await readPdf(pdfTextJob(await textPdf([witnessCode()])))) as Extract<
      PdfTextOutcome,
      { ok: true }
    >
    expect(textWitness.ok).toBe(true)
    expect(textWitness.pages[0]?.lowText).toBe(false)
  })

  it('maps unreadable and encrypted PDF data to typed reasons with a readable control', async () => {
    const readable = await textPdf([witnessCode()])
    const truncated = await malformedPdf('truncated', witnessCode())
    const garbage = await malformedPdf('garbage', witnessCode())
    const encrypted = await encryptedPdf(witnessCode())

    expect(await readPdf(pdfTextJob(truncated))).toEqual({
      ok: false,
      reason: 'document_parse_failed',
    })
    expect(await readPdf(pdfTextJob(garbage))).toEqual({
      ok: false,
      reason: 'document_parse_failed',
    })
    expect(await readPdf(pdfTextJob(encrypted))).toEqual({
      ok: false,
      reason: 'document_encrypted',
    })
    expect(await readPdf(pdfTextJob(readable))).toMatchObject({ ok: true })
  })

  it('reports a zero-page PDF as document_empty with a valid control', async () => {
    expect(await readPdf(pdfTextJob(await emptyPdf()))).toEqual({
      ok: false,
      reason: 'document_empty',
    })
    const witness = (await readPdf(pdfTextJob(await textPdf([witnessCode()])))) as Extract<
      PdfTextOutcome,
      { ok: true }
    >
    expect(witness.pageCount).toBe(1)
  })
})
