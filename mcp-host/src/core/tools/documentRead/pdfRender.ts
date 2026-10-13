import { createCanvas } from '@napi-rs/canvas'
import type { PDFPageProxy, RenderParameters } from 'pdfjs-dist/types/src/display/api'
import { withPdfDocument } from './pdfLoad'
import { resolvePageSelection } from './selection'
import type { PdfVisualJob, PdfVisualOutcome } from './types'

const MAX_RENDER_ATTEMPTS = 3
const RETRY_SCALE = Math.sqrt(0.7)

async function renderPage(
  page: PDFPageProxy,
  scale: number
): Promise<{ width: number; height: number; png: Uint8Array }> {
  const viewport = page.getViewport({ scale })
  const width = Math.max(1, Math.floor(viewport.width))
  const height = Math.max(1, Math.floor(viewport.height))
  const canvas = createCanvas(width, height)
  try {
    await page.render({
      canvas: canvas as unknown as RenderParameters['canvas'],
      canvasContext: canvas.getContext('2d') as unknown as RenderParameters['canvasContext'],
      viewport,
      // No annotation actions, forms, scripting host, or annotation layer.
      annotationMode: 0,
      background: 'rgb(255,255,255)',
    }).promise
    const encoded = await canvas.encode('png')
    return {
      width,
      height,
      png: new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
    }
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

export async function renderPdfPages(job: PdfVisualJob): Promise<PdfVisualOutcome> {
  return withPdfDocument(job, async (document): Promise<PdfVisualOutcome> => {
    const selection = resolvePageSelection(job.pages, document.numPages)
    if (!selection || selection.length > job.limits.maxVisualPagesPerCall) {
      return { ok: false, reason: 'invalid_range' }
    }
    const maxDimension = Math.min(job.maxDimension, job.limits.maxRenderDimension)
    const maxPixels = Math.min(job.maxPixelsPerCall, job.limits.maxRenderPixelsPerCall)
    // Each page's byte share is reserved up front, like its pixel share, so
    // the call's images together never exceed the aggregate bound.
    const maxImageBytes = Math.min(
      job.maxImageBytes,
      job.limits.maxImageBytes,
      Math.floor(job.maxTotalImageBytes / selection.length)
    )
    if (!Number.isSafeInteger(maxDimension) || maxDimension < 1) {
      return { ok: false, reason: 'invalid_range' }
    }
    if (!Number.isSafeInteger(maxPixels) || maxPixels < selection.length) {
      return { ok: false, reason: 'document_limits_exceeded', limit: 'pixels' }
    }
    if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1) {
      return { ok: false, reason: 'document_limits_exceeded', limit: 'image_bytes' }
    }

    // Reserve equal shares before rendering. Any remainder goes to earlier
    // selected pages, so retries never borrow pixels from another page.
    const pixelsPerPage = Math.floor(maxPixels / selection.length)
    const remainder = maxPixels % selection.length
    const outcome: Extract<PdfVisualOutcome, { ok: true }> = {
      ok: true,
      pageCount: document.numPages,
      images: [],
    }
    for (let index = 0; index < selection.length; index += 1) {
      const page = await document.getPage(selection[index])
      try {
        const viewport = page.getViewport({ scale: 1 })
        if (
          !Number.isFinite(viewport.width) ||
          !Number.isFinite(viewport.height) ||
          viewport.width <= 0 ||
          viewport.height <= 0
        ) {
          return { ok: false, reason: 'document_parse_failed' }
        }
        const pixelBudget = pixelsPerPage + (index < remainder ? 1 : 0)
        let scale = Math.min(
          maxDimension / Math.max(viewport.width, viewport.height),
          Math.sqrt(pixelBudget / (viewport.width * viewport.height))
        )
        // A sub-pixel short side still occupies one physical pixel. Bound
        // each side too, so very thin/long pages cannot exceed their share.
        scale = Math.min(scale, pixelBudget / Math.max(viewport.width, viewport.height))
        for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt += 1) {
          const image = await renderPage(page, scale)
          if (image.width * image.height > pixelBudget) {
            return { ok: false, reason: 'document_limits_exceeded', limit: 'pixels' }
          }
          if (image.png.byteLength <= maxImageBytes) {
            outcome.images.push({ page: selection[index], ...image })
            break
          }
          if (attempt + 1 === MAX_RENDER_ATTEMPTS) {
            return { ok: false, reason: 'document_limits_exceeded', limit: 'image_bytes' }
          }
          scale *= RETRY_SCALE
        }
      } finally {
        page.cleanup()
      }
    }
    return outcome
  })
}
