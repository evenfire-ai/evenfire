import { readFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import type {
  DocumentInitParameters,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
} from 'pdfjs-dist/types/src/display/api'
import type { DocumentJobFailure, PdfTextJob, PdfVisualJob } from './types'

// tsc rewrites import() to require() in this CommonJS package. This static
// loader preserves native ESM loading; its specifier never comes from a PDF.
const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<typeof import('pdfjs-dist')>

const PDF_ROOT = dirname(require.resolve('pdfjs-dist/package.json'))
const RESOURCE_DIRECTORIES: Readonly<Record<string, string>> = Object.freeze({
  cMapUrl: 'cmaps',
  standardFontDataUrl: 'standard_fonts',
  wasmUrl: 'wasm',
})

/**
 * Exception names pdfjs uses for unreadable document data. Worker-side
 * failures (including FormatError) cross pdfjs's message handler as one of
 * these, so a malformed page reaches the caller with a stable name.
 */
const PDF_DATA_EXCEPTIONS: ReadonlySet<string> = new Set([
  'InvalidPDFException',
  'UnknownErrorException',
  'FormatError',
])

/** PDF names may select bundled assets, never a URL or a path outside them. */
class LocalPdfDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const directory = Object.hasOwn(RESOURCE_DIRECTORIES, kind)
      ? RESOURCE_DIRECTORIES[kind]
      : undefined
    if (
      !directory ||
      basename(filename) !== filename ||
      !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(filename)
    ) {
      throw new Error('Invalid bundled PDF resource')
    }
    const bytes = await readFile(join(PDF_ROOT, directory, filename))
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
}

export async function withPdfDocument<T>(
  job: PdfTextJob | PdfVisualJob,
  read: (document: PDFDocumentProxy) => Promise<T>
): Promise<T | DocumentJobFailure> {
  if (job.bytes.byteLength > job.limits.maxSourceBytes) {
    return { ok: false, reason: 'document_limits_exceeded', limit: 'source_bytes' }
  }

  // A missing or broken pdfjs build is a deployment defect, not a property of
  // the file, so it crashes the worker instead of becoming a typed reason.
  const pdfjs = await importEsm(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'))
  let loading: PDFDocumentLoadingTask | undefined
  let outcome: T | DocumentJobFailure
  try {
    // Node PDFWorker uses its in-thread fake worker. All fonts/CMaps are read
    // by our local factory; neither document data nor resource names use Fetch.
    // stopAtErrors rejects broken page data instead of returning partial text
    // or a silently incomplete image. No scripting API is called, and visual
    // reads disable annotations, including their actions and form appearances.
    const options: DocumentInitParameters & { isEvalSupported: false } = {
      data: job.bytes,
      isEvalSupported: false,
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      useWorkerFetch: false,
      useWasm: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      enableHWA: false,
      stopAtErrors: true,
      maxImageSize: job.limits.maxEmbeddedImagePixels,
      canvasMaxAreaInBytes: job.limits.maxEmbeddedImagePixels * 4,
      verbosity: 0,
      cMapUrl: join(PDF_ROOT, 'cmaps') + sep,
      cMapPacked: true,
      standardFontDataUrl: join(PDF_ROOT, 'standard_fonts') + sep,
      wasmUrl: join(PDF_ROOT, 'wasm') + sep,
      BinaryDataFactory: LocalPdfDataFactory,
    }
    loading = pdfjs.getDocument(options)
    const document = await loading.promise
    // A document without pages has nothing to select; as with an empty
    // workbook, that is a property of the file rather than of the range.
    outcome =
      document.numPages < 1
        ? { ok: false, reason: 'document_empty' }
        : document.numPages > job.limits.maxPageCount
          ? { ok: false, reason: 'document_limits_exceeded', limit: 'page_count' }
          : await read(document)
  } catch (error) {
    // pdfjs reports problems in the document's data with these exception
    // classes; anything else is a defect in this code or a dependency.
    const name = error instanceof Error ? error.name : undefined
    if (name === 'PasswordException') {
      outcome = { ok: false, reason: 'document_encrypted' }
    } else if (
      error instanceof Error &&
      error.message === 'Image exceeded maximum allowed size and was removed.'
    ) {
      // pdfjs 6 rejects an oversized embedded image with this fixed error when
      // stopAtErrors is enabled, before it decodes the image stream.
      outcome = { ok: false, reason: 'document_limits_exceeded', limit: 'pixels' }
    } else if (name !== undefined && PDF_DATA_EXCEPTIONS.has(name)) {
      outcome = { ok: false, reason: 'document_parse_failed' }
    } else {
      await loading?.destroy()
      throw error
    }
  }

  // Loading-task destruction also destroys the document and its fake worker,
  // including when the password handshake or parsing failed before loading.
  await loading?.destroy()
  return outcome
}
