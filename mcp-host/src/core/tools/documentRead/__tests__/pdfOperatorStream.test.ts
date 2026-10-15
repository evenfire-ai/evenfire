import { afterEach, describe, expect, it, vi } from 'vitest'
import * as pdfLoad from '../pdfLoad'
import { renderPdfPages } from '../pdfRender'
import type { PdfVisualJob } from '../types'
import { runDocumentJob } from '../workerRunner'
import { documentLimits, imageOnlyPdf, witnessCode } from './fixtures'

afterEach(() => vi.restoreAllMocks())

describe('pdfjs operator-stream compatibility', () => {
  it('fails loudly when the private stream contract disappears and renders with the installed contract', async () => {
    const job: PdfVisualJob = {
      kind: 'pdf_visual',
      bytes: await imageOnlyPdf(witnessCode()),
      pages: null,
      maxDimension: 64,
      maxPixelsPerCall: 4096,
      maxImageBytes: 1_000_000,
      maxTotalImageBytes: 1_000_000,
      limits: documentLimits(),
    }
    const cleanup = vi.fn()
    const getPage = vi.fn(async () => ({ pageNumber: 1, cleanup }))
    vi.spyOn(pdfLoad, 'withPdfDocument').mockImplementationOnce(async (_job, read) =>
      read({ numPages: 1, getPage } as never)
    )
    await expect(renderPdfPages(job)).rejects.toThrow('Unsupported PDF operator-stream contract')
    expect(getPage).toHaveBeenCalledWith(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    const control = await runDocumentJob(job)
    expect(control.ok).toBe(true)
    if (!control.ok) throw new Error('Installed pdfjs contract failed')
    expect(control.images[0]?.png.byteLength).toBeGreaterThan(0)
  })
})
