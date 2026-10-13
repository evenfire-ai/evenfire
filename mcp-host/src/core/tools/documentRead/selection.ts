/**
 * Page selections and continuation cursors of `clerum__document_read`. Pure,
 * so the Tool and the worker resolve them identically.
 */
import type { DocumentPosition } from './types'

const PAGE_SELECTION = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/

/** Characters of a `pages` input; a longer one is `invalid_range`. */
export const MAX_PAGE_SELECTION_CHARS = 256

/**
 * Resolves `"1-3,5"` against a document of `pageCount` pages to an ascending,
 * de-duplicated list of 1-based pages. `null` selects every page. Returns null
 * for a malformed selection, a page outside `1..pageCount`, or a reversed
 * range.
 */
export function resolvePageSelection(spec: string | null, pageCount: number): number[] | null {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return null
  if (spec === null) return Array.from({ length: pageCount }, (_, i) => i + 1)
  if (spec.length > MAX_PAGE_SELECTION_CHARS || !PAGE_SELECTION.test(spec)) return null
  const pages = new Set<number>()
  for (const part of spec.split(',')) {
    const [fromText, toText] = part.split('-').map(value => value.trim())
    const from = Number(fromText)
    const to = toText === undefined ? from : Number(toText)
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null
    if (from < 1 || to > pageCount || from > to) return null
    for (let page = from; page <= to; page += 1) pages.add(page)
  }
  return [...pages].sort((a, b) => a - b)
}

const CURSOR = /^v1\.(pdf|xlsx)\.(\d{1,9})\.(\d{1,12})$/

export function encodeCursor(position: DocumentPosition): string {
  return position.format === 'pdf'
    ? `v1.pdf.${position.page}.${position.charOffset}`
    : `v1.xlsx.${position.sheetIndex}.${position.row}`
}

/**
 * Parses a cursor the tool issued. Returns null for anything else; the
 * caller checks the position against the document it reads.
 */
export function decodeCursor(cursor: string): DocumentPosition | null {
  const match = CURSOR.exec(cursor)
  if (!match) return null
  const first = Number(match[2])
  const second = Number(match[3])
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second)) return null
  if (match[1] === 'pdf') {
    return first >= 1 ? { format: 'pdf', page: first, charOffset: second } : null
  }
  return second >= 1 ? { format: 'xlsx', sheetIndex: first, row: second } : null
}
