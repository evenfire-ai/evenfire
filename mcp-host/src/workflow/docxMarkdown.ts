/**
 * The markdown body of a generated Word document, as paragraphs and tables.
 */
import { BorderStyle, HeadingLevel, Paragraph, ShadingType, type Table, TextRun } from 'docx'
import { inlineRuns, textRuns } from './docxInline'
import { docxDirection, isRtlText } from './docxScript'
import { DOCX_LIST_LEVELS, type DocxListNumbering, type DocxPalette, docxHex } from './docxStyle'
import { buildDocxTable } from './docxTable'
import {
  closesFence,
  imageTarget,
  openingFence,
  quoteParagraphs,
  withoutClosingHashes,
} from './inlineMarkup'

export interface DocxBodyContext {
  palette: DocxPalette
  numbering: DocxListNumbering
  warnings: string[]
  /** The paragraph holding an image named in the body, or undefined when it cannot be embedded. */
  image(file: string, alt: string): Paragraph | undefined
}

const BULLET_RE = /^[-*+]\s+/
const ORDERED_RE = /^(\d{1,9})[.)]\s+/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const QUOTE_RE = /^>\s?/
const IMAGE_LINE_RE = /^!\[([^\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))*)\)$/
const SEPARATOR_CELL_RE = /^:?-+:?$/

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line)
  return m ? m[0].replace(/\t/g, '  ').length : 0
}

function isListLine(line: string): boolean {
  const t = line.trimStart()
  return BULLET_RE.test(t) || ORDERED_RE.test(t)
}

/** Cells of a pipe-table row. `\|` is a literal pipe inside a cell. */
function splitTableRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  return t.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
}

/**
 * A delimiter row such as `|---|:--:|`. Checked cell by cell: the one-regex
 * form backtracks quadratically over a long run of spaces.
 */
function isTableSeparator(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false
  const cells = splitTableRow(line)
  return cells.every(cell => SEPARATOR_CELL_RE.test(cell))
}

/**
 * A GFM table starts at a row followed by a separator. Without outer pipes the
 * header must have as many cells as the separator, which is what tells a table
 * apart from a sentence that happens to contain a pipe.
 */
function startsTable(lines: string[], i: number): boolean {
  const line = lines[i]
  const next = lines[i + 1]
  if (next === undefined || !line.includes('|') || !isTableSeparator(next)) return false
  return (
    line.trimStart().startsWith('|') || splitTableRow(line).length === splitTableRow(next).length
  )
}

function blankParagraph(): Paragraph {
  return new Paragraph({ children: [new TextRun({ text: '' })] })
}

interface ListFrame {
  indent: number
  ordered: boolean
  reference: string
  instance: number
  last?: number
}

/**
 * Consume one list, nested items included, starting at `start`. Depth follows
 * the stack of indents seen so far, as the PDF generator does, so a 4-space
 * sub-item is one level down rather than two. Blank lines between items keep a
 * loose list together; a switch between bullets and numbers, or a count that
 * starts over at 1, begins a new list.
 */
function parseList(lines: string[], start: number, ctx: DocxBodyContext, out: Paragraph[]): number {
  const base = indentOf(lines[start])
  const stack: ListFrame[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      let next = i
      while (next < lines.length && lines[next].trim() === '') next++
      if (next < lines.length && isListLine(lines[next]) && indentOf(lines[next]) >= base) {
        i = next
        continue
      }
      break
    }
    if (!isListLine(line) || indentOf(line) < base) break

    const indent = indentOf(line)
    const trimmed = line.trimStart()
    const numbered = ORDERED_RE.exec(trimmed)
    const ordered = numbered !== null
    const number = numbered ? Number(numbered[1]) : undefined

    while (stack.length > 0 && stack[stack.length - 1].indent > indent) stack.pop()
    let frame: ListFrame | undefined = stack[stack.length - 1]
    if (
      frame &&
      frame.indent === indent &&
      (frame.ordered !== ordered || (number === 1 && (frame.last ?? 0) > 1))
    ) {
      stack.pop()
      frame = undefined
    }
    if (!frame || (frame.indent < indent && stack.length < DOCX_LIST_LEVELS)) {
      frame = { indent, ordered, ...ctx.numbering.begin(ordered, number ?? 1) }
      stack.push(frame)
    }
    frame.last = number

    const item = trimmed.replace(BULLET_RE, '').replace(ORDERED_RE, '')
    out.push(
      new Paragraph({
        ...docxDirection(item),
        numbering: {
          reference: frame.reference,
          instance: frame.instance,
          level: stack.length - 1,
        },
        children: inlineRuns(item, { color: docxHex(ctx.palette.text) }, ctx.warnings),
      })
    )
    i++
  }
  return i
}

/** Whether `line` opens a block other than a table row, which ends a table. */
function startsOtherBlock(line: string): boolean {
  const t = line.trim()
  if (t.startsWith('|')) return false
  return (
    HEADING_RE.test(t) ||
    openingFence(t) !== undefined ||
    QUOTE_RE.test(t) ||
    IMAGE_LINE_RE.test(t) ||
    isListLine(line)
  )
}

function headingParagraph(level: number, text: string, ctx: DocxBodyContext): Paragraph {
  const { palette, warnings } = ctx
  const content = withoutClosingHashes(text)
  const style =
    level === 1
      ? { heading: HeadingLevel.HEADING_1, before: 360, after: 160, size: 36, bold: true }
      : level === 2
        ? { heading: HeadingLevel.HEADING_2, before: 280, after: 120, size: 28, bold: true }
        : { heading: HeadingLevel.HEADING_3, before: 200, after: 80, size: 22, bold: false }
  const color = docxHex(level <= 2 ? palette.primary : palette.muted)
  return new Paragraph({
    ...docxDirection(content),
    heading: style.heading,
    spacing: { before: style.before, after: style.after },
    // docx's heading styles do not keep with the next paragraph, so a heading
    // could end a page with its section starting on the next.
    keepNext: true,
    keepLines: true,
    children: inlineRuns(content, { color, size: style.size, bold: style.bold }, warnings),
  })
}

/**
 * Paragraphs and tables for a markdown body: headings, lists, pipe tables,
 * fenced code, quotes, rules, images on a line of their own, and paragraphs of
 * inline markdown.
 */
export function bodyToDocxChildren(body: string, ctx: DocxBodyContext): (Paragraph | Table)[] {
  const { palette, warnings } = ctx
  const out: (Paragraph | Table)[] = []
  const lines = body.split('\n')
  let tables = 0
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    const fence = openingFence(trimmed)
    if (fence) {
      // The language after the opening fence is noted above the block, as in the PDF.
      const { marker, language } = fence
      const code: string[] = []
      i++
      while (i < lines.length && !closesFence(lines[i], marker)) {
        code.push(lines[i])
        i++
      }
      i++
      if (language) {
        out.push(
          new Paragraph({
            spacing: { before: 60, after: 0 },
            children: textRuns(language, { size: 16, color: docxHex(palette.muted) }),
          })
        )
      }
      for (const codeLine of code) {
        out.push(
          new Paragraph({
            spacing: { before: 0, after: 0 },
            shading: { type: ShadingType.CLEAR, fill: docxHex(palette.surface) },
            children: [
              new TextRun({
                text: codeLine === '' ? ' ' : codeLine,
                font: { ascii: 'Courier New', hAnsi: 'Courier New' },
                size: 18,
                color: docxHex(palette.text),
              }),
            ],
          })
        )
      }
      out.push(new Paragraph({ children: [new TextRun({ text: '' })], spacing: { after: 80 } }))
      continue
    }

    const heading = HEADING_RE.exec(trimmed)
    if (heading) {
      out.push(headingParagraph(heading[1].length, heading[2], ctx))
      i++
      continue
    }

    const image = IMAGE_LINE_RE.exec(trimmed)
    if (image) {
      const paragraph = ctx.image(imageTarget(image[2]), image[1])
      if (paragraph) out.push(paragraph)
      i++
      continue
    }

    if (startsTable(lines, i)) {
      const headers = splitTableRow(line)
      const rows: string[][] = []
      i += 2
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        lines[i].includes('|') &&
        !startsOtherBlock(lines[i])
      ) {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      out.push(
        buildDocxTable(headers, rows, palette, 'striped', warnings, `The body's table ${++tables}`)
      )
      out.push(new Paragraph({ children: [new TextRun({ text: '' })], spacing: { before: 60 } }))
      continue
    }

    // A rule wins over a list: "- - -" and "* * *" are rules in markdown.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed.replace(/\s+/g, ''))) {
      out.push(
        new Paragraph({
          spacing: { before: 120, after: 120 },
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              color: docxHex(palette.border),
              size: 6,
              space: 1,
            },
          },
          children: [new TextRun({ text: '' })],
        })
      )
      i++
      continue
    }

    if (isListLine(line)) {
      const items: Paragraph[] = []
      i = parseList(lines, i, ctx, items)
      out.push(...items)
      continue
    }

    if (QUOTE_RE.test(trimmed)) {
      const quoted: string[] = []
      while (i < lines.length && QUOTE_RE.test(lines[i].trimStart())) {
        quoted.push(lines[i].trimStart().replace(QUOTE_RE, ''))
        i++
      }
      const paragraphs = quoteParagraphs(quoted)
      const bar = { style: BorderStyle.SINGLE, color: docxHex(palette.primary), size: 12, space: 8 }
      // In a right-to-left paragraph Word reads the indent from the right but
      // draws borders where they are named, so the bar moves to the right.
      paragraphs.forEach((quote, n) =>
        out.push(
          new Paragraph({
            ...docxDirection(quote),
            spacing: { before: n === 0 ? 120 : 0, after: n === paragraphs.length - 1 ? 120 : 80 },
            indent: { left: 360 },
            border: isRtlText(quote) ? { right: bar } : { left: bar },
            children: inlineRuns(quote, { color: docxHex(palette.muted) }, warnings),
          })
        )
      )
      continue
    }

    if (trimmed === '') {
      out.push(blankParagraph())
      i++
      continue
    }

    out.push(
      new Paragraph({
        ...docxDirection(line),
        spacing: { after: 80 },
        children: inlineRuns(line, { color: docxHex(palette.text) }, warnings),
      })
    )
    i++
  }

  return out
}

/** Whether the body holds anything besides images on lines of their own. */
export function bodyHasText(body: string): boolean {
  return body.split('\n').some(line => line.trim() !== '' && !IMAGE_LINE_RE.test(line.trim()))
}
