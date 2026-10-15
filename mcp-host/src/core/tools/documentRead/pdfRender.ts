import { createCanvas } from '@napi-rs/canvas'
import type { ReadableStream } from 'node:stream/web'
import type { PDFPageProxy, RenderParameters } from 'pdfjs-dist/types/src/display/api'
import { withPdfDocument } from './pdfLoad'
import { resolvePageSelection } from './selection'
import type { PdfVisualJob, PdfVisualOutcome } from './types'

const MAX_RENDER_ATTEMPTS = 3
const RETRY_SCALE = Math.sqrt(0.7)

/**
 * pdfjs 6.4.299 marks a failed operator list complete before rejecting its
 * public render/getOperatorList promise, allowing partial success. Read the
 * underlying stream so image-limit and data errors cannot be swallowed.
 * This is the pdfjs 6 transport contract; an incompatible build is a defect.
 */
async function checkOperatorStream(page: PDFPageProxy): Promise<void> {
  const internal = page as unknown as {
    _id: number
    _transport: {
      getRenderingIntent(
        intent: string,
        annotationMode: number,
        storage: null,
        editing: boolean,
        operatorList: boolean
      ): {
        renderingIntent: number
        cacheKey: string
        annotationStorageSerializable: { map: Map<unknown, unknown>; transfer: ArrayBuffer[] }
        modifiedIds: Set<string>
      }
      messageHandler: {
        sendWithStream(
          name: string,
          data: Record<string, unknown>,
          strategy: undefined,
          transfers: ArrayBuffer[]
        ): ReadableStream<unknown>
      }
    }
  }
  const transport = internal._transport
  if (
    !Number.isSafeInteger(internal._id) ||
    typeof transport?.getRenderingIntent !== 'function' ||
    typeof transport?.messageHandler?.sendWithStream !== 'function'
  ) {
    throw new Error('Unsupported PDF operator-stream contract')
  }
  const intent = transport.getRenderingIntent('display', 0, null, false, true)
  const stream = transport.messageHandler.sendWithStream(
    'GetOperatorList',
    {
      pageId: page.pageNumber - 1,
      pageIndex: page.pageNumber - 1,
      pageProxyId: internal._id,
      intent: intent.renderingIntent,
      cacheKey: intent.cacheKey,
      annotationStorage: intent.annotationStorageSerializable.map,
      modifiedIds: intent.modifiedIds,
    },
    undefined,
    intent.annotationStorageSerializable.transfer
  )
  if (typeof stream?.getReader !== 'function') {
    throw new Error('Unsupported PDF operator-stream contract')
  }
  const reader = stream.getReader()
  try {
    while (!(await reader.read()).done) {
      // Drain bounded child-local chunks. Rendering obtains its own list.
    }
  } finally {
    reader.releaseLock()
  }
}

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
    const requested = resolvePageSelection(job.pages, document.numPages)
    const startIndex = job.start ? (requested?.indexOf(job.start.page) ?? -1) : 0
    if (
      !requested ||
      startIndex < 0 ||
      (job.start && job.start.charOffset !== 0) ||
      !Number.isSafeInteger(job.limits.maxVisualPagesPerCall) ||
      job.limits.maxVisualPagesPerCall < 1
    ) {
      return { ok: false, reason: 'invalid_range' }
    }
    const selection = requested.slice(startIndex, startIndex + job.limits.maxVisualPagesPerCall)
    const threshold = job.maxDimensionAboveImageCount
    const maxDimension = Math.min(
      job.maxDimension,
      job.limits.maxRenderDimension,
      threshold && selection.length > threshold.count ? threshold.maxDimension : Infinity
    )
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
    const nextPage = requested[startIndex + selection.length]
    if (nextPage !== undefined) {
      outcome.next = { page: nextPage, charOffset: 0 }
      outcome.stoppedBy = 'max_pages'
    }
    for (let index = 0; index < selection.length; index += 1) {
      const page = await document.getPage(selection[index])
      try {
        await checkOperatorStream(page)
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
