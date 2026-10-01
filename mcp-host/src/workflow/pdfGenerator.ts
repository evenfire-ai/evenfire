/** The PDF generator (clerum__generate_pdf): markdown body, tables and images typeset with pdfmake. */
import * as fs from 'fs'
import * as path from 'path'
import type { Content, ContentText, Node, TDocumentDefinitions } from 'pdfmake/interfaces'
import {
  artifactResult,
  claimOutputFile,
  enforceQuota,
  ensureDir,
  outputFilename,
  replacedBytes,
} from './artifactOutput'
import {
  EMPTY_DOCUMENT_NOTE,
  PDF_FOOTER_SIZE,
  RUNNING_LINE_CHARS,
  footerLines,
  longestFitting,
  printedBranding,
} from './documentChrome'
import { documentEastAsianScript } from './docxScript'
import {
  MAX_DECODE_PIXELS,
  fitImageSize,
  imageDataUrl,
  loadEmbeddableImage,
} from './embeddedImages'
import { PDF_FONT_FAMILY, PDF_MONO_FAMILY, pdfGlyphSource } from './fonts'
import { htmlToPlainText, inlineSpans } from './inlineMarkup'
import {
  type ColumnAlignment,
  ORDERED_RE,
  indentOf,
  isListLine,
  readBlock,
  stripListMarker,
} from './markdownBlocks'
import { choose } from './ownEntry'
import {
  BODY_FONT_SIZE,
  MIN_BOTTOM_MARGIN,
  PORTRAIT,
  type UnitMeasure,
  layoutPdfTable,
} from './pdfTables'
import { LINE_FILL, PdfTypesetter } from './pdfText'
import { headerText, normalizeTableRows } from './tableRows'
import type { InternalToolResult } from './types'

const PdfPrinter = require('pdfmake')

interface PdfPalette {
  primary: string
  text: string
  muted: string
  border: string
  accent: string
  statusGreen: string
  statusYellow: string
  statusRed: string
  alternateRowFill: string
  surface: string
}

const PDF_PALETTES: Record<string, PdfPalette> = {
  default: {
    primary: '#0f172a',
    text: '#0f172a',
    muted: '#475569',
    border: '#cbd5e1',
    accent: '#3b82f6',
    statusGreen: '#16a34a',
    statusYellow: '#ca8a04',
    statusRed: '#dc2626',
    alternateRowFill: '#f8fafc',
    surface: '#f1f5f9',
  },
  corporate: {
    primary: '#1e3a8a',
    text: '#1e293b',
    muted: '#475569',
    border: '#cbd5e1',
    accent: '#0891b2',
    statusGreen: '#059669',
    statusYellow: '#ca8a04',
    statusRed: '#b91c1c',
    alternateRowFill: '#f1f5f9',
    surface: '#e0f2fe',
  },
  warm: {
    primary: '#b45309',
    text: '#2f2823',
    muted: '#66584c',
    border: '#d6d2cc',
    accent: '#b45309',
    statusGreen: '#15803d',
    statusYellow: '#b45309',
    statusRed: '#9f1239',
    alternateRowFill: '#fefdfb',
    surface: '#f7f7f5',
  },
  alert: {
    primary: '#9f1239',
    text: '#1f2937',
    muted: '#4b5563',
    border: '#fecaca',
    accent: '#dc2626',
    statusGreen: '#15803d',
    statusYellow: '#ca8a04',
    statusRed: '#9f1239',
    alternateRowFill: '#fef2f2',
    surface: '#fee2e2',
  },
}

/** A4 width (595pt) less the 40pt side margins the documents use. */
const PDF_CONTENT_WIDTH = PORTRAIT.width

/** Keeps a tall image from taking a whole page on its own. */
const PDF_MAX_IMAGE_HEIGHT = 330

/** Vertical margin around an embedded image, above and below. */
const PDF_IMAGE_MARGIN = 10

/** The cover logo's box: its usual width, and a height a tall logo cannot exceed. */
const PDF_LOGO_BOX = { width: 120, height: 80 }

/**
 * Id prefix of each table's first header cell. pdfmake corrects the page
 * number it records for a block moved to the next page only on nodes with an
 * id, and the heading check reads it to see where a table really starts.
 */
const TABLE_HEADER_ID = 'pdf-table-'

/**
 * Style of the running header and footer. pdfmake lists their nodes among a
 * page's content when deciding page breaks, and this is how they are told apart.
 */
const RUNNING_STYLE = 'running'

/** Top page margin; the running header is drawn inside it. */
const PDF_TOP_MARGIN = 60

const PDF_LINE_HEIGHT = 1.3

interface PdfBranding {
  logoPath?: string
  companyName?: string
  footerText?: string
}

interface PdfImageRef {
  path: string
  width?: number
  height?: number
  alignment?: 'left' | 'center' | 'right'
}

interface PdfTableSpec {
  headers: unknown[]
  rows: unknown
  widths?: unknown
  layout?: 'striped' | 'minimal' | 'grid'
}

/** What the body parser needs from the call it serves. */
interface PdfBodyEnv {
  warnings: string[]
  /** Width of text at 1pt in the body face, for sizing table columns. */
  measure: UnitMeasure
  /** An image block for a `![alt](file)` line, or undefined when it could not be loaded. */
  image(src: string): Content | undefined
  /** Tables that need landscape pages. */
  landscape: Set<Content>
  /** Tables parsed from the body so far, for naming them in warnings. */
  tableCount: number
  /** Tables built so far, body and explicit, for giving each header a unique id. */
  tablesBuilt: number
  /** Bottom page margin, which grows with the footer. */
  bottomMargin: number
}

/** An image reference written in the body: `![alt](src)`. */
interface MarkdownImage {
  alt: string
  src: string
}

/**
 * Inline markup of one line as pdfmake runs: **bold**, *italic*, ~~strike~~,
 * `code`, links, the HTML tags models write, and character entities. Image
 * references are taken out of the text and handed to `onImage`.
 */
function parseInlineMarkdown(line: string, onImage: (image: MarkdownImage) => void): ContentText {
  const runs: ContentText[] = []
  for (const span of inlineSpans(line)) {
    if (span.image !== undefined) {
      onImage({ alt: span.text, src: span.image })
      continue
    }
    runs.push({
      text: span.text,
      ...(span.bold ? { bold: true } : {}),
      ...(span.italics ? { italics: true } : {}),
      ...(span.code ? { font: PDF_MONO_FAMILY } : {}),
      ...(span.link !== undefined
        ? { link: span.link, color: '#1d4ed8', decoration: 'underline' as const }
        : span.strike
          ? { decoration: 'lineThrough' as const }
          : {}),
    })
  }
  return { text: runs }
}

/** Characters, and styled runs, one pdfmake paragraph holds before the next piece starts. */
const PARAGRAPH_PIECE_CHARS = 20_000
const PARAGRAPH_PIECE_RUNS = 1_000

/**
 * `paragraph` in pieces of up to PARAGRAPH_PIECE_CHARS characters and
 * PARAGRAPH_PIECE_RUNS runs, each cut after a space where there is one.
 * pdfmake lays a paragraph out in time that grows with the square of its words
 * and runs, so one 200 KB line of alternating emphasis held the event loop for
 * half a minute; pieces set one under another read on as the same paragraph,
 * with a line ending at each cut. No paragraph a person writes reaches either
 * limit.
 */
function inPieces(paragraph: ContentText): ContentText[] {
  if (
    !Array.isArray(paragraph.text) ||
    (paragraph.text.length <= PARAGRAPH_PIECE_RUNS &&
      plainText(paragraph).length <= PARAGRAPH_PIECE_CHARS)
  ) {
    return [paragraph]
  }
  const pieces: ContentText[][] = [[]]
  let size = 0
  for (const run of paragraph.text as ContentText[]) {
    if (pieces[pieces.length - 1].length >= PARAGRAPH_PIECE_RUNS) {
      pieces.push([])
      size = 0
    }
    let text = String(run.text ?? '')
    while (size + text.length > PARAGRAPH_PIECE_CHARS) {
      const room = PARAGRAPH_PIECE_CHARS - size
      let cut = text.lastIndexOf(' ', room - 1) + 1
      if (cut <= 0 && size > 0) {
        pieces.push([])
        size = 0
        continue
      }
      if (cut <= 0) {
        // No space to cut after: cut inside the word, never inside a surrogate pair.
        cut = room
        const code = text.charCodeAt(cut - 1)
        if (code >= 0xd800 && code <= 0xdbff) cut--
      }
      pieces[pieces.length - 1].push({ ...run, text: text.slice(0, cut) })
      pieces.push([])
      size = 0
      text = text.slice(cut)
    }
    if (text) {
      pieces[pieces.length - 1].push({ ...run, text })
      size += text.length
    }
  }
  return pieces.filter(piece => piece.length > 0).map(piece => ({ text: piece }))
}

/** `parsed` as it is, or as a stack of its pieces when it is that long. */
function asPieces(parsed: ContentText): ContentText | { stack: ContentText[] } {
  const pieces = inPieces(parsed)
  return pieces.length === 1 ? pieces[0] : { stack: pieces }
}

/** The text a parsed line prints, for measuring it. */
function plainText(parsed: ContentText): string {
  const text = parsed.text
  if (!Array.isArray(text)) return String(text ?? '')
  return text
    .map(t => (typeof t === 'string' ? t : String((t as { text?: unknown }).text ?? '')))
    .join('')
}

interface PdfTableRequest {
  headers: string[]
  rows: string[][]
  layout?: 'striped' | 'minimal' | 'grid'
  widths?: unknown
  alignments?: ColumnAlignment[]
  /** How warnings name the table, such as "tables[0]". */
  label: string
  /** How warnings name one of its rows, such as "tables[0].rows[2]". */
  rowLabel(index: number): string
}

function buildTableNode(
  request: PdfTableRequest,
  palette: PdfPalette,
  env: PdfBodyEnv,
  onImage: (image: MarkdownImage) => void
): Content {
  const { headers, alignments } = request
  const layout = request.layout ?? 'striped'
  // pdfmake needs every row to have one cell per column: short rows are
  // padded, and cells past the last header are cut and reported.
  const long = request.rows.flatMap((row, i) => (row.length > headers.length ? [i] : []))
  if (long.length > 0) {
    const first = request.rows[long[0]].length
    env.warnings.push(
      `${request.rowLabel(long[0])} has ${first} cells for ${headers.length} headers` +
        (long.length > 1 ? ` (and ${long.length - 1} more row(s) have too many)` : '') +
        ', so the cells past the last header were left out; add a header for every column.'
    )
  }
  const cells = request.rows.map(row =>
    normalizeRowLength(row, headers.length).map(cell => parseInlineMarkdown(cell ?? '', onImage))
  )
  const headerCells = headers.map(h => parseInlineMarkdown(h, onImage))
  const fit = layoutPdfTable(
    {
      headers: headerCells.map(plainText),
      rows: cells.map(row => row.map(plainText)),
      requested: request.widths,
      cellPadding: 8,
      ruleWidth: layout === 'grid' ? 0.5 : 0,
      allowLandscape: true,
      label: request.label,
      bottomMargin: env.bottomMargin,
    },
    env.measure,
    env.warnings
  )
  const align = (col: number) =>
    alignments?.[col] && alignments[col] !== 'left' ? { alignment: alignments[col] } : {}
  const node = {
    table: {
      headerRows: 1,
      // Without this a table starting near the foot of a page leaves its
      // header stranded there with every row on the next one.
      ...(fit.keepWithHeaderRows ? { keepWithHeaderRows: 1 } : {}),
      dontBreakRows: fit.dontBreakRows,
      widths: fit.widths,
      body: [
        headerCells.map((h, col) => ({
          ...asPieces(h),
          ...(col === 0 ? { id: `${TABLE_HEADER_ID}${++env.tablesBuilt}` } : {}),
          bold: true,
          color: '#ffffff',
          fillColor: palette.primary,
          ...align(col),
        })),
        // pdfmake accepts a `text` array of inline runs as a cell — use that
        // so **bold** / *italic* / `code` inside cells render correctly.
        ...cells.map(row => row.map((cell, col) => ({ ...asPieces(cell), ...align(col) }))),
      ],
    },
    layout: pdfTableLayout(layout, palette),
    margin: [0, 4, 0, 8],
    ...(fit.fontSize !== BODY_FONT_SIZE ? { fontSize: fit.fontSize } : {}),
  } as Content
  if (fit.landscape) env.landscape.add(node)
  return node
}

/**
 * Pad/truncate a row to a fixed number of columns. Used by table builders
 * to make ragged input deterministic.
 */
function normalizeRowLength<T>(row: T[], width: number): (T | '')[] {
  if (row.length === width) return row
  if (row.length > width) return row.slice(0, width)
  return [...row, ...Array<''>(width - row.length).fill('')]
}

function pdfTableLayout(name: 'striped' | 'minimal' | 'grid', palette: PdfPalette) {
  if (name === 'minimal') {
    return {
      hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
        i === 0 || i === 1 || i === node.table.body.length ? 0.7 : 0,
      vLineWidth: () => 0,
      hLineColor: () => palette.border,
    }
  }
  if (name === 'grid') {
    return {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => palette.border,
      vLineColor: () => palette.border,
    }
  }
  return {
    hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
      i === 0 || i === 1 || i === node.table.body.length ? 0.7 : 0,
    vLineWidth: () => 0,
    hLineColor: () => palette.border,
    fillColor: (rowIndex: number) =>
      rowIndex === 0 ? null : rowIndex % 2 === 0 ? palette.alternateRowFill : null,
  }
}

/**
 * Build one list level, consuming the lines that belong to it. A line indented
 * further than the level's own indent starts a nested list attached to the item
 * above it, which is what preserves the hierarchy the author wrote.
 */
function buildList(
  lines: string[],
  start: number,
  indent: number,
  onImage: (image: MarkdownImage) => void
): { node: Content; next: number } {
  const ordered = ORDERED_RE.test(lines[start].trimStart())
  const items: Content[] = []
  let i = start

  while (i < lines.length) {
    if (lines[i].trim() === '') {
      // Blank lines between items keep the list going: models separate
      // numbered steps that way and expect the numbers to continue.
      let j = i
      while (j < lines.length && lines[j].trim() === '') j++
      const continues =
        j < lines.length &&
        isListLine(lines[j]) &&
        (indentOf(lines[j]) > indent ||
          (indentOf(lines[j]) === indent && ORDERED_RE.test(lines[j].trimStart()) === ordered))
      if (!continues) break
      i = j
      continue
    }
    if (!isListLine(lines[i]) || indentOf(lines[i]) < indent) break
    const own = indentOf(lines[i])
    if (own > indent) {
      // Deeper than this level: attach to the previous item as a sub-list.
      const sub = buildList(lines, i, own, onImage)
      const previous = items.pop()
      items.push(previous ? ([previous, sub.node] as unknown as Content) : sub.node)
      i = sub.next
      continue
    }
    const isOrdered = ORDERED_RE.test(lines[i].trimStart())
    // Switching between bullets and numbers at the same indent starts a different list.
    if (isOrdered !== ordered) break
    items.push(asPieces(parseInlineMarkdown(stripListMarker(lines[i]), onImage)))
    i++
  }

  // A list that picks up after a code block or a paragraph keeps its numbers.
  const first = ordered ? parseInt(lines[start].trimStart(), 10) : 1
  const node = (
    ordered
      ? { ol: items, ...(first !== 1 ? { start: first } : {}), margin: [0, 4, 0, 6] }
      : { ul: items, margin: [0, 4, 0, 6] }
  ) as Content
  return { node, next: i }
}

/**
 * Convert a markdown body into pdfmake content nodes: a single-pass line
 * scanner for headings, fenced code, rules, GFM tables, quotes, lists, image
 * lines and paragraphs.
 */
function bodyToContent(body: string, palette: PdfPalette, env: PdfBodyEnv): Content[] {
  const out: Content[] = []
  const lines = body.split('\n')
  // A paragraph's images are placed after it; anywhere else they are left out
  // with a note rather than printing their path.
  const stray = (image: MarkdownImage) =>
    env.warnings.push(
      `The image '${image.src}' inside a table, list, heading or quote was left out; put ` +
        `![alt](${image.src}) on a line of its own to embed it.`
    )
  let i = 0
  while (i < lines.length) {
    const block = readBlock(lines, i)
    switch (block.kind) {
      case 'code':
        // Verbatim, so a shell snippet or a config sample keeps its spacing
        // instead of being reflowed into paragraphs.
        out.push(buildCodeBlock(block.code.join('\n'), block.language, palette))
        break
      case 'heading': {
        // The deeper levels share h3's style rather than falling through as
        // literal hashes. headlineLevel marks them for the page-break check
        // that keeps a heading off the foot of a page.
        const level = block.level
        const style = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'
        const top = level === 1 ? 16 : level === 2 ? 12 : 8
        out.push({
          ...asPieces(parseInlineMarkdown(block.text, stray)),
          style,
          headlineLevel: 1,
          margin: [0, top, 0, level === 1 ? 6 : 4],
        } as Content)
        break
      }
      case 'rule':
        out.push({
          canvas: [
            {
              type: 'line',
              x1: 0,
              y1: 0,
              x2: PDF_CONTENT_WIDTH,
              y2: 0,
              lineWidth: 0.5,
              lineColor: palette.border,
            },
          ],
          margin: [0, 8, 0, 8],
        })
        break
      case 'table': {
        const label = `The body's table ${++env.tableCount}`
        const { headers, rows, alignments } = block
        out.push(
          buildTableNode(
            { headers, rows, alignments, label, rowLabel: index => `${label}, row ${index + 1}` },
            palette,
            env,
            stray
          )
        )
        break
      }
      case 'quote':
        out.push(buildBlockquote(block.paragraphs, palette, stray))
        break
      case 'list': {
        // Anything nested under the first item belongs to the list.
        const built = buildList(lines, i, indentOf(lines[i]), stray)
        out.push(built.node)
        i = built.next
        continue
      }
      case 'blank':
        // Small vertical breathing room.
        out.push({ text: '', margin: [0, 2, 0, 2] })
        break
      case 'text': {
        // A paragraph of inline markdown, then any images it references.
        const images: MarkdownImage[] = []
        const paragraph = parseInlineMarkdown(block.line, image => images.push(image))
        if (plainText(paragraph).trim() !== '') {
          const pieces = inPieces(paragraph)
          pieces.forEach((piece, p) =>
            out.push({ ...piece, margin: [0, 0, 0, p === pieces.length - 1 ? 4 : 0] })
          )
        }
        for (const image of images) {
          const placed = env.image(image.src)
          if (placed) out.push(placed)
        }
        break
      }
    }
    i = block.next
  }
  return out
}

/** Monospaced block on a tinted ground, with the language noted when given. */
function buildCodeBlock(code: string, language: string, palette: PdfPalette): Content {
  const stack: Content[] = []
  if (language) {
    stack.push({
      text: language,
      fontSize: 8,
      color: palette.muted,
      margin: [0, 0, 0, 2],
    })
  }
  stack.push({
    text: code,
    font: PDF_MONO_FAMILY,
    fontSize: 9,
    color: palette.text,
    preserveLeadingSpaces: true,
    lineHeight: 1.25,
  } as Content)
  return {
    table: {
      // A numeric width lets pdfmake break a line with no spaces (base64,
      // minified JSON) inside the block; a '*' column is never narrower than
      // its longest word.
      widths: [PDF_CONTENT_WIDTH - 2],
      body: [[{ stack, margin: [8, 6, 8, 6] }]],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: (i: number) => (i === 0 ? 2 : 0),
      vLineColor: () => palette.border,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
      fillColor: () => palette.surface,
    },
    margin: [0, 6, 0, 8],
  } as Content
}

/** Quoted passage, set off by a rule down its left edge. */
function buildBlockquote(
  paragraphs: string[],
  palette: PdfPalette,
  onImage: (image: MarkdownImage) => void
): Content {
  return {
    table: {
      widths: [PDF_CONTENT_WIDTH - 2.5],
      body: [
        [
          {
            stack: paragraphs.flatMap((text, n) => {
              const pieces = inPieces(parseInlineMarkdown(text, onImage))
              return pieces.map((piece, p) => ({
                ...piece,
                margin: [0, 0, 0, p === pieces.length - 1 && n < paragraphs.length - 1 ? 4 : 0],
              }))
            }),
            italics: true,
            color: palette.muted,
            margin: [10, 4, 6, 4],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: (i: number) => (i === 0 ? 2.5 : 0),
      vLineColor: () => palette.primary,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 6, 0, 8],
  } as Content
}

function statusColorFromPalette(palette: PdfPalette, status?: string): string | undefined {
  if (!status) return undefined
  const s = status.toLowerCase()
  if (s === 'green' || s === 'ok' || s === 'pass') return palette.statusGreen
  if (s === 'yellow' || s === 'warn' || s === 'warning') return palette.statusYellow
  if (s === 'red' || s === 'critical' || s === 'fail') return palette.statusRed
  // Unknown status keyword — fall back to muted accent so the band still
  // renders (matching the documented "status indicator color" behavior)
  // instead of silently dropping the cover-page band.
  return palette.muted
}

const IMAGE_ALIGNMENTS = new Set(['left', 'center', 'right'])

/**
 * pdfmake 0.2 calls this with the nodes that follow on the same page as its
 * second argument (the bundled typings describe 0.3's query object instead).
 * A heading with nothing after it on its page but more content on the next
 * page is moved there, so it is never left alone at the foot of a page.
 */
function keepHeadingWithNext(node: Node, followingOnPage: Node[]): boolean {
  if (
    node.headlineLevel !== 1 ||
    node.pageNumbers.length !== 1 ||
    node.pageNumbers[0] >= node.pages ||
    // Already at the top of its page: moving it would only leave a blank page.
    node.startPosition.top <= PDF_TOP_MARGIN + 20
  ) {
    return false
  }
  const following = followingOnPage.filter(next => next.style !== RUNNING_STYLE)
  const content = following.find(next => next.headlineLevel !== 1)
  if (!content) return true
  // A table whose header row did not fit is carried to the next page whole,
  // yet its cells are still listed on this one; only the header id says so.
  const headerId = tableHeaderId(content)
  if (headerId === undefined) return false
  const header = following.find(next => next.id === headerId)
  return header?.startPosition.pageNumber !== node.pageNumbers[0]
}

/**
 * pdfmake hands a pageBreakBefore callback the nodes after each node on its
 * page, which it collects by scanning the rest of the document for every node,
 * and each break the callback asks for lays the whole document out again. Past
 * these sizes the check costs more than a heading left at the foot of a page.
 */
const KEEP_WITH_NEXT_MAX_NODES = 1500
const KEEP_WITH_NEXT_MAX_MOVES = 10

/** How many nodes pdfmake lays out for `content`, counted up to `limit`. */
function countNodes(content: unknown, limit: number): number {
  let count = 0
  const visit = (node: unknown): void => {
    if (count > limit || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    count++
    const n = node as Record<string, unknown>
    for (const key of ['stack', 'ul', 'ol', 'columns']) visit(n[key])
    const table = n.table as { body?: unknown } | undefined
    if (table) visit(table.body)
  }
  visit(content)
  return count
}

/** keepHeadingWithNext for `content`, or undefined when the document is too large for it. */
function headingKeeper(
  content: Content[]
): ((node: Node, following: Node[]) => boolean) | undefined {
  if (countNodes(content, KEEP_WITH_NEXT_MAX_NODES) > KEEP_WITH_NEXT_MAX_NODES) return undefined
  let moves = 0
  return (node: Node, following: Node[]) => {
    if (moves >= KEEP_WITH_NEXT_MAX_MOVES || !keepHeadingWithNext(node, following)) return false
    moves++
    return true
  }
}

/** The id buildTableNode gave a table's header; a right-to-left table has it last. */
function tableHeaderId(node: Node): string | undefined {
  const header = (node as { table?: { body?: Array<Array<{ id?: unknown }>> } }).table?.body?.[0]
  const id = Array.isArray(header)
    ? header.find(cell => typeof cell?.id === 'string')?.id
    : undefined
  return typeof id === 'string' && id.startsWith(TABLE_HEADER_ID) ? id : undefined
}

/** The spacer bodyToContent leaves for a blank line. */
function isBlankLine(node: Content): boolean {
  return typeof node === 'object' && node !== null && 'text' in node && node.text === ''
}

/**
 * Put each landscape table on landscape pages and return to portrait after
 * it. A heading directly above such a table moves with it. Returns the
 * orientation the document starts in.
 */
function applyPageOrientation(
  content: Content[],
  landscape: Set<Content>
): 'portrait' | 'landscape' {
  const previous = (i: number) => {
    let k = i - 1
    while (k >= 0 && isBlankLine(content[k])) k--
    return k
  }
  let initial: 'portrait' | 'landscape' = 'portrait'
  let current: 'portrait' | 'landscape' = 'portrait'
  for (let i = 0; i < content.length; i++) {
    if (isBlankLine(content[i])) continue
    const wanted = landscape.has(content[i]) ? 'landscape' : 'portrait'
    if (wanted === current) continue
    current = wanted
    let target = i
    const above = content[previous(i)] as { headlineLevel?: number } | undefined
    if (wanted === 'landscape' && above?.headlineLevel === 1) target = previous(i)
    // A break before the first node, or after the one that already ends the
    // cover page, would leave a blank page; those carry the orientation instead.
    const before = previous(target)
    if (before < 0) {
      initial = wanted
    } else if ((content[before] as { pageBreak?: string }).pageBreak === 'after') {
      Object.assign(content[before] as object, { pageOrientation: wanted })
    } else {
      Object.assign(content[target] as object, { pageBreak: 'before', pageOrientation: wanted })
    }
  }
  return initial
}

/**
 * `text` cut at a word, with an ellipsis, to one line of the running header,
 * where pdfmake drops whatever does not fit without a mark.
 */
function runningLine(text: string, width: number, measure: UnitMeasure): string {
  const fits = (s: string) => measure(s, false) * PDF_FOOTER_SIZE <= width * LINE_FILL
  if (text.length <= RUNNING_LINE_CHARS && fits(text)) return text
  // Far more than a line holds, so a huge title is never measured whole.
  const chars = Array.from(text.slice(0, RUNNING_LINE_CHARS))
  let kept = chars
    .slice(
      0,
      longestFitting(chars, s => fits(`${s.trimEnd()}…`))
    )
    .join('')
  const space = kept.lastIndexOf(' ')
  if (space > kept.length * 0.6) kept = kept.slice(0, space)
  return `${kept.trimEnd()}…`
}

export async function runGeneratePdf(
  args: Record<string, unknown>,
  outputDir: string
): Promise<InternalToolResult> {
  try {
    const filename = outputFilename(args.filename, 'pdf', 'output')
    const warnings: string[] = []
    const glyphs = pdfGlyphSource()
    // Titles take no formatting, so HTML in them is read as text.
    const title = args.title ? htmlToPlainText(String(args.title)) || undefined : undefined
    const body = String(args.body ?? '')
    const palette =
      PDF_PALETTES[choose(args.palette, Object.keys(PDF_PALETTES), 'default', 'palette', warnings)]
    const branding: PdfBranding = printedBranding(args.branding)
    const imageRefs = Array.isArray(args.images) ? args.images : []
    const tables = (Array.isArray(args.tables) ? args.tables : []) as PdfTableSpec[]
    const coverPage = Boolean(args.coverPage)
    const headline = args.headline ? htmlToPlainText(String(args.headline)) || undefined : undefined
    const statusBand = statusColorFromPalette(palette, args.statusColor as string | undefined)

    // A path outside the output folder still fails the call, but says what to pass instead.
    const loadImage = (ref: unknown, label: string) => {
      try {
        const image = loadEmbeddableImage(ref, outputDir, warnings, label)
        // pdfkit decodes every pixel of a PNG to embed it, so a small file of a
        // huge image takes gigabytes; the other formats embed the bytes as they are.
        if (image && image.pixels.width * image.pixels.height > MAX_DECODE_PIXELS) {
          warnings.push(
            `${label} '${path.basename(image.path)}' is ${image.pixels.width} x ${image.pixels.height} ` +
              `pixels, more than the ${MAX_DECODE_PIXELS / 1e6} million a PDF image may have, so it ` +
              'was left out. Scale it down first.'
          )
          return undefined
        }
        return image
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(
          `${label}: ${reason}. Images are read from the output folder; pass the file name ` +
            "clerum__generate_chart returned, such as 'sales.png'."
        )
      }
    }

    // The footer sets the bottom margin, and with it the room images and tables have.
    const pageNumberWidth = 40
    // Measured at 100pt and scaled down: at 1pt the canvas rounds widths to hundredths.
    const measure: UnitMeasure = (text, bold) =>
      glyphs.measure(text, PDF_FONT_FAMILY, 100, bold) / 100
    const footer = branding.footerText
      ? footerLines(branding.footerText, PDF_CONTENT_WIDTH - pageNumberWidth, measure, warnings)
      : []
    const bottomMargin = Math.max(MIN_BOTTOM_MARGIN, 34 + footer.length * PDF_FOOTER_SIZE * 1.3)
    const contentHeight = PORTRAIT.height - (bottomMargin - MIN_BOTTOM_MARGIN)

    let imagesRequested = 0
    let imagesPlaced = 0
    const placeImage = (
      ref: unknown,
      label: string,
      sizing: { width?: unknown; height?: unknown; alignment?: unknown } = {}
    ): Content | undefined => {
      imagesRequested++
      const src = typeof ref === 'string' ? ref : undefined
      if (src && /^(https?:|data:)/i.test(src)) {
        warnings.push(
          `${label} is a web address or inline data, which is not downloaded; save the image to the ` +
            'output folder first (clerum__generate_chart does) and pass its file name.'
        )
        return undefined
      }
      const image = loadImage(ref, label)
      if (!image) return undefined
      const requested = {
        ...(typeof sizing.width === 'number' ? { width: sizing.width } : {}),
        ...(typeof sizing.height === 'number' ? { height: sizing.height } : {}),
      }
      const sized = requested.width !== undefined || requested.height !== undefined
      const box = fitImageSize(
        image,
        {
          width: PDF_CONTENT_WIDTH,
          // An image given a size may take the page, less its own margins.
          height: sized ? contentHeight - 2 * PDF_IMAGE_MARGIN : PDF_MAX_IMAGE_HEIGHT,
        },
        requested
      )
      imagesPlaced++
      return {
        image: imageDataUrl(image),
        width: box.width,
        height: box.height,
        alignment: IMAGE_ALIGNMENTS.has(String(sizing.alignment)) ? sizing.alignment : 'center',
        margin: [0, PDF_IMAGE_MARGIN, 0, PDF_IMAGE_MARGIN],
      } as Content
    }

    const env: PdfBodyEnv = {
      warnings,
      measure,
      image: src => placeImage(src, `The body image '${src}'`),
      landscape: new Set(),
      tableCount: 0,
      tablesBuilt: 0,
      bottomMargin,
    }

    const content: Content[] = []

    // Cover page.
    if (coverPage) {
      const coverTitle = title ?? headline ?? filename.replace(/\.pdf$/, '')
      if (!title) {
        warnings.push(
          `coverPage was set without a title, so the cover shows '${coverTitle}'; pass title to choose it.`
        )
      }
      if (statusBand) {
        content.push({
          canvas: [
            {
              type: 'rect',
              x: 0,
              y: 0,
              w: PDF_CONTENT_WIDTH,
              h: 6,
              color: statusBand,
            },
          ],
          margin: [0, 0, 0, 24],
        })
      }
      if (branding.logoPath) {
        const logo = loadImage(branding.logoPath, 'branding.logoPath')
        if (logo) {
          const box = fitImageSize(logo, PDF_LOGO_BOX, { width: PDF_LOGO_BOX.width })
          content.push({
            image: imageDataUrl(logo),
            width: box.width,
            height: box.height,
            margin: [0, 0, 0, 12],
          })
        }
      }
      content.push({
        text: coverTitle,
        style: 'cover',
        color: palette.primary,
        margin: [0, 80, 0, 12],
      })
      if (headline && title) {
        content.push({
          text: headline,
          style: 'lead',
          color: palette.muted,
          margin: [0, 0, 0, 20],
        })
      }
      content.push({
        text: new Date().toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }),
        color: palette.muted,
        fontSize: 11,
        margin: [0, 0, 0, 0],
        pageBreak: 'after',
      })
    } else {
      if (title) {
        content.push({
          text: title,
          style: 'docTitle',
          color: palette.primary,
          margin: [0, 0, 0, 12],
        })
      }
      const coverOnly = [
        headline ? 'headline' : '',
        args.statusColor ? 'statusColor' : '',
        branding.logoPath ? 'branding.logoPath' : '',
      ].filter(Boolean)
      if (coverOnly.length > 0) {
        const many = coverOnly.length > 1
        warnings.push(
          `${coverOnly.join(', ')} ${many ? 'are' : 'is'} only drawn on the cover page, so ` +
            `${many ? 'they were' : 'it was'} left out; pass coverPage: true to show ${many ? 'them' : 'it'}.`
        )
      }
    }

    // Body.
    content.push(...bodyToContent(body, palette, env))

    // Tables (after body).
    tables.forEach((t, index) => {
      const label = `tables[${index}]`
      if (!t || !Array.isArray(t.headers) || t.headers.length === 0) {
        warnings.push(`${label} has no headers and was left out; pass headers: ['Column', ...].`)
        return
      }
      const rows = normalizeTableRows(t.rows, t.headers, label, warnings).map(row =>
        row.map(cell => (cell === null || cell === undefined ? '' : String(cell)))
      )
      content.push(
        buildTableNode(
          {
            headers: t.headers.map(headerText),
            rows,
            layout: t.layout,
            widths: t.widths,
            label,
            rowLabel: row => `${label}.rows[${row}]`,
          },
          palette,
          env,
          image =>
            warnings.push(
              `${label} names the image '${image.src}' in a cell, which a table cannot hold; pass it in images instead.`
            )
        )
      )
    })

    // Images (charts, logos) at the end of the body.
    imageRefs.forEach((ref, index) => {
      const sizing = ref && typeof ref === 'object' ? (ref as PdfImageRef) : {}
      const block = placeImage(ref, `images[${index}]`, sizing)
      if (block) content.push(block)
    })

    if (imagesRequested > 0 && imagesPlaced === 0 && content.every(isBlankLine)) {
      return {
        success: false,
        error: `No PDF was written: none of the images could be embedded. ${warnings.join(' ')}`,
      }
    }
    if (content.every(isBlankLine)) warnings.push(EMPTY_DOCUMENT_NOTE)

    const pageOrientation = applyPageOrientation(content, env.landscape)

    const styles: Record<string, Record<string, unknown>> = {
      cover: { fontSize: 36, bold: true },
      lead: { fontSize: 16, italics: true },
      docTitle: { fontSize: 22, bold: true },
      h1: { fontSize: 18, bold: true, color: palette.primary },
      h2: { fontSize: 14, bold: true, color: palette.primary },
      h3: { fontSize: 12, bold: true, color: palette.muted },
      [RUNNING_STYLE]: { fontSize: PDF_FOOTER_SIZE, color: palette.muted },
    }
    const typesetter = new PdfTypesetter(glyphs, styles)
    const base = {
      width: PDF_CONTENT_WIDTH,
      font: PDF_FONT_FAMILY,
      fontSize: BODY_FONT_SIZE,
      bold: false,
      lineHeight: PDF_LINE_HEIGHT,
    }
    typesetter.typeset(content, base)

    // The running header and footer are laid out on every page, so their text
    // is typeset once here and copied into each page's nodes.
    const running = (text: string | undefined, width: number): ContentText => {
      const node: ContentText = { text: text ?? '', style: RUNNING_STYLE }
      typesetter.typeset(node, { ...base, width })
      return node
    }
    // The title is printed whole on the first page; the running header takes one line of it.
    const half = PDF_CONTENT_WIDTH / 2
    const company = branding.companyName && runningLine(branding.companyName, half, measure)
    if (company && company !== branding.companyName) {
      warnings.push('branding.companyName is longer than the page header and was shortened there.')
    }
    const companyNode = running(company || undefined, half)
    const headerTitleNode = running(title && runningLine(title, half, measure), half)
    const footerNode = running(footer.join('\n'), PDF_CONTENT_WIDTH - pageNumberWidth)
    typesetter.settleShaping()
    const copy = (node: ContentText): ContentText => JSON.parse(JSON.stringify(node))

    const docDef: TDocumentDefinitions = {
      info: {
        title: title ?? 'Report',
        ...(branding.companyName ? { creator: branding.companyName } : {}),
      },
      pageSize: 'A4',
      pageOrientation,
      pageMargins: [40, PDF_TOP_MARGIN, 40, bottomMargin],
      defaultStyle: {
        font: PDF_FONT_FAMILY,
        fontSize: BODY_FONT_SIZE,
        color: palette.text,
        lineHeight: PDF_LINE_HEIGHT,
      },
      styles,
      pageBreakBefore: headingKeeper(content) as unknown as TDocumentDefinitions['pageBreakBefore'],
      header: (currentPage: number) =>
        currentPage === 1 && coverPage
          ? null
          : {
              columns: [copy(companyNode), { ...copy(headerTitleNode), alignment: 'right' }],
              style: RUNNING_STYLE,
              margin: [40, 24, 40, 0],
            },
      footer: (currentPage: number, pageCount: number) => ({
        columns: [
          copy(footerNode),
          {
            text: `${currentPage} / ${pageCount}`,
            style: RUNNING_STYLE,
            alignment: 'right',
            width: pageNumberWidth,
          },
        ],
        style: RUNNING_STYLE,
        margin: [40, 0, 40, 24],
      }),
      content,
    }

    // Han characters take the glyph forms of the document's language.
    const language = documentEastAsianScript(
      [
        title,
        body,
        branding.companyName,
        branding.footerText,
        ...tables.map(t => JSON.stringify([t.headers, t.rows])),
      ]
        .filter(text => text !== undefined && text !== null)
        .map(String)
        .join('\n')
    )?.lang
    const printer = new PdfPrinter(glyphs.descriptors(typesetter.families, language))
    const pdfDoc = printer.createPdfKitDocument(docDef)

    const pdfBuffer: Buffer = await new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      pdfDoc.on('data', (c: Buffer) => chunks.push(c))
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)))
      pdfDoc.on('error', reject)
      pdfDoc.end()
    })

    ensureDir(outputDir)
    const target = claimOutputFile(outputDir, filename)
    enforceQuota(outputDir, pdfBuffer.byteLength, replacedBytes(target))
    fs.writeFileSync(target.filePath, pdfBuffer)

    return artifactResult(target, 'pdf', { warnings: [...warnings, ...typesetter.warnings()] })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
