/**
 * Which way text reads, the same in every generator: the Unicode bidi class of
 * each character (UAX #9), the direction of a paragraph, and the stretches of
 * right-to-left letters that Word and PowerPoint set as their own runs. The PDF
 * lays the text out from these classes itself (pdfBidi.ts).
 */

export type BidiClass =
  | 'L'
  | 'R'
  | 'AL'
  | 'EN'
  | 'AN'
  | 'ES'
  | 'ET'
  | 'CS'
  | 'NSM'
  | 'BN'
  | 'WS'
  | 'ON'

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
  [0x2213, 0x2213],
]

/** Plus and minus signs, U+2212 MINUS SIGN among them. */
const NUMBER_SIGNS = new Set([
  0x2b, 0x2d, 0x207a, 0x207b, 0x208a, 0x208b, 0x2212, 0xfb29, 0xfe62, 0xfe63, 0xff0b, 0xff0d,
])

/** Zero-width joiners and other characters the rules pass over (X9). */
const BOUNDARY_NEUTRALS: ReadonlyArray<readonly [number, number]> = [
  [0xad, 0xad],
  [0x180e, 0x180e],
  [0x200b, 0x200d],
  [0x2060, 0x2064],
  [0xfeff, 0xfeff],
]

const SEPARATORS = new Set([0x2c, 0x2e, 0x2f, 0x3a, 0xa0, 0x060c, 0x202f, 0x2044, 0xfe50, 0xfe52])

export function bidiClass(cp: number): BidiClass {
  const ch = String.fromCodePoint(cp)
  if (MARK.test(ch)) return 'NSM'
  if (inRanges(cp, EUROPEAN_DIGITS)) return 'EN'
  if (inRanges(cp, ARABIC_DIGITS)) return 'AN'
  if (inRanges(cp, TERMINATORS)) return 'ET'
  if (SEPARATORS.has(cp)) return 'CS'
  if (NUMBER_SIGNS.has(cp)) return 'ES'
  if (inRanges(cp, BOUNDARY_NEUTRALS)) return 'BN'
  if (inRanges(cp, STRONG_AL)) return 'AL'
  if (inRanges(cp, STRONG_R)) return 'R'
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

/** The direction a strong class sets, or undefined for a weak or neutral one. */
export function strongDirection(cls: BidiClass): 'L' | 'R' | undefined {
  if (cls === 'L') return 'L'
  if (cls === 'R' || cls === 'AL') return 'R'
  return undefined
}

/**
 * Whether a paragraph of `text` reads right to left: its first strong
 * character (UAX #9, rules P2 and P3) is right to left. Digits and punctuation
 * do not decide it, while a roman numeral or a Devanagari digit is a
 * left-to-right character that does. The left-to-right and right-to-left marks
 * are passed over, as the PDF drops them as invisible.
 */
export function isRtlText(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x200e || cp === 0x200f) continue
    const direction = strongDirection(bidiClass(cp))
    if (direction) return direction === 'R'
  }
  return false
}

const HEBREW_LETTER = /\p{Script=Hebrew}/u
const ARABIC_LETTER =
  /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u
const RTL_LETTER = new RegExp(`${HEBREW_LETTER.source}|${ARABIC_LETTER.source}`, 'u')

/**
 * A right-to-left stretch of one script: its letters with the digits, spaces
 * and punctuation between them and the marks on the last one, but not the
 * neutrals after it, which take the paragraph's direction. Hebrew and Arabic
 * stay in separate runs because Word picks the face by the run's language and
 * draws boxes for Arabic tagged as Hebrew. The marks are matched once, after
 * the repetition, so no stretch of them can be split two ways.
 */
function span(letter: RegExp): string {
  return `${letter.source}(?:[^\\p{L}]*${letter.source})*\\p{M}*`
}
const RTL_SPAN = new RegExp(`${span(HEBREW_LETTER)}|${span(ARABIC_LETTER)}`, 'gu')

/** Whether `text` holds a letter of a right-to-left script anywhere. */
export function hasRtlLetter(text: string): boolean {
  return RTL_LETTER.test(text)
}

export interface ScriptSegment {
  text: string
  rtl: boolean
}

const WORD_LETTER = /\p{L}/u

/**
 * `text` cut into left-to-right and right-to-left stretches, in logical order.
 * In a right-to-left paragraph, digits and punctuation with no letter of their
 * own join the right-to-left stretch beside them: in a left-to-right run Word
 * sets them apart from the words they belong to ("المبيعات2026", "מספר.42").
 */
export function scriptSegments(text: string, rtlParagraph = false): ScriptSegment[] {
  if (!RTL_LETTER.test(text)) return [{ text, rtl: rtlParagraph && !WORD_LETTER.test(text) }]
  const out: ScriptSegment[] = []
  let at = 0
  RTL_SPAN.lastIndex = 0
  for (let m = RTL_SPAN.exec(text); m; m = RTL_SPAN.exec(text)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), rtl: false })
    out.push({ text: m[0], rtl: true })
    at = m.index + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at), rtl: false })
  if (!rtlParagraph) return out
  const merged: Array<ScriptSegment & { neutral: boolean }> = []
  for (const segment of out) {
    const neutral = !segment.rtl && !WORD_LETTER.test(segment.text)
    const rtl = segment.rtl || neutral
    const last = merged[merged.length - 1]
    if (last && last.rtl && rtl && (neutral || last.neutral)) {
      last.text += segment.text
      last.neutral = last.neutral && neutral
    } else {
      merged.push({ text: segment.text, rtl, neutral })
    }
  }
  return merged.map(({ text: t, rtl }) => ({ text: t, rtl }))
}

/** Language tag for a right-to-left run of one script. */
export function bidiLanguage(text: string): string {
  return HEBREW_LETTER.test(text) ? 'he-IL' : 'ar-SA'
}
