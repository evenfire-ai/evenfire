/**
 * Display order for right-to-left text in PDFs.
 *
 * pdfmake lays every run out left to right, and fontkit only reverses the
 * glyphs inside a single run of a right-to-left script. The order of words,
 * numbers inside Arabic text and Latin inside Hebrew text therefore has to be
 * settled before pdfmake sees the text. This is the implicit part of the
 * Unicode Bidirectional Algorithm (UAX #9): paragraph direction from the first
 * strong character, the weak rules, bracket pairs and the other neutral rules,
 * implicit levels and line reordering. Explicit embeddings and isolates are not
 * supported.
 */

export type BidiClass = 'L' | 'R' | 'AL' | 'EN' | 'AN' | 'ES' | 'ET' | 'CS' | 'NSM' | 'WS' | 'ON'

const MARK = /[\p{Mn}\p{Me}]/u
const LETTER = /[\p{L}\p{Mc}\p{Nd}\p{Nl}]/u

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([from, to]) => cp >= from && cp <= to)
}

/** Hebrew, NKo, Samaritan, Mandaic and the historic right-to-left blocks. */
const STRONG_R: ReadonlyArray<readonly [number, number]> = [
  [0x0590, 0x05ff],
  [0x07c0, 0x085f],
  [0xfb1d, 0xfb4f],
  [0x10800, 0x10fff],
  [0x1e800, 0x1edff],
  [0x200f, 0x200f],
]

/** Arabic, Syriac and Thaana, and their presentation forms. */
const STRONG_AL: ReadonlyArray<readonly [number, number]> = [
  [0x0600, 0x07bf],
  [0x0860, 0x08ff],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfefe],
  [0x1ee00, 0x1eeff],
]

const ARABIC_DIGITS: ReadonlyArray<readonly [number, number]> = [
  [0x0600, 0x0605],
  [0x0660, 0x0669],
  [0x066b, 0x066c],
  [0x08e2, 0x08e2],
]

const EUROPEAN_DIGITS: ReadonlyArray<readonly [number, number]> = [
  [0x30, 0x39],
  [0x06f0, 0x06f9],
  [0xb2, 0xb3],
  [0xb9, 0xb9],
  [0x2070, 0x2079],
  [0x2080, 0x2089],
  [0xff10, 0xff19],
]

const TERMINATORS: ReadonlyArray<readonly [number, number]> = [
  [0x23, 0x25],
  [0xa2, 0xa5],
  [0xb0, 0xb1],
  [0x066a, 0x066a],
  [0x2030, 0x2034],
  [0x20a0, 0x20cf],
  [0x2212, 0x2213],
]

const SEPARATORS = new Set([0x2c, 0x2e, 0x2f, 0x3a, 0xa0, 0x060c, 0x202f, 0x2044, 0xfe50, 0xfe52])

export function bidiClass(cp: number): BidiClass {
  const ch = String.fromCodePoint(cp)
  if (MARK.test(ch)) return 'NSM'
  if (inRanges(cp, EUROPEAN_DIGITS)) return 'EN'
  if (inRanges(cp, ARABIC_DIGITS)) return 'AN'
  if (inRanges(cp, TERMINATORS)) return 'ET'
  if (SEPARATORS.has(cp)) return 'CS'
  if (inRanges(cp, STRONG_AL)) return 'AL'
  if (inRanges(cp, STRONG_R)) return 'R'
  if (cp === 0x2b || cp === 0x2d) return 'ES'
  if (cp === 0x20 || cp === 0x09 || cp === 0x0c || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x3000)
    return 'WS'
  if (cp === 0x200e || LETTER.test(ch)) return 'L'
  return 'ON'
}

/** Whether a code point belongs to a right-to-left script, marks included. */
export function isRtlScript(cp: number): boolean {
  return inRanges(cp, STRONG_R) || inRanges(cp, STRONG_AL)
}

/** Whether `text` holds anything a right-to-left paragraph would reorder. */
export function hasRtl(text: string): boolean {
  for (const ch of text) {
    const cls = bidiClass(ch.codePointAt(0)!)
    if (cls === 'R' || cls === 'AL' || cls === 'AN') return true
  }
  return false
}

export interface BidiParagraph {
  /** 0 for a left-to-right paragraph, 1 for a right-to-left one. */
  base: 0 | 1
  levels: number[]
  /** Classes before resolution, which line reordering needs for trailing space. */
  classes: BidiClass[]
}

function strongDirection(cls: BidiClass): 'L' | 'R' | undefined {
  if (cls === 'L') return 'L'
  if (cls === 'R' || cls === 'AL') return 'R'
  return undefined
}

/** Opening brackets and their closing partners, as BD16 pairs them. */
const BRACKETS: Record<number, number> = { 0x28: 0x29, 0x5b: 0x5d, 0x7b: 0x7d }

/** BD16: positions of matched bracket pairs, ordered by their opening bracket. */
function bracketPairs(codePoints: number[], t: BidiClass[]): Array<[number, number]> {
  const open: Array<{ close: number; at: number }> = []
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < codePoints.length; i++) {
    if (t[i] !== 'ON') continue
    const cp = codePoints[i]
    if (BRACKETS[cp] !== undefined) {
      if (open.length === 63) break
      open.push({ close: BRACKETS[cp], at: i })
      continue
    }
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].close !== cp) continue
      pairs.push([open[k].at, i])
      open.length = k
      break
    }
  }
  return pairs.sort((a, b) => a[0] - b[0])
}

/** Resolve the embedding level of each code point of one paragraph. */
export function resolveParagraph(codePoints: number[]): BidiParagraph {
  const classes = codePoints.map(bidiClass)
  const n = classes.length
  const firstStrong = classes.map(strongDirection).find(Boolean)
  const base: 0 | 1 = firstStrong === 'R' ? 1 : 0
  const sos: BidiClass = base ? 'R' : 'L'
  const t = [...classes]

  // W1: a mark takes the class of the character it follows.
  for (let i = 0; i < n; i++) if (t[i] === 'NSM') t[i] = i === 0 ? sos : t[i - 1]
  // W2 and W3: digits after Arabic letters are Arabic numbers; AL is R.
  let strong: BidiClass = sos
  for (let i = 0; i < n; i++) {
    if (t[i] === 'L' || t[i] === 'R' || t[i] === 'AL') strong = t[i]
    else if (t[i] === 'EN' && strong === 'AL') t[i] = 'AN'
  }
  for (let i = 0; i < n; i++) if (t[i] === 'AL') t[i] = 'R'
  // W4: one separator between two numbers of the same kind joins them.
  for (let i = 1; i < n - 1; i++) {
    if (t[i] === 'ES' && t[i - 1] === 'EN' && t[i + 1] === 'EN') t[i] = 'EN'
    else if (t[i] === 'CS' && t[i - 1] === t[i + 1] && (t[i - 1] === 'EN' || t[i - 1] === 'AN'))
      t[i] = t[i - 1]
  }
  // W5: currency and percent signs next to a European number join it.
  for (let i = 0; i < n; i++) {
    if (t[i] !== 'ET') continue
    let end = i
    while (end < n && t[end] === 'ET') end++
    if ((i > 0 && t[i - 1] === 'EN') || (end < n && t[end] === 'EN')) {
      for (let k = i; k < end; k++) t[k] = 'EN'
    }
    i = end - 1
  }
  // W6 and W7: leftover separators are neutral; numbers after Latin text are Latin.
  for (let i = 0; i < n; i++) if (t[i] === 'ES' || t[i] === 'ET' || t[i] === 'CS') t[i] = 'ON'
  strong = sos
  for (let i = 0; i < n; i++) {
    if (t[i] === 'L' || t[i] === 'R') strong = t[i]
    else if (t[i] === 'EN' && strong === 'L') t[i] = 'L'
  }
  // N0: a bracket pair takes the direction of the text it encloses when that
  // text and the text before the pair agree, else the paragraph's. Numbers
  // count as right-to-left here and below.
  const strongSide = (cls: BidiClass): 'L' | 'R' | undefined =>
    cls === 'L' ? 'L' : cls === 'R' || cls === 'EN' || cls === 'AN' ? 'R' : undefined
  const embedding: 'L' | 'R' = base ? 'R' : 'L'
  for (const [open, close] of bracketPairs(codePoints, t)) {
    let inside: 'L' | 'R' | undefined
    for (let k = open + 1; k < close && inside !== embedding; k++)
      inside = strongSide(t[k]) ?? inside
    if (inside === undefined) continue
    let dir = inside
    if (inside !== embedding) {
      let before: 'L' | 'R' = embedding
      for (let k = open - 1; k >= 0; k--) {
        const side = strongSide(t[k])
        if (side) {
          before = side
          break
        }
      }
      dir = before === inside ? inside : embedding
    }
    t[open] = dir
    t[close] = dir
  }
  // N1 and N2: neutrals between two runs of one direction take it; the rest
  // take the paragraph's.
  const side = (cls: BidiClass): 'L' | 'R' => (cls === 'L' ? 'L' : 'R')
  for (let i = 0; i < n; i++) {
    if (t[i] !== 'WS' && t[i] !== 'ON') continue
    let end = i
    while (end < n && (t[end] === 'WS' || t[end] === 'ON')) end++
    const before = i === 0 ? side(sos) : side(t[i - 1])
    const after = end === n ? side(sos) : side(t[end])
    const dir = before === after ? before : side(sos)
    for (let k = i; k < end; k++) t[k] = dir
    i = end - 1
  }
  // I1 and I2: implicit levels.
  const levels = t.map(cls => {
    if (base === 0) return cls === 'R' ? 1 : cls === 'AN' || cls === 'EN' ? 2 : 0
    return cls === 'L' || cls === 'EN' || cls === 'AN' ? 2 : 1
  })
  return { base, levels, classes }
}

/**
 * Indices of `start..end` (exclusive) in display order, for one line of a
 * resolved paragraph. Trailing white space goes back to the paragraph level so
 * it stays at the line's end.
 */
export function visualOrder(paragraph: BidiParagraph, start: number, end: number): number[] {
  const levels = paragraph.levels.slice(start, end)
  for (let i = levels.length - 1; i >= 0 && paragraph.classes[start + i] === 'WS'; i--) {
    levels[i] = paragraph.base
  }
  const order = levels.map((_, i) => start + i)
  const highest = Math.max(0, ...levels)
  const lowestOdd = Math.min(...levels.filter(l => l % 2 === 1), highest + 1)
  for (let level = highest; level >= lowestOdd; level--) {
    for (let i = 0; i < levels.length; i++) {
      if (levels[i] < level) continue
      let j = i
      while (j < levels.length && levels[j] >= level) j++
      order.splice(i, j - i, ...order.slice(i, j).reverse())
      levels.splice(i, j - i, ...levels.slice(i, j).reverse())
      i = j
    }
  }
  return order
}

const MIRRORED: Record<string, string> = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '{': '}',
  '}': '{',
  '<': '>',
  '>': '<',
  '\u00AB': '\u00BB',
  '\u00BB': '\u00AB',
}

/** The glyph a bracket shows at a right-to-left level, which faces open the other way. */
export function mirrored(ch: string, level: number): string {
  return level % 2 === 1 ? (MIRRORED[ch] ?? ch) : ch
}
