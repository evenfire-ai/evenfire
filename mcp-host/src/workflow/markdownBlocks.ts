/**
 * The markdown block rules the PDF and DOCX body parsers share: which block a
 * line starts and where it ends (readBlock), and how a list item, a table row
 * and a delimiter row read. Each renderer only draws what this finds. Every
 * rule runs on text a model wrote, so none may backtrack across the line.
 */
import { closesFence, openingFence, quoteParagraphs, withoutClosingHashes } from './inlineMarkup'

export type ColumnAlignment = 'left' | 'center' | 'right'

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const QUOTE_RE = /^>\s?/
const RULE_RE = /^(-{3,}|\*{3,}|_{3,})$/
/** An image on a line of its own: its alt text and its target. */
export const IMAGE_LINE_RE = /^!\[([^\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))*)\)$/

export const BULLET_RE = /^[-*+]\s+/
/** CommonMark numbers a list item with one to nine digits. */
export const ORDERED_RE = /^(\d{1,9})[.)]\s+/
const SEPARATOR_CELL_RE = /^:?-+:?$/

/** Indent width of a list line, used to decide its nesting depth. */
export function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line)
  // A tab counts as one level, matching how models write nested lists.
  return m ? m[0].replace(/\t/g, '  ').length : 0
}

export function isListLine(line: string): boolean {
  const t = line.trimStart()
  return BULLET_RE.test(t) || ORDERED_RE.test(t)
}

/** The item's text without its bullet or number. */
export function stripListMarker(line: string): string {
  return line.trimStart().replace(BULLET_RE, '').replace(ORDERED_RE, '')
}

/** Cells of a pipe-table row. `\|` is a literal pipe inside a cell. */
export function splitTableRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  return t.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
}

/**
 * A GFM delimiter row such as `|---|:--:|`. It needs a pipe, so a lone `---`
 * stays a rule. Checked cell by cell: one pattern over the whole row
 * backtracks quadratically over a long run of spaces.
 */
export function isTableSeparator(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false
  return splitTableRow(line).every(cell => SEPARATOR_CELL_RE.test(cell))
}

/**
 * Whether a GFM table starts at line `i`: a row followed by a delimiter row.
 * Without outer pipes the header must have as many cells as the delimiter row,
 * which tells a table from a sentence that happens to hold a pipe.
 */
export function startsTable(lines: string[], i: number): boolean {
  const line = lines[i]
  const next = lines[i + 1]
  if (next === undefined || !line.includes('|') || !isTableSeparator(next)) return false
  return (
    line.trimStart().startsWith('|') || splitTableRow(line).length === splitTableRow(next).length
  )
}

/** The alignments a GFM delimiter row declares (`:---`, `---:`, `:---:`). */
export function parseColumnAlignments(separator: string): ColumnAlignment[] {
  return splitTableRow(separator).map(cell => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/** One block of a markdown body, with the index of the line after it. */
export type MarkdownBlock =
  | { kind: 'code'; language: string; code: string[]; next: number }
  | { kind: 'heading'; level: number; text: string; next: number }
  | { kind: 'rule'; next: number }
  | {
      kind: 'table'
      headers: string[]
      alignments: ColumnAlignment[]
      rows: string[][]
      next: number
    }
  | { kind: 'quote'; paragraphs: string[]; next: number }
  /** A list starts here; each renderer reads its items and nesting. */
  | { kind: 'list' }
  | { kind: 'blank'; next: number }
  /** A line of text: a paragraph, or an image on a line of its own. */
  | { kind: 'text'; line: string; next: number }

/** Whether `line` opens a block other than a table row, which ends a table (GFM). */
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

/**
 * The block that starts at line `i`. A fence runs to its closing fence, a
 * table to the first blank line or other block, a quote over its `>` lines.
 * A rule wins over a list: "- - -" and "* * *" are rules in markdown.
 */
export function readBlock(lines: string[], i: number): MarkdownBlock {
  const line = lines[i]
  const trimmed = line.trim()

  const fence = openingFence(trimmed)
  if (fence) {
    const code: string[] = []
    let next = i + 1
    while (next < lines.length && !closesFence(lines[next], fence.marker)) code.push(lines[next++])
    return { kind: 'code', language: fence.language, code, next: next + 1 }
  }

  const heading = HEADING_RE.exec(trimmed)
  if (heading) {
    const text = withoutClosingHashes(heading[2])
    return { kind: 'heading', level: heading[1].length, text, next: i + 1 }
  }

  if (startsTable(lines, i)) {
    const rows: string[][] = []
    let next = i + 2
    while (
      next < lines.length &&
      lines[next].trim() !== '' &&
      lines[next].includes('|') &&
      !startsOtherBlock(lines[next])
    ) {
      rows.push(splitTableRow(lines[next++]))
    }
    const headers = splitTableRow(line)
    const alignments = parseColumnAlignments(lines[i + 1])
    return { kind: 'table', headers, alignments, rows, next }
  }

  if (RULE_RE.test(trimmed.replace(/\s+/g, ''))) return { kind: 'rule', next: i + 1 }
  if (isListLine(line)) return { kind: 'list' }

  if (QUOTE_RE.test(trimmed)) {
    const quoted: string[] = []
    let next = i
    while (next < lines.length && QUOTE_RE.test(lines[next].trimStart())) {
      quoted.push(lines[next++].trimStart().replace(QUOTE_RE, ''))
    }
    return { kind: 'quote', paragraphs: quoteParagraphs(quoted), next }
  }

  if (trimmed === '') return { kind: 'blank', next: i + 1 }
  return { kind: 'text', line, next: i + 1 }
}
