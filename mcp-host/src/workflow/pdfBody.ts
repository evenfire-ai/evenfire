/** The document body: markdown, lists, tables, code and quotes as pdfmake content. */
import { type Content, type ContentText } from 'pdfmake/interfaces'
import { PDF_MONO_FAMILY } from './fonts'
import { inlineSpans } from './inlineMarkup'
import {
  type ColumnAlignment,
  ORDERED_RE,
  indentOf,
  isListLine,
  readBlock,
  stripListMarker,
} from './markdownBlocks'
import { type PdfPalette } from './pdfPalette'
import { BODY_FONT_SIZE, PORTRAIT, type UnitMeasure, layoutPdfTable } from './pdfTables'

/** A4 width (595pt) less the 40pt side margins the documents use. */
export const PDF_CONTENT_WIDTH = PORTRAIT.width

/**
 * Id prefix of each table's first header cell. pdfmake corrects the page
 * number it records for a block moved to the next page only on nodes with an
 * id, and the heading check reads it to see where a table really starts.
 */
export const TABLE_HEADER_ID = 'pdf-table-'

/** What the body parser needs from the call it serves. */
export interface PdfBodyEnv {
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

export function buildTableNode(
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
export function bodyToContent(body: string, palette: PdfPalette, env: PdfBodyEnv): Content[] {
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
