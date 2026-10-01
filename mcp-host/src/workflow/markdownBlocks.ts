/**
 * Line-level markdown rules the PDF and DOCX body parsers share, so both read
 * a list item, a table row and a delimiter row the same way. Every rule runs
 * on text a model wrote, so none may backtrack across the line.
 */

export type ColumnAlignment = 'left' | 'center' | 'right'

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
