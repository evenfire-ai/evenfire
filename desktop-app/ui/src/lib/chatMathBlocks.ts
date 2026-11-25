import { bracketDisplayHoldsMath, displayHoldsMath, inlineDollarsHoldMath } from './chatMathProse'

/** Offsets of the closing delimiter. */
type MathBlockClose = Readonly<{ start: number; end: number }>

const MAX_BLOCK_CHARS = 20_000
export const MAX_DOLLAR_RUN = 8

const LINE_PREFIX = /^[ \t>]*/
const CODE_FENCE = /^(?:`{3}|~{3})/
const ESCAPED_BACKSLASH = /\\\\/g
// Sentence punctuation may follow the closing delimiter.
const LINE_REST = /^[ \t]*[.,;:!?]?[ \t]*$/

/**
 * Looks ahead for the delimiter that closes the block at `start`. Markdown runs
 * an unclosed block to the end of the reply, so a block opens only if it closes
 * before a blank line and holds math.
 */
export function mathBlockClose(text: string, start: number): MathBlockClose | null {
  const dollars = /^\$+/.exec(text.slice(start, start + MAX_DOLLAR_RUN + 1))?.[0]
  const opener = dollars ?? '\\['
  if (dollars && (dollars.length < 2 || dollars.length > MAX_DOLLAR_RUN)) return null
  if (!text.startsWith(opener, start)) return null
  const closer = dollars ?? '\\]'
  const holdsMath = dollars ? displayHoldsMath : bracketDisplayHoldsMath
  const limit = Math.min(text.length, start + MAX_BLOCK_CHARS)
  const before = text.slice(startOfLine(text, start), start)
  const quotes = countOf(before, '>')
  // Inside a list item, the block's lines must stay indented.
  const indent = /[^\s>]/.test(before) ? before.length - countOf(before, '>') : 0

  let content = ''
  let blanks = false
  let bare = false
  let lineStart = start + opener.length
  for (let first = true; lineStart < limit; first = false) {
    const lineEnd = endOfLine(text, lineStart)
    const prefix = first ? 0 : (LINE_PREFIX.exec(text.slice(lineStart, lineEnd))?.[0].length ?? 0)
    const line = text.slice(lineStart + prefix, lineEnd)
    if (!first && line.trim()) {
      const lead = text.slice(lineStart, lineStart + prefix)
      const columns = lead.replace(/\t/g, '    ').length - countOf(lead, '>')
      if (countOf(lead, '>') < quotes || columns < Math.min(indent, 2)) return null
    }
    // `\\[4pt]` is a line break, not a delimiter.
    const delimiters = dollars ? line : line.replace(ESCAPED_BACKSLASH, '  ')
    const at = delimiters.indexOf(closer)
    if (at !== -1) {
      const run = dollars ? (/^\$+/.exec(line.slice(at))?.[0].length ?? 0) : closer.length
      if (first || run !== closer.length || !LINE_REST.test(line.slice(at + run))) return null
      if (blanks && !blankLinesHoldMath(content, line.slice(0, at))) return null
      if (!holdsMath(content + line.slice(0, at))) return null
      const closeStart = lineStart + prefix + at
      return { start: closeStart, end: closeStart + run }
    }
    if (delimiters.includes(opener) || CODE_FENCE.test(line)) return null
    if (first) bare = !line.trim()
    else if (!line.trim()) blanks = true
    if (blanks && !bare) return null
    content += `${line}\n`
    lineStart = lineEnd + (text.startsWith('\r\n', lineEnd) ? 2 : 1)
  }
  return null
}

/** Blank lines are accepted only between bare fences around LaTeX commands. */
function blankLinesHoldMath(content: string, lastLine: string): boolean {
  return !lastLine.trim() && /\\[A-Za-z]/.test(content) && inlineDollarsHoldMath(content)
}

function countOf(text: string, char: string): number {
  return text.split(char).length - 1
}

function startOfLine(text: string, from: number): number {
  return Math.max(text.lastIndexOf('\n', from - 1), text.lastIndexOf('\r', from - 1)) + 1
}

function endOfLine(text: string, from: number): number {
  for (let index = from; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === 10 || code === 13) return index
  }
  return text.length
}
