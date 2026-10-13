import { serialize } from 'node:v8'
import { renderPdfPages } from './pdfRender'
import { parsePdfText } from './pdfText'
import type { DocumentJob, DocumentJobOutcome } from './types'

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

if (!process.send) throw new Error('Document reader requires an IPC channel')
process.once('message', async (job: DocumentJob) => {
  // Advanced IPC preserves Buffer subclasses, which pdfjs does not accept.
  // Normalize the exact received view without another document-sized copy.
  job.bytes = new Uint8Array(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength)
  // Readers classify document conditions. An escaping exception crashes only
  // this child, and the parent reports the fixed defect without its text.
  const outcome = await dispatch(job)
  // Measure strings and raw PNG bytes before IPC can copy them into the Host.
  // Serialization and its temporary buffer stay inside the memory-capped child.
  const bounded: DocumentJobOutcome<DocumentJob> =
    serialize(outcome).byteLength > job.limits.maxOutputBytes
      ? { ok: false, reason: 'document_limits_exceeded', limit: 'output_bytes' }
      : outcome
  if (!process.send) throw new Error('Document reader lost its IPC channel')
  process.send(bounded, error => {
    if (error) throw new Error('Document reader could not send its outcome')
    process.disconnect()
  })
})
