import { parentPort, workerData } from 'node:worker_threads'
import { renderPdfPages } from './pdfRender'
import { parsePdfText } from './pdfText'
import type { DocumentJob, DocumentJobOutcome } from './types'

const { isMarkedAsUntransferable } = require('node:worker_threads') as {
  // Node 24 provides this API; this package retains Node 20 type definitions.
  isMarkedAsUntransferable(value: object): boolean
}

async function dispatch(job: DocumentJob): Promise<DocumentJobOutcome<DocumentJob>> {
  switch (job.kind) {
    case 'pdf_text':
      return parsePdfText(job)
    case 'pdf_visual':
      return renderPdfPages(job)
    case 'xlsx': {
      const { parseXlsx } = await import('./xlsxParser')
      return parseXlsx(job)
    }
    default:
      throw new Error('Unknown document job kind')
  }
}

async function run(): Promise<void> {
  if (!parentPort) return
  // Readers return typed outcomes for document conditions themselves. Any
  // exception escaping them is a defect: it crashes the worker and the
  // runner rejects, instead of being reported as an unreadable file.
  try {
    const outcome = await dispatch(workerData as DocumentJob)
    const transfers: ArrayBuffer[] = []
    if (outcome.ok && 'images' in outcome) {
      for (const image of outcome.images) {
        const png = image.png
        // Only transfer the PNG's bytes. A pooled/partial/non-transferable
        // backing store needs one owned copy; an owned buffer needs none.
        image.png =
          png.buffer instanceof ArrayBuffer &&
          png.byteOffset === 0 &&
          png.byteLength === png.buffer.byteLength &&
          !isMarkedAsUntransferable(png.buffer)
            ? png
            : new Uint8Array(png)
        transfers.push(image.png.buffer as ArrayBuffer)
      }
    }
    parentPort.postMessage(outcome, transfers)
  } finally {
    parentPort.close()
  }
}

void run()
