/**
 * Direction and script handling for the generated Word documents.
 *
 * Word lays out a paragraph right to left only when it carries w:bidi, and
 * treats neutral characters inside a run as right-to-left only when the run
 * carries w:rtl. Arabic and Hebrew letters take the complex-script font (w:cs)
 * and CJK the East Asian one, so both are named explicitly: a document that
 * names only a Latin face leaves Word to substitute, which draws boxes where
 * the substitute lacks the glyphs.
 */

/** Latin face of the body text. */
export const DOCX_LATIN_FONT = 'Calibri'

/**
 * Complex-script face for Arabic and Hebrew. Arial carries both in every
 * weight on Windows and Word for Mac; where its italic lacks Arabic, Word
 * slants the upright glyphs.
 */
export const DOCX_COMPLEX_FONT = 'Arial'

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

/** Whether `text` reads right to left: its first letter, as the bidi algorithm decides, is RTL. */
export function isRtlText(text: string): boolean {
  const first = /\p{L}/u.exec(text)?.[0]
  return first !== undefined && RTL_LETTER.test(first)
}

/** Paragraph options that set the paragraph's direction from its text. */
export function docxDirection(text: string): { bidirectional?: true } {
  return isRtlText(text) ? { bidirectional: true } : {}
}

export interface ScriptSegment {
  text: string
  rtl: boolean
}

const LETTER = /\p{L}/u

/**
 * `text` cut into left-to-right and right-to-left stretches, in logical order.
 * In a right-to-left paragraph, digits and punctuation with no letter of their
 * own join the right-to-left stretch beside them: in a left-to-right run Word
 * sets them apart from the words they belong to ("المبيعات2026", "מספר.42").
 */
export function scriptSegments(text: string, rtlParagraph = false): ScriptSegment[] {
  if (!RTL_LETTER.test(text)) return [{ text, rtl: rtlParagraph && !LETTER.test(text) }]
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
    const neutral = !segment.rtl && !LETTER.test(segment.text)
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

export interface EastAsianScript {
  font: string
  lang: string
}

// Each face ships with Windows and with Word for Mac.
const JAPANESE: EastAsianScript = { font: 'Yu Gothic', lang: 'ja-JP' }
const KOREAN: EastAsianScript = { font: 'Malgun Gothic', lang: 'ko-KR' }
const CHINESE: EastAsianScript = { font: 'Microsoft YaHei', lang: 'zh-CN' }

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/**
 * The East Asian face and language a block names for itself, chosen from the
 * whole block so Han characters in Japanese text get the Japanese face:
 * Japanese with kana, Korean with Hangul. Han characters alone may be any of
 * the three, so such a block takes the document's (documentEastAsianScript).
 */
export function eastAsianScript(text: string): EastAsianScript | undefined {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return JAPANESE
  if (/\p{Script=Hangul}/u.test(text)) return KOREAN
  return undefined
}

/**
 * The East Asian script of a whole document: that of the lines holding most of
 * its CJK characters, where a line of Han characters alone counts as Chinese.
 */
export function documentEastAsianScript(text: string): EastAsianScript | undefined {
  const counts = new Map<EastAsianScript, number>()
  for (const line of text.split('\n')) {
    const cjk = line.match(CJK_CHAR)?.length ?? 0
    if (cjk === 0) continue
    const script = eastAsianScript(line) ?? CHINESE
    counts.set(script, (counts.get(script) ?? 0) + cjk)
  }
  let best: EastAsianScript | undefined
  for (const script of [JAPANESE, KOREAN, CHINESE]) {
    if ((counts.get(script) ?? 0) > (best ? (counts.get(best) ?? 0) : 0)) best = script
  }
  return best
}
