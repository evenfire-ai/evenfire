import type { PDFDocumentProxy, TextItem } from 'pdfjs-dist/types/src/display/api'
import { withPdfDocument } from './pdfLoad'
import { resolvePageSelection } from './selection'
import type { PdfTextJob, PdfTextOutcome } from './types'

function hasGeometryGap(previous: TextItem, current: TextItem): boolean {
  const vertical = previous.dir === 'ttb'
  const axisX = previous.transform[vertical ? 2 : 0]
  const axisY = previous.transform[vertical ? 3 : 1]
  const length = Math.hypot(axisX, axisY)
  if (!length) return false
  const dx = current.transform[4] - previous.transform[4]
  const dy = current.transform[5] - previous.transform[5]
  const along = (dx * axisX + dy * axisY) / length
  const across = Math.abs((dx * axisY - dy * axisX) / length)
  const previousSize = vertical ? previous.height : previous.width
  const currentSize = vertical ? current.height : current.width
  const gap = Math.max(along - previousSize, -along - currentSize)
  // Separate disjoint item spans (in either writing direction) by one space
  // when the gap exceeds 10% of the smaller text height, with a 0.5-point floor.
  // Baseline changes also separate items; only hasEOL inserts a newline.
  const threshold = Math.max(0.5, Math.min(previous.height, current.height) * 0.1)
  return gap > threshold || across > threshold
}

async function readPageText(document: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await document.getPage(pageNumber)
  try {
    const content = await page.getTextContent({ disableNormalization: true })
    const parts: string[] = []
    let previous: TextItem | undefined
    for (const item of content.items) {
      if (!('str' in item)) continue
      if (
        item.str &&
        previous &&
        !previous.hasEOL &&
        previous.str &&
        !/\s$/u.test(previous.str) &&
        !/^\s/u.test(item.str) &&
        hasGeometryGap(previous, item)
      ) {
        parts.push(' ')
      }
      parts.push(item.str)
      if (item.hasEOL) parts.push('\n')
      // Empty non-EOL markers must not erase the preceding item's geometry.
      if (item.str || item.hasEOL) previous = item
    }
    return parts.join('').trimEnd()
  } finally {
    page.cleanup()
  }
}

function splitsCodePoint(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  )
}

function nonWhitespaceCharacters(text: string): number {
  let count = 0
  for (const character of text) {
    if (!/\s/u.test(character)) count += 1
  }
  return count
}

export async function parsePdfText(job: PdfTextJob): Promise<PdfTextOutcome> {
  return withPdfDocument(job, async (document): Promise<PdfTextOutcome> => {
    const selection = resolvePageSelection(job.pages, document.numPages)
    const startIndex = selection?.indexOf(job.start.page) ?? -1
    if (
      !selection ||
      startIndex < 0 ||
      !Number.isSafeInteger(job.start.charOffset) ||
      job.start.charOffset < 0 ||
      !Number.isSafeInteger(job.limits.maxTextPagesPerCall) ||
      job.limits.maxTextPagesPerCall < 1 ||
      !Number.isSafeInteger(job.limits.maxExtractedChars) ||
      job.limits.maxExtractedChars < 1
    ) {
      return { ok: false, reason: 'invalid_range' }
    }

    const outcome: Extract<PdfTextOutcome, { ok: true }> = {
      ok: true,
      pageCount: document.numPages,
      pages: [],
    }
    const scanned = new Set<number>()
    let selectionHasText = false
    let extractedCharacters = 0
    for (let index = startIndex; index < selection.length; index += 1) {
      const pageNumber = selection[index]
      const text = await readPageText(document, pageNumber)
      scanned.add(pageNumber)
      const nonWhitespace = nonWhitespaceCharacters(text)
      selectionHasText ||= nonWhitespace > 0
      const offset = index === startIndex ? job.start.charOffset : 0
      // A continuation is issued only inside a page's text, so a resumed
      // offset at or past its end reads nothing and is not a valid cursor.
      if ((offset > 0 && offset >= text.length) || splitsCodePoint(text, offset)) {
        return { ok: false, reason: 'invalid_range' }
      }
      // Cursor offsets and the extraction budget use UTF-16 units. A cut may
      // back up one unit to keep a surrogate pair intact; text is never NFC'd.
      const remaining = job.limits.maxExtractedChars - extractedCharacters
      let end = Math.min(text.length, offset + remaining)
      if (splitsCodePoint(text, end)) end -= 1
      if (end === offset && end < text.length) {
        // As with attachmentRead's byte windows, the initial range must fit
        // one complete code point. Never issue a non-advancing empty success.
        if (outcome.pages.length === 0) return { ok: false, reason: 'invalid_range' }
        outcome.next = { page: pageNumber, charOffset: offset }
        outcome.stoppedBy = 'max_extracted_chars'
        break
      }
      outcome.pages.push({
        page: pageNumber,
        text,
        from: offset,
        to: end,
        lowText: nonWhitespace < job.limits.minTextCharsPerPage,
      })
      extractedCharacters += end - offset
      if (end < text.length) {
        outcome.next = { page: pageNumber, charOffset: end }
        outcome.stoppedBy = 'max_extracted_chars'
        break
      }
      if (index + 1 < selection.length) {
        if (extractedCharacters >= job.limits.maxExtractedChars) {
          outcome.next = { page: selection[index + 1], charOffset: 0 }
          outcome.stoppedBy = 'max_extracted_chars'
          break
        }
        if (outcome.pages.length >= job.limits.maxTextPagesPerCall) {
          outcome.next = { page: selection[index + 1], charOffset: 0 }
          outcome.stoppedBy = 'max_pages'
          break
        }
      }
    }

    // Only an empty layer needs further inspection. Check the entire selection
    // (including before a resume cursor), stopping at the first text-bearing
    // page, so an early image-only page cannot hide later selectable text.
    if (!selectionHasText) {
      for (const pageNumber of selection) {
        if (scanned.has(pageNumber)) continue
        if (/\S/u.test(await readPageText(document, pageNumber))) {
          selectionHasText = true
          break
        }
      }
    }
    return selectionHasText ? outcome : { ok: false, reason: 'no_text_layer' }
  })
}
