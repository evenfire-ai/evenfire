import { logger } from '../../logger'
import { Safety } from '../interfaces'
import { isPrivateIp } from '../tools/httpRequest'
import { SanitizedOutput, ValidationResult } from '../types'

/**
 * Basic safety implementation.
 *
 * Enforces the four checkpoints from the spec (section 6.1):
 * 1. Input validation
 * 2. Tool parameter validation
 * 3. Output sanitization
 * 4. LLM context wrapping
 *
 * This is a minimal viable implementation. Enhanced safety
 * (PII detection, rate limiting, content policy) can be added
 * by implementing the Safety interface and injecting via DI.
 */
/**
 * Returns the current set of secret name/value pairs whose plaintext should
 * be redacted from tool output. Called on every sanitize pass so a rotation
 * via ConfigStore takes effect immediately.
 */
export type SecretEntriesProvider = () => Array<{ name: string; value: string }>

// Any opening or closing `tool_output` tag, whatever its attributes, spacing or
// case, closed or not: the model must not read a forged wrapper boundary inside
// the content. `[^<>]*` stops at the next `<`, so each match scans only up to
// the next tag start and the whole pass stays linear; the optional `>` escapes
// an unclosed forged tag too. The replacement only escapes `<` and `>`, so no
// text is lost.
const TOOL_OUTPUT_TAG_PATTERN = /<(?:\s*\/)?\s*tool_output\b[^<>]*>?/gi

function wrapToolOutput(toolName: string, content: string, wasSanitized: boolean): string {
  const escaped = content.replace(TOOL_OUTPUT_TAG_PATTERN, tag =>
    tag.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  )
  return `<tool_output name="${toolName}" sanitized="${wasSanitized}">\n${escaped}\n</tool_output>`
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

export type RedactionRange = { start: number; end: number; replacement: string }
// `scalar`: the piece is a whole number or literal, replaced by a JSON string.
type RedactionPiece = RedactionRange & { scalar: boolean }

/**
 * String tokens of a valid JSON text, found in one iterative scan. `tokenOf[i]`
 * is the index of the token whose inner span (between its quotes, escapes still
 * encoded) holds code unit `i`, or -1 outside every string. `escapeOffset[i]`
 * is the distance from code unit `i` back to the backslash that opens the
 * escape sequence holding it, or 0 when `i` is not inside one past its start.
 */
function scanJsonStrings(text: string): {
  tokens: Array<{ start: number; end: number }>
  tokenOf: Int32Array
  escapeOffset: Uint8Array
} {
  const tokens: Array<{ start: number; end: number }> = []
  const tokenOf = new Int32Array(text.length).fill(-1)
  const escapeOffset = new Uint8Array(text.length)
  let i = 0
  while (i < text.length) {
    if (text.charCodeAt(i) !== 0x22) {
      i++
      continue
    }
    const start = i + 1
    let j = start
    while (j < text.length && text.charCodeAt(j) !== 0x22) {
      if (text.charCodeAt(j) === 0x5c) {
        const length = text.charCodeAt(j + 1) === 0x75 ? 6 : 2
        for (let k = 1; k < length; k++) escapeOffset[j + k] = k
        j += length
      } else {
        j++
      }
    }
    if (j >= text.length) throw new Error('scanJsonStrings: unterminated string in valid JSON')
    tokenOf.fill(tokens.length, start, j)
    tokens.push({ start, end: j })
    i = j + 1
  }
  return { tokens, tokenOf, escapeOffset }
}

/**
 * A working copy of a text that redaction rules rewrite in turn, with the
 * range of the original text behind each of its code units. An original code
 * unit stands for itself; a replacement's code units stand for the union of
 * the ranges it replaced, so a later match that covers part of an earlier
 * replacement covers everything that replacement stands for, and a match
 * `[a, b)` stands for the range from code unit `a`'s start to code unit
 * `b - 1`'s end.
 *
 * Only the replacements are stored, as segments sorted along the copy: code
 * units `[textStart, textEnd)` stand for `[origStart, origEnd)`. The code
 * units between two segments are original and consecutive, and the first one
 * after a segment stands for that segment's `origEnd`, so the bookkeeping of a
 * replacement costs time in the number of segments, not in the length of the
 * text. Rebuilding the copy itself still costs time in its length.
 */
class RedactionReplay {
  text: string
  readonly ranges: RedactionRange[] = []
  private count = 0
  private textStart = new Int32Array(0)
  private textEnd = new Int32Array(0)
  private origStart = new Int32Array(0)
  private origEnd = new Int32Array(0)

  constructor(content: string) {
    this.text = content
  }

  /**
   * Replaces sorted, non-overlapping, non-empty `matches` of `text` with a
   * non-empty `replacement`.
   */
  replace(matches: Array<[number, number]>, replacement: string): void {
    if (matches.length === 0) return
    if (replacement.length === 0) throw new Error('RedactionReplay: empty replacement')
    // Each match adds its own segment, and one more when it lies strictly
    // inside a segment, which it cuts into a part before and a part after it.
    // Typed arrays drop writes past their end, so the count is checked below.
    const capacity = this.count + 2 * matches.length
    const textStart = new Int32Array(capacity)
    const textEnd = new Int32Array(capacity)
    const origStart = new Int32Array(capacity)
    const origEnd = new Int32Array(capacity)
    let count = 0
    const parts: string[] = []
    let cursor = 0
    let shift = 0
    let k = 0
    // The end of the last segment before the current position, in the
    // current copy and in the original: an original code unit `p` after it
    // stands for `prevOrigEnd + (p - prevTextEnd)`.
    let prevTextEnd = 0
    let prevOrigEnd = 0
    for (const [a, b] of matches) {
      while (k < this.count && this.textEnd[k] <= a) {
        textStart[count] = this.textStart[k] + shift
        textEnd[count] = this.textEnd[k] + shift
        origStart[count] = this.origStart[k]
        origEnd[count] = this.origEnd[k]
        count++
        prevTextEnd = this.textEnd[k]
        prevOrigEnd = this.origEnd[k]
        k++
      }
      let start: number
      if (k < this.count && this.textStart[k] <= a) {
        start = this.origStart[k]
        if (this.textStart[k] < a) {
          // Keep the part of the segment before the match.
          textStart[count] = this.textStart[k] + shift
          textEnd[count] = a + shift
          origStart[count] = this.origStart[k]
          origEnd[count] = this.origEnd[k]
          count++
        }
      } else {
        start = prevOrigEnd + (a - prevTextEnd)
      }
      let last = -1
      while (k < this.count && this.textStart[k] < b) {
        last = k
        k++
      }
      let end: number
      if (last !== -1 && this.textEnd[last] > b) {
        end = this.origEnd[last]
        // Keep the part of the segment after the match for the next one.
        k = last
        this.textStart[last] = b
      } else {
        if (last !== -1) {
          prevTextEnd = this.textEnd[last]
          prevOrigEnd = this.origEnd[last]
        }
        end = prevOrigEnd + (b - prevTextEnd)
      }
      this.ranges.push({ start, end, replacement })
      textStart[count] = a + shift
      textEnd[count] = a + shift + replacement.length
      origStart[count] = start
      origEnd[count] = end
      count++
      parts.push(this.text.slice(cursor, a), replacement)
      cursor = b
      shift += replacement.length - (b - a)
    }
    for (; k < this.count; k++) {
      textStart[count] = this.textStart[k] + shift
      textEnd[count] = this.textEnd[k] + shift
      origStart[count] = this.origStart[k]
      origEnd[count] = this.origEnd[k]
      count++
    }
    if (count > capacity) throw new Error('RedactionReplay: segment capacity exceeded')
    parts.push(this.text.slice(cursor))
    this.text = parts.join('')
    this.count = count
    this.textStart = textStart
    this.textEnd = textEnd
    this.origStart = origStart
    this.origEnd = origEnd
  }
}

/**
 * Whether every code unit of each queried range lies in some range of
 * `ranges`. Ranges that overlap or touch are joined first, so a queried range
 * is covered exactly when one joined range holds it.
 */
function coverageOf(ranges: RedactionRange[]): (start: number, end: number) => boolean {
  const sorted = [...ranges].sort((x, y) => x.start - y.start)
  const starts: number[] = []
  const ends: number[] = []
  for (const range of sorted) {
    const last = ends.length - 1
    if (last >= 0 && range.start <= ends[last]) {
      if (range.end > ends[last]) ends[last] = range.end
    } else {
      starts.push(range.start)
      ends.push(range.end)
    }
  }
  return (start, end) => {
    // The last joined range that starts at or before `start`.
    let low = 0
    let high = starts.length - 1
    let found = -1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (starts[middle] <= start) {
        found = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return found !== -1 && ends[found] >= end
  }
}

// JSON punctuation and whitespace: the bytes outside a string that the in-place
// redaction keeps. Every other byte outside a string belongs to a number or a
// literal.
function isJsonStructural(code: number): boolean {
  return (
    code === 0x22 || // "
    code === 0x7b || // {
    code === 0x7d || // }
    code === 0x5b || // [
    code === 0x5d || // ]
    code === 0x3a || // :
    code === 0x2c || // ,
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d
  )
}

/**
 * For every code unit outside JSON punctuation and whitespace, the bounds of
 * the run of such code units holding it. Outside strings, that run is one
 * number or literal, bounded by punctuation, whitespace or the text's ends.
 */
function scalarBounds(text: string): { start: Int32Array; end: Int32Array } {
  const start = new Int32Array(text.length)
  const end = new Int32Array(text.length)
  let i = 0
  while (i < text.length) {
    if (isJsonStructural(text.charCodeAt(i))) {
      i++
      continue
    }
    let j = i + 1
    while (j < text.length && !isJsonStructural(text.charCodeAt(j))) j++
    start.fill(i, i, j)
    end.fill(j, i, j)
    i = j
  }
  return { start, end }
}

function patternMatches(text: string, pattern: RegExp): Array<[number, number]> {
  const matches: Array<[number, number]> = []
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) {
      throw new Error(`redaction pattern ${pattern} matched an empty string`)
    }
    matches.push([match.index, match.index + match[0].length])
  }
  return matches
}

type MatchFinder = (text: string) => Array<[number, number]>

/**
 * Each password label with its value, which runs to the next whitespace, `,`
 * or `;` and must be at least 8 code units long; values that overlap are
 * joined. Unlike one global regex, a label inside an earlier label's value
 * still starts a value of its own (`pwd :abcdefghpasswd =pwd=Ab3x`).
 */
function passwordValueMatches(text: string): Array<[number, number]> {
  const matches: Array<[number, number]> = []
  const separatorPattern = /[\s,;]/g
  let separator = 0
  for (const label of text.matchAll(/(?:password|passwd|pwd)\s*[:=]\s*/gi)) {
    const valueStart = label.index + label[0].length
    // Value starts only grow, so a separator found for an earlier value is
    // still the next one when it is not before this value's start.
    if (separator < valueStart) {
      separatorPattern.lastIndex = valueStart
      separator = separatorPattern.exec(text)?.index ?? text.length
    }
    if (separator - valueStart < 8) continue
    const last = matches[matches.length - 1]
    if (last && label.index < last[1]) last[1] = separator
    else matches.push([label.index, separator])
  }
  return matches
}

// Private key armor (#1034): PEM `-----BEGIN <label>PRIVATE KEY-----` and PGP
// `-----BEGIN PGP PRIVATE KEY BLOCK-----`. Labels are bounded so a label
// millions of characters long cannot overflow the regex engine's stack.
const PRIVATE_KEY_HEADER_SOURCE = '-----BEGIN ((?:[A-Z0-9]{1,16} ){0,4})PRIVATE KEY( BLOCK)?-----'
const PRIVATE_KEY_FOOTER_SOURCE = '-----END ((?:[A-Z0-9]{1,16} ){0,4})PRIVATE KEY( BLOCK)?-----'

/** The longest text a header or footer can span, in UTF-16 code units. */
const PRIVATE_KEY_MARKER_MAX = 101

type PrivateKeyMarker = { start: number; end: number; pgp: boolean }

/**
 * Every header or footer in `text`, ascending. `BLOCK` is PGP's alone. Each
 * call builds its own regex, so no `lastIndex` survives between calls.
 */
function privateKeyMarkers(text: string, source: string): PrivateKeyMarker[] {
  const markers: PrivateKeyMarker[] = []
  for (const match of text.matchAll(new RegExp(source, 'g'))) {
    const pgp = match[1] === 'PGP '
    if (match[2] !== undefined && !pgp) continue
    markers.push({ start: match.index, end: match.index + match[0].length, pgp })
  }
  return markers
}

// Armor alphabet, read one code unit at a time so no regex runs per line (a
// regex over one 10M-character line overflows the stack):
// - B, base64: `A-Z a-z 0-9 + / =`, and `\/` as JSON escapes it;
// - H, blank: space, tab and the JSON escape `\t`;
// - S, line separator: `\r\n`, `\n`, `\r` and their JSON escapes.
// Base64 holds no `\`, so an `n`, `r` or `t` after a `\` is always an escape.
function isBase64(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47 ||
    code === 61
  )
}

/** Code units of the base64 character at `i`, or 0. */
function base64At(text: string, i: number): number {
  const code = text.charCodeAt(i)
  if (isBase64(code)) return 1
  return code === 92 && text.charCodeAt(i + 1) === 47 ? 2 : 0
}

/** Code units of the blank at `i`, or 0. */
function blankAt(text: string, i: number): number {
  const code = text.charCodeAt(i)
  if (code === 32 || code === 9) return 1
  return code === 92 && text.charCodeAt(i + 1) === 116 ? 2 : 0
}

/** Code units of the line separator at `i`, or 0. */
function separatorAt(text: string, i: number): number {
  const code = text.charCodeAt(i)
  if (code === 13) return text.charCodeAt(i + 1) === 10 ? 2 : 1
  if (code === 10) return 1
  if (code !== 92) return 0
  const next = text.charCodeAt(i + 1)
  if (next === 110) return 2
  if (next !== 114) return 0
  return text.charCodeAt(i + 2) === 92 && text.charCodeAt(i + 3) === 110 ? 4 : 2
}

/** Code units of the line separator that ends just before `i`, or 0. */
function separatorBefore(text: string, i: number): number {
  const code = text.charCodeAt(i - 1)
  if (code === 10) return text.charCodeAt(i - 2) === 13 ? 2 : 1
  if (code === 13) return 1
  if (text.charCodeAt(i - 2) !== 92) return 0
  if (code === 114) return 2
  if (code !== 110) return 0
  return text.charCodeAt(i - 3) === 114 && text.charCodeAt(i - 4) === 92 ? 4 : 2
}

function skipBlanks(text: string, i: number): number {
  for (let n = blankAt(text, i); n > 0; n = blankAt(text, i)) i += n
  return i
}

function skipBlanksBefore(text: string, i: number): number {
  while (i > 0) {
    const code = text.charCodeAt(i - 1)
    if (code === 32 || code === 9) i--
    else if (code === 116 && text.charCodeAt(i - 2) === 92) i -= 2
    else break
  }
  return i
}

/** Up to two separators from `i`, blanks allowed between them. */
function separatorsFrom(text: string, i: number): { count: number; end: number } {
  const first = separatorAt(text, i)
  if (first === 0) return { count: 0, end: i }
  i += first
  const blank = skipBlanks(text, i)
  const second = separatorAt(text, blank)
  return second === 0 ? { count: 1, end: i } : { count: 2, end: blank + second }
}

/** Up to two separators ending just before `i`, blanks allowed between them. */
function separatorsBefore(text: string, i: number): { count: number; start: number } {
  const last = separatorBefore(text, i)
  if (last === 0) return { count: 0, start: i }
  i -= last
  const blank = skipBlanksBefore(text, i)
  const first = separatorBefore(text, blank)
  return first === 0 ? { count: 1, start: i } : { count: 2, start: blank - first }
}

/**
 * The armor line that starts at `i`: blanks, base64, blanks.
 * - `armed`: the base64 ends the line (a separator or the end of the text
 *   follows); `footerEnd` is set when a footer follows on the same line;
 * - `glued`: the base64 runs straight into another character (`AAAA"`,
 *   `AAAA</pre>`, `AAAA-----END …`), which ends the body there;
 * - `prose`: blanks follow the base64, then something else (`Hello world`).
 * `length` counts characters, so `\/` is one.
 */
type ArmorLine = {
  kind: 'armed' | 'glued' | 'prose'
  start: number
  end: number
  after: number
  length: number
  footerEnd?: number
}

function armorLineAt(text: string, i: number, footerEnds: Map<number, number>): ArmorLine | null {
  const start = skipBlanks(text, i)
  let end = start
  let length = 0
  for (let n = base64At(text, end); n > 0; n = base64At(text, end)) {
    end += n
    length++
  }
  if (length === 0) return null
  const after = skipBlanks(text, end)
  const line = { start, end, after, length }
  if (after === text.length || separatorAt(text, after) > 0) return { kind: 'armed', ...line }
  if (after > end) {
    const footerEnd = footerEnds.get(after)
    return footerEnd === undefined
      ? { kind: 'prose', ...line }
      : { kind: 'armed', footerEnd, ...line }
  }
  return { kind: 'glued', ...line }
}

/**
 * The armor line that ends at `i` (before it: blanks, base64, blanks), as
 * `armorLineAt` classifies it read backwards: `armed` when the line starts
 * the text or follows a separator, `glued` when the base64 follows another
 * character directly (`"k":"AAAA`, `keep this,AAAA`), `prose` otherwise.
 * `lineStart` is where the line begins, blanks included.
 */
function armorLineBefore(
  text: string,
  i: number
): { kind: 'armed' | 'glued' | 'prose'; start: number; lineStart: number; length: number } | null {
  let start = skipBlanksBefore(text, i)
  let length = 0
  while (start > 0) {
    const code = text.charCodeAt(start - 1)
    const escaped = text.charCodeAt(start - 2) === 92
    if (escaped && (code === 110 || code === 114 || code === 116)) break
    if (escaped && code === 47) start -= 2
    else if (isBase64(code)) start--
    else break
    length++
  }
  if (length === 0) return null
  const lineStart = skipBlanksBefore(text, start)
  const kind =
    lineStart === 0 || separatorBefore(text, lineStart) > 0
      ? 'armed'
      : lineStart === start
        ? 'glued'
        : 'prose'
  return { kind, start, lineStart, length }
}

/** A PGP checksum line, `=` and four base64 characters. */
function isChecksum(text: string, start: number, length: number): boolean {
  return length === 5 && text.charCodeAt(start) === 61
}

/**
 * Where the metadata line at `i` ends (`Proc-Type: …`, `DEK-Info: …`, and any
 * `Name: value` armor header in PGP), or -1 when the line is not metadata.
 * The value ends at a separator, at a marker, at the end of the text, or at an
 * unescaped `"` that closes a JSON string (blanks, then `,` `}` `]` `:` or the
 * end), so it cannot run across JSON fields. `next` is where the following
 * line starts, or -1 when the value did not end at a separator.
 */
function metadataLineAt(
  text: string,
  i: number,
  pgp: boolean,
  markerStarts: Set<number>
): { end: number; next: number } | null {
  let colon = i
  if (text.startsWith('Proc-Type:', i)) colon = i + 9
  else if (text.startsWith('DEK-Info:', i)) colon = i + 8
  else if (pgp) {
    const first = text.charCodeAt(i)
    if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return null
    colon = i + 1
    for (;;) {
      const code = text.charCodeAt(colon)
      if (code === 45 || isBase64(code)) {
        if (code === 43 || code === 47 || code === 61) return null
        colon++
      } else break
    }
    if (text.charCodeAt(colon) !== 58) return null
  } else return null
  let j = colon + 1
  while (j < text.length) {
    const separator = separatorAt(text, j)
    if (separator > 0) return { end: j, next: j + separator }
    if (markerStarts.has(j)) return { end: j, next: -1 }
    const code = text.charCodeAt(j)
    if (code === 92) {
      j += 2
      continue
    }
    if (code === 34) {
      const k = skipBlanks(text, j + 1)
      const closing = text.charCodeAt(k)
      if (
        k === text.length ||
        closing === 44 ||
        closing === 125 ||
        closing === 93 ||
        closing === 58
      )
        return { end: j, next: -1 }
    }
    j++
  }
  return { end: text.length, next: -1 }
}

/**
 * Where the key that starts with a header ending at `headerEnd` ends.
 *
 * The body runs while its lines keep the length `L` of the first one; the
 * first shorter line is the last line and is included. So a truncated key
 * without a footer takes at most one more line after a full-length one: a
 * line of base64 alone whose length is `L` cannot be told apart from the body.
 * A checksum line and a footer of any label may follow.
 */
function privateKeyEndAfter(
  text: string,
  headerEnd: number,
  pgp: boolean,
  footerEnds: Map<number, number>,
  markerStarts: Set<number>
): number {
  let end = headerEnd
  let i = skipBlanks(text, headerEnd)
  const footerEnd = footerEnds.get(i)
  if (footerEnd !== undefined) return footerEnd
  if (base64At(text, i) > 0) return flattenedKeyEnd(text, i, footerEnds)
  const separator = separatorAt(text, i)
  if (separator === 0) return end
  i += separator
  for (;;) {
    const metadata = metadataLineAt(text, i, pgp, markerStarts)
    if (!metadata) break
    end = metadata.end
    if (metadata.next < 0) return end
    i = metadata.next
  }
  const blank = skipBlanks(text, i)
  const blankLine = separatorAt(text, blank)
  if (blankLine > 0) i = blank + blankLine

  let bodyLength = -1
  let unit = -1
  let lastAfter = -1
  for (;;) {
    const line = armorLineAt(text, i, footerEnds)
    if (!line || line.kind === 'prose') break
    if (line.kind === 'glued') return footerEnds.get(line.end) ?? line.end
    if (bodyLength < 0) bodyLength = line.length
    else if (line.length > bodyLength) break
    end = line.end
    if (line.footerEnd !== undefined) return line.footerEnd
    lastAfter = line.after
    if (line.length < bodyLength) break
    const separators = separatorsFrom(text, line.after)
    if (separators.count === 0) return end
    if (unit < 0) unit = separators.count
    else if (separators.count !== unit) break
    i = separators.end
  }
  if (lastAfter < 0) return footerEnds.get(skipBlanks(text, i)) ?? end

  let separators = separatorsFrom(text, lastAfter)
  if (separators.count === 0) return end
  const checksum = armorLineAt(text, separators.end, footerEnds)
  if (checksum?.kind === 'armed' && isChecksum(text, checksum.start, checksum.length)) {
    end = checksum.end
    if (checksum.footerEnd !== undefined) return checksum.footerEnd
    separators = separatorsFrom(text, checksum.after)
    if (separators.count === 0) return end
  }
  return footerEnds.get(skipBlanks(text, separators.end)) ?? end
}

/**
 * A key flattened onto the header's own line (`echo $KEY`, or no separator
 * at all): base64 words separated by blanks, with the same length rule as
 * lines, never crossing a line separator.
 */
function flattenedKeyEnd(text: string, i: number, footerEnds: Map<number, number>): number {
  let end = i
  let wordLength = -1
  for (;;) {
    let wordEnd = i
    let length = 0
    for (let n = base64At(text, wordEnd); n > 0; n = base64At(text, wordEnd)) {
      wordEnd += n
      length++
    }
    if (wordLength < 0) wordLength = length
    else if (length > wordLength) return end
    end = wordEnd
    const glued = footerEnds.get(wordEnd)
    if (glued !== undefined) return glued
    const next = skipBlanks(text, wordEnd)
    const footerEnd = footerEnds.get(next)
    if (next > wordEnd && footerEnd !== undefined) return footerEnd
    if (length < wordLength || next === wordEnd || base64At(text, next) === 0) return end
    i = next
  }
}

/**
 * Where the key that ends with a footer starting at `footerStart` begins,
 * for a footer no header reached (a tail page, `--tail`, a file that starts
 * mid-key). Read backwards: an optional checksum line, the last body line at
 * any length, then lines of the length `L` of the line before the last one.
 * A line that breaks the rule adds only its base64 suffix glued to another
 * character; a shorter line is taken only where the text starts.
 */
function privateKeyStartBefore(text: string, footerStart: number): number {
  let start = footerStart
  // The last line shares the footer's line, or ends at the separator before it.
  let line = armorLineBefore(text, footerStart)
  if (!line) {
    const separators = separatorsBefore(text, skipBlanksBefore(text, footerStart))
    if (separators.count === 0) return start
    line = armorLineBefore(text, separators.start)
  }
  if (line?.kind === 'armed' && isChecksum(text, line.start, line.length)) {
    start = line.start
    const separators = separatorsBefore(text, line.lineStart)
    if (separators.count === 0) return start
    line = armorLineBefore(text, separators.start)
  }
  if (!line || line.kind === 'prose') return start
  start = line.start
  if (line.kind === 'glued') return start

  let separators = separatorsBefore(text, line.lineStart)
  if (separators.count === 0) return start
  const unit = separators.count
  line = armorLineBefore(text, separators.start)
  if (!line || line.kind === 'prose') return start
  start = line.start
  if (line.kind === 'glued') return start
  const bodyLength = line.length
  for (;;) {
    separators = separatorsBefore(text, line.lineStart)
    if (separators.count !== unit) return start
    line = armorLineBefore(text, separators.start)
    if (!line || line.kind === 'prose') return start
    if (line.kind === 'glued') return line.start
    if (line.length !== bodyLength) {
      return line.length < bodyLength && line.lineStart === 0 ? line.start : start
    }
    start = line.start
  }
}

/**
 * Each private key block: from every header forward (`privateKeyEndAfter`),
 * then from every footer no such block covers backward
 * (`privateKeyStartBefore`); blocks that overlap or touch are joined. Every
 * scan stops at the first character outside the armor, so scans in one
 * direction never overlap and the cost is linear in the text.
 */
function privateKeyMatches(text: string): Array<[number, number]> {
  const headers = privateKeyMarkers(text, PRIVATE_KEY_HEADER_SOURCE)
  const footers = privateKeyMarkers(text, PRIVATE_KEY_FOOTER_SOURCE)
  if (headers.length === 0 && footers.length === 0) return []
  const footerEnds = new Map(footers.map(footer => [footer.start, footer.end]))
  const markerStarts = new Set([...headers, ...footers].map(marker => marker.start))

  const blocks: Array<[number, number]> = []
  for (const header of headers) {
    const last = blocks[blocks.length - 1]
    if (last && header.start < last[1]) continue
    blocks.push([
      header.start,
      privateKeyEndAfter(text, header.end, header.pgp, footerEnds, markerStarts),
    ])
  }
  let covering = 0
  const forward = blocks.length
  for (const footer of footers) {
    while (covering < forward && blocks[covering][1] <= footer.start) covering++
    if (covering < forward && blocks[covering][0] <= footer.start) continue
    blocks.push([privateKeyStartBefore(text, footer.start), footer.end])
  }

  blocks.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [start, end] of blocks) {
    if (end <= start) throw new Error('private key redaction produced an empty range')
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/**
 * Whether a stream holds an open private key block, for previews of output
 * that arrives in chunks of any size. It keeps the last
 * `PRIVATE_KEY_MARKER_MAX` code units of everything seen, so a header or
 * footer split across any number of chunks is still found whole.
 */
export function createPrivateKeyBlockTracker(): {
  observe(chunk: string): void
  /** True while a block is open and `snapshot` no longer shows its header. */
  hidesPreview(snapshot: string): boolean
} {
  let tail = ''
  let open = false
  return {
    observe(chunk) {
      if (chunk.length === 0) return
      const window = tail + chunk
      let lastStart = -1
      for (const [source, opens] of [
        [PRIVATE_KEY_HEADER_SOURCE, true],
        [PRIVATE_KEY_FOOTER_SOURCE, false],
      ] as const) {
        for (const marker of privateKeyMarkers(window, source)) {
          // A marker that ends inside the tail was seen with an earlier chunk.
          if (marker.end > tail.length && marker.start > lastStart) {
            lastStart = marker.start
            open = opens
          }
        }
      }
      tail = window.slice(-PRIVATE_KEY_MARKER_MAX)
    },
    hidesPreview(snapshot) {
      return open && privateKeyMarkers(snapshot, PRIVATE_KEY_HEADER_SOURCE).length === 0
    },
  }
}

// The same non-overlapping, left-to-right occurrences `split` finds.
function literalMatches(text: string, form: string): Array<[number, number]> {
  const matches: Array<[number, number]> = []
  let at = text.indexOf(form)
  while (at !== -1) {
    matches.push([at, at + form.length])
    at = text.indexOf(form, at + form.length)
  }
  return matches
}

/**
 * Replaces each range of `content`. Ranges that overlap are joined into one,
 * replaced by `[REDACTED]` when their replacements differ; ranges that only
 * touch stay separate.
 */
function applyRedactionRanges(
  content: string,
  ranges: RedactionRange[],
  mixedReplacement: string
): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end)
  const parts: string[] = []
  let cursor = 0
  let current: RedactionRange | undefined
  for (const range of sorted) {
    if (current && range.start < current.end) {
      if (range.end > current.end) current.end = range.end
      if (range.replacement !== current.replacement) current.replacement = mixedReplacement
      continue
    }
    if (current) {
      parts.push(content.slice(cursor, current.start), current.replacement)
      cursor = current.end
    }
    current = { ...range }
  }
  if (current) {
    parts.push(content.slice(cursor, current.start), current.replacement)
    cursor = current.end
  }
  parts.push(content.slice(cursor))
  return parts.join('')
}

export class BasicSafety implements Safety {
  /**
   * Optional callback that returns ConfigStore-managed secret values. When
   * present, `sanitizeOutput` and `sanitizeAssistantResponse` will replace
   * any occurrence of those values in their input with `[REDACTED:<KEY>]`.
   *
   * This is defense-in-depth on top of the regex-based SECRET_PATTERNS:
   * regexes only catch well-known credential shapes; this catches values
   * an operator explicitly told us to treat as secret, regardless of shape.
   */
  constructor(private readonly secretEntriesProvider?: SecretEntriesProvider) {}

  // Cache patterns as static class constants
  private static readonly INJECTION_PATTERNS: RegExp[] = [
    /<\/?system>/gi,
    /<\/?assistant>/gi,
    /\[INST\]/gi,
    /\[\/INST\]/gi,
    /<<SYS>>/gi,
    /<<\/SYS>>/gi,
  ]

  // Each entry is one rule.
  private static readonly SECRET_PATTERNS: Array<RegExp | MatchFinder> = [
    /(?:sk|pk|api)[_-](?:live|test|prod)[_-][a-zA-Z0-9]{16,}/g,
    /(?:ghp|gho|ghs|ghr)_[a-zA-Z0-9]{36,}/g,
    /(?:xox[bprs])-[a-zA-Z0-9-]+/g,
    /Bearer\s+[a-zA-Z0-9._~+\/=-]{20,}/gi,
    // Whole private key blocks: header, metadata, body, checksum and footer,
    // also when the header or the footer is missing.
    privateKeyMatches,
    // Password values, from every password label to the next separator, so
    // a value that itself holds another label (a `pwd` label inside a
    // `password` value) is covered whole.
    passwordValueMatches,
    // AWS access keys
    /AKIA[0-9A-Z]{16}/g,
    // Slack webhook URLs
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]+/g,
  ]

  private static readonly INJECTION_REPLACEMENT = '[filtered]'
  private static readonly SECRET_REPLACEMENT = '[REDACTED]'

  private static readonly ASSISTANT_RESPONSE_FILTER_PATTERNS: Array<{
    pattern: RegExp
    replacement: string
    warning: string
  }> = [
    {
      // A closed tag is removed whole. An unclosed one loses only `<tool_output`,
      // because this replacement removes text and the prose after it must stay.
      // `[^<>]*` keeps the scan linear (see TOOL_OUTPUT_TAG_PATTERN).
      pattern: /<(?:\s*\/)?\s*tool_output\b(?:[^<>]*>)?/gi,
      replacement: '[filtered]',
      warning: 'Potential tool_output tag filtered from assistant response',
    },
  ]

  private static readonly HTTP_BLOCKED_HOST_PATTERNS: Array<{
    pattern: RegExp
    reason: string
  }> = [
    {
      pattern: /^localhost$/i,
      reason: 'localhost targets are not allowed',
    },
    {
      pattern: /^kubernetes\.default(?:\.svc(?:\.cluster\.local)?)?$/i,
      reason: 'Kubernetes API service targets are not allowed',
    },
    {
      pattern: /\.svc(?:\.cluster\.local)?$/i,
      reason: 'cluster service domains are not allowed',
    },
    {
      pattern: /\.cluster\.local$/i,
      reason: 'cluster-local domains are not allowed',
    },
    {
      pattern: /^metadata\.google\.internal$/i,
      reason: 'cloud metadata endpoints are not allowed',
    },
  ]

  private static readonly SHELL_BLOCKED_PATTERNS: Array<{
    pattern: RegExp
    reason: string
  }> = [
    {
      pattern: /\/var\/run\/secrets\/kubernetes\.io\/serviceaccount/i,
      reason: 'service account token paths are blocked',
    },
    {
      pattern: /\/proc\/self\/environ/i,
      reason: 'process environment dumps are blocked',
    },
    {
      pattern: /169\.254\.169\.254/i,
      reason: 'cloud metadata endpoints are blocked',
    },
    {
      pattern: /\bkubernetes\.default(?:\.svc(?:\.cluster\.local)?)?\b/i,
      reason: 'Kubernetes API service targets are blocked',
    },
    {
      pattern: /\b[a-z0-9.-]+\.svc(?:\.cluster\.local)?\b/i,
      reason: 'cluster service domains are blocked',
    },
    {
      pattern: /\bmetadata\.google\.internal\b/i,
      reason: 'cloud metadata endpoints are blocked',
    },
  ]

  /**
   * Checkpoint 1: Validate user input before LLM sees it.
   */
  validateInput(input: string): ValidationResult {
    const errors: string[] = []

    if (!input || input.trim().length === 0) {
      errors.push('Empty input')
    }
    if (input.length > 50000) {
      errors.push('Input exceeds maximum length (50,000 characters)')
    }

    const valid = errors.length === 0
    logger.info(
      { component: 'Safety', length: input?.length ?? 0, passed: valid },
      'Input validated'
    )
    return { is_valid: valid, errors }
  }

  /**
   * Checkpoint 2: Validate tool parameters before execution.
   *
   * Basic implementation: passthrough. MCP servers handle their
   * own parameter validation via JSON Schema.
   * Future: add custom rules per tool.
   */
  validateToolParams(toolName: string, params: Record<string, unknown>): ValidationResult {
    if (toolName === 'http_request') {
      return this.validateHttpRequestParams(params)
    }

    if (toolName === 'shell_exec') {
      return this.validateShellExecParams(params)
    }

    return { is_valid: true, errors: [] }
  }

  private validateHttpRequestParams(params: Record<string, unknown>): ValidationResult {
    const errors: string[] = []
    const rawUrl = params.url

    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
      return {
        is_valid: false,
        errors: ['http_request.url must be a non-empty string'],
      }
    }

    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return { is_valid: false, errors: ['http_request.url must be a valid URL'] }
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      errors.push(`Protocol "${url.protocol}" is not allowed`)
    }

    const hostname = url.hostname.trim().toLowerCase()
    if (!hostname) {
      errors.push('URL hostname is required')
    }

    if (hostname && isPrivateIp(hostname)) {
      errors.push(`Non-public target "${hostname}" is blocked`)
    }

    for (const rule of BasicSafety.HTTP_BLOCKED_HOST_PATTERNS) {
      if (rule.pattern.test(hostname)) {
        errors.push(rule.reason)
      }
    }

    return { is_valid: errors.length === 0, errors }
  }

  private validateShellExecParams(params: Record<string, unknown>): ValidationResult {
    const command = params.command
    if (typeof command !== 'string' || command.trim().length === 0) {
      return {
        is_valid: false,
        errors: ['shell_exec.command must be a non-empty string'],
      }
    }

    const errors = BasicSafety.SHELL_BLOCKED_PATTERNS.filter(rule =>
      rule.pattern.test(command)
    ).map(rule => rule.reason)

    return { is_valid: errors.length === 0, errors }
  }

  /**
   * Checkpoint 3: Sanitize tool output after execution.
   *
   * Strips potential prompt injection patterns that could
   * cause the LLM to deviate from its instructions.
   */
  sanitizeOutput(toolName: string, output: string): SanitizedOutput {
    const result = this.sanitizeToolOutputContent(toolName, output)
    logger.info(
      {
        component: 'Safety',
        toolName,
        sanitized: result.was_modified,
        warningCount: result.warnings.length,
      },
      'Tool output sanitized'
    )
    return result
  }

  sanitizeAssistantResponse(response: string): SanitizedOutput {
    const result = this.sanitizeFreeformContent(response, {
      secretWarning: 'Potential secret detected in assistant response',
      extraFilters: BasicSafety.ASSISTANT_RESPONSE_FILTER_PATTERNS,
    })
    logger.info(
      { component: 'Safety', sanitized: result.was_modified, warningCount: result.warnings.length },
      'Assistant response sanitized'
    )
    return result
  }

  /**
   * Checkpoint 4: Wrap tool output for LLM context.
   *
   * Risk 4.10: Escape closing tags in content to prevent XML injection.
   * The LLM sees: <tool_output name="x" sanitized="true">content</tool_output>
   * If content contains </tool_output>, the LLM could interpret it as end-of-output.
   */
  wrapForLlm(toolName: string, content: string, wasSanitized: boolean): string {
    // Risk 4.10: Escape potential closing tags in content
    const wrapped = wrapToolOutput(toolName, content, wasSanitized)
    logger.info(
      { component: 'Safety', toolName, wrappedLength: wrapped.length },
      'Tool output wrapped'
    )
    return wrapped
  }

  previewOutputForLlm(toolName: string, content: string): string {
    const sanitized = this.sanitizeToolOutputContent(toolName, content)
    return wrapToolOutput(toolName, sanitized.content, sanitized.was_modified)
  }

  /**
   * Tool-output redaction that keeps JSON output parseable. The text pass
   * (`sanitizeFreeformContent`) runs over the raw text, so a match can swallow
   * JSON syntax: a password value, which runs to the next whitespace, `,` or
   * `;`, eats a closing `"}`, and a raw `\n` escape is not whitespace to it. The text-pass result is
   * returned unchanged when it did not modify the output, when it still
   * parses, or when the original output does not parse.
   *
   * Otherwise the redaction is redone in place on the original text:
   * 1. One iterative scan records the inner span of every string token, keys
   *    and values alike, with escapes still encoded.
   * 2. The ranges are the ones the text pass applies (`redactionPlan`): every
   *    rule's matches on the replayed working copy, mapped back to the
   *    original text, plus its matches on the original text itself.
   * 3. Each match is clipped to every string it covers and widened to whole
   *    escape sequences. A number or literal (`true`, `false`, `null`) the
   *    match covers in part or whole is replaced whole by the replacement as
   *    a JSON string. JSON punctuation and whitespace are kept. A match that
   *    covers neither a string nor a scalar returns the text-pass result.
   * 4. Pieces that overlap or touch inside one token are merged (`[REDACTED]`
   *    when their replacements differ) and spliced in. Every byte outside the
   *    replaced pieces stays as it was.
   * 5. If that result does not parse, the text-pass result is returned.
   * The warnings are always the text pass's.
   */
  private sanitizeToolOutputContent(toolName: string, content: string): SanitizedOutput {
    const plan = this.redactionPlan(content, {
      secretWarning: `Potential secret detected in ${toolName} output`,
    })
    const textPass = this.applyRedactionPlan(content, plan)
    if (!textPass.was_modified || parsesAsJson(textPass.content) || !parsesAsJson(content)) {
      return textPass
    }
    const { tokens, tokenOf, escapeOffset } = scanJsonStrings(content)
    let scalars: { start: Int32Array; end: Int32Array } | undefined
    const pieces: RedactionPiece[] = []
    for (const range of plan.ranges) {
      let touched = false
      let i = range.start
      while (i < range.end) {
        const token = tokenOf[i]
        if (token === -1) {
          if (isJsonStructural(content.charCodeAt(i))) {
            i++
            continue
          }
          // Outside strings, a run of non-structural bytes is one number or
          // literal. Its bounds are computed once, so many matches inside one
          // long number cost one pass over it.
          scalars ??= scalarBounds(content)
          const end = scalars.end[i]
          pieces.push({
            start: scalars.start[i],
            end,
            replacement: range.replacement,
            scalar: true,
          })
          touched = true
          i = end
          continue
        }
        const tokenEnd = tokens[token].end
        let start = i
        let end = Math.min(range.end, tokenEnd)
        start -= escapeOffset[start]
        if (end < tokenEnd && escapeOffset[end] > 0) {
          const escapeStart = end - escapeOffset[end]
          end = escapeStart + (content.charCodeAt(escapeStart + 1) === 0x75 ? 6 : 2)
        }
        pieces.push({ start, end, replacement: range.replacement, scalar: false })
        touched = true
        i = tokenEnd
      }
      if (!touched) return textPass
    }

    // A string piece ends at most at its closing quote and a scalar piece at
    // the byte before the next punctuation or whitespace; the next token starts
    // at least one code unit after either, so merging sorted pieces that
    // overlap or touch only ever joins pieces of the same token.
    pieces.sort((a, b) => a.start - b.start)
    const merged: RedactionPiece[] = []
    for (const piece of pieces) {
      const last = merged[merged.length - 1]
      if (last && piece.start <= last.end) {
        last.end = Math.max(last.end, piece.end)
        if (last.replacement !== piece.replacement) {
          last.replacement = BasicSafety.SECRET_REPLACEMENT
        }
      } else {
        merged.push({ ...piece })
      }
    }
    let redacted = ''
    let cursor = 0
    for (const piece of merged) {
      const replacement = piece.scalar ? JSON.stringify(piece.replacement) : piece.replacement
      redacted += content.slice(cursor, piece.start) + replacement
      cursor = piece.end
    }
    redacted += content.slice(cursor)
    if (!parsesAsJson(redacted)) return textPass
    return { content: redacted, was_modified: true, warnings: textPass.warnings }
  }

  /**
   * The ranges of `content` to redact and the warnings to report. Each rule
   * (injection patterns, extra filters, secret patterns, configured secret
   * forms, in that order) is matched twice:
   * - on a working copy where the earlier rules' matches are already
   *   replaced, so a rule can match across an earlier replacement
   *   (`[INST]passwd = [INST]passwd = value`); each such match is mapped back
   *   to the range of `content` it covers (`RedactionReplay`);
   * - on `content` itself, so a secret whose label or prefix an earlier
   *   rule's match swallowed is still found (`xoxb-1234-abcdBearer <token>`);
   *   a match the replay ranges already cover whole is dropped.
   * A rule's warning is reported when the replay matching finds something or
   * a match on `content` is kept.
   */
  private redactionPlan(
    content: string,
    options: {
      secretWarning: string
      extraFilters?: Array<{ pattern: RegExp; replacement: string; warning: string }>
    }
  ): { ranges: RedactionRange[]; warnings: string[] } {
    const rules: Array<{
      replacement: string
      warning: string
      find: MatchFinder[]
    }> = []
    for (const pattern of BasicSafety.INJECTION_PATTERNS) {
      rules.push({
        replacement: BasicSafety.INJECTION_REPLACEMENT,
        warning: 'Potential prompt injection pattern filtered',
        find: [text => patternMatches(text, pattern)],
      })
    }
    for (const filter of options.extraFilters ?? []) {
      rules.push({
        replacement: filter.replacement,
        warning: filter.warning,
        find: [text => patternMatches(text, filter.pattern)],
      })
    }
    for (const pattern of BasicSafety.SECRET_PATTERNS) {
      rules.push({
        replacement: BasicSafety.SECRET_REPLACEMENT,
        warning: options.secretWarning,
        find: [
          typeof pattern === 'function' ? pattern : (text: string) => patternMatches(text, pattern),
        ],
      })
    }
    for (const secret of this.configuredSecretForms()) {
      rules.push({
        replacement: `[REDACTED:${secret.name}]`,
        warning: `ConfigStore secret value redacted (${secret.name})`,
        find: secret.forms.map(form => (text: string) => literalMatches(text, form)),
      })
    }

    const replay = new RedactionReplay(content)
    const replayed: boolean[] = []
    const direct: Array<Array<[number, number]>> = []
    for (const rule of rules) {
      let found = false
      const original: Array<[number, number]> = []
      for (const find of rule.find) {
        // Until a rule replaces something, the copy is `content`, so the
        // matches on `content` are the replay's own, which it covers whole.
        const untouched = replay.ranges.length === 0
        const matches = find(replay.text)
        if (matches.length > 0) found = true
        replay.replace(matches, rule.replacement)
        if (untouched) continue
        // A loop, not `push(...)`: spreading one argument per match overflows
        // the call stack at about 120k matches.
        for (const match of find(content)) original.push(match)
      }
      replayed.push(found)
      direct.push(original)
    }

    // A match on `content` that the replay already covers adds nothing, and
    // dropping it keeps the result equal to the in-order replacement.
    const covered = coverageOf(replay.ranges)

    const ranges = [...replay.ranges]
    const warnings: string[] = []
    rules.forEach((rule, index) => {
      let found = replayed[index]
      for (const [start, end] of direct[index]) {
        if (covered(start, end)) continue
        ranges.push({ start, end, replacement: rule.replacement })
        found = true
      }
      if (found) warnings.push(rule.warning)
    })
    return { ranges, warnings }
  }

  private applyRedactionPlan(
    content: string,
    plan: { ranges: RedactionRange[]; warnings: string[] }
  ): SanitizedOutput {
    const sanitized = applyRedactionRanges(content, plan.ranges, BasicSafety.SECRET_REPLACEMENT)
    return { content: sanitized, was_modified: sanitized !== content, warnings: plan.warnings }
  }

  /**
   * The ConfigStore secret values to redact by literal match, each with every
   * form it takes in output: the plain value and, when different, its JSON
   * string encoding (a value holding `"`, `\` or a control character appears
   * escaped inside raw JSON). The encoded form, never shorter, comes first so
   * the plain pass cannot split it.
   */
  private configuredSecretForms(): Array<{ name: string; forms: string[] }> {
    const secrets: Array<{ name: string; forms: string[] }> = []
    for (const entry of this.secretEntriesProvider?.() ?? []) {
      if (!entry.value || entry.value.length < 4) continue // ignore trivially-short values
      const encoded = JSON.stringify(entry.value).slice(1, -1)
      secrets.push({
        name: entry.name,
        forms: encoded === entry.value ? [entry.value] : [encoded, entry.value],
      })
    }
    return secrets
  }

  /**
   * The ranges of `content` that `sanitizeOutput` redacts as plain text, in
   * UTF-16 indices, unsorted and possibly overlapping. A caller that emits
   * slices of a larger text computes them once over the whole text, so a
   * match does not depend on where a slice ends. Does NOT log.
   */
  toolOutputRedactionRanges(toolName: string, content: string): RedactionRange[] {
    return this.redactionPlan(content, {
      secretWarning: `Potential secret detected in ${toolName} output`,
    }).ranges
  }

  /**
   * The core redaction primitive: strip injection patterns, well-known secret
   * shapes, and operator-configured secret values by literal match. Public so
   * callers that must redact WITHOUT the per-call logging of `sanitizeOutput`
   * (e.g. the session auto-title derivation and list projection, spec 15) can
   * reuse the exact same secret list. Does NOT log — the caller decides.
   */
  sanitizeFreeformContent(
    content: string,
    options: {
      secretWarning: string
      extraFilters?: Array<{ pattern: RegExp; replacement: string; warning: string }>
    }
  ): SanitizedOutput {
    // ConfigStore-managed secret values are redacted by literal match, in
    // plain and JSON-encoded form: defense-in-depth for values that don't fit
    // the regex shapes (operator-supplied integration tokens, the LLM key,
    // etc.). Entries are traversed in provider order; ConfigStore sorts them
    // by descending length, so a longer secret containing a shorter one is
    // masked before the shorter pass would erase its anchor.
    return this.applyRedactionPlan(content, this.redactionPlan(content, options))
  }
}
