/**
 * Text measurement for the PPTX generator. PowerPoint neither shrinks text to
 * fit on open or export (`normAutofit` is ignored) nor carries a table onto
 * another slide, so the generator lays text out itself. It measures with the
 * Roboto faces fonts.ts registers, within a few percent of Arial, the deck font.
 */
import { type SKRSContext2D, createCanvas } from '@napi-rs/canvas'
import { CHART_FONT_FAMILY, ensureFontsReady } from './fonts'

/** The one family the deck uses, for slides and charts alike. */
export const PPTX_FONT_FACE = 'Arial'

/**
 * Arial against the bundled faces, measured on English and Spanish text:
 * regular runs up to 3% wider than Roboto, bold up to 8% wider than the Roboto
 * Medium registered as bold. Rounded up so an estimate errs toward fitting.
 */
const REGULAR_WIDTH_FACTOR = 1.05
const BOLD_WIDTH_FACTOR = 1.1

/** Single spacing, in ems. The CJK faces PowerPoint substitutes set taller lines. */
const LINE_HEIGHT = 1.2
const WIDE_LINE_HEIGHT = 1.35

/** Default text-box insets PowerPoint applies: 0.1in left and right, 0.05in top and bottom. */
export const TEXT_INSET_X = 0.2
export const TEXT_INSET_Y = 0.1

/**
 * CJK characters, counted one em wide: every CJK face sets them so, and the
 * runtime image may have no CJK face to measure them with.
 */
const WIDE_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6]/u

/** Runs of spaces, single CJK characters, and words: the points where a line may break. */
const BREAK_TOKENS = new RegExp(
  `\\s+|${WIDE_CHAR.source}|[^\\s]+?(?=\\s|${WIDE_CHAR.source}|$)`,
  'gu'
)

let context: SKRSContext2D | undefined

function canvasContext(): SKRSContext2D {
  if (!context) {
    ensureFontsReady()
    context = createCanvas(4, 4).getContext('2d')
  }
  return context
}

const widthCache = new Map<string, number>()

/** Width of `text` in ems of the deck font. */
function widthEm(text: string, bold: boolean): number {
  const key = `${bold ? 'b' : 'r'}${text}`
  const cached = widthCache.get(key)
  if (cached !== undefined) return cached
  const ctx = canvasContext()
  ctx.font = `100px "${bold ? `${CHART_FONT_FAMILY} Bold` : CHART_FONT_FAMILY}"`
  let wide = 0
  let narrow = ''
  for (const ch of text) {
    if (WIDE_CHAR.test(ch)) wide++
    else narrow += ch
  }
  const measured = narrow ? ctx.measureText(narrow).width / 100 : 0
  const em = measured * (bold ? BOLD_WIDTH_FACTOR : REGULAR_WIDTH_FACTOR) + wide
  if (widthCache.size > 20_000) widthCache.clear()
  widthCache.set(key, em)
  return em
}

export interface TextStyle {
  bold?: boolean
  /** Space after each paragraph, in points. */
  paraSpaceAfter?: number
}

/** Width of `text` set on one line, in inches. */
export function textWidth(text: string, sizePt: number, bold = false): number {
  return (widthEm(text, bold) * sizePt) / 72
}

/**
 * The lines PowerPoint breaks `text` into in a box `widthIn` wide: at spaces,
 * between CJK characters, and inside a word only when the word alone is wider
 * than the line. A line is measured as its tokens added up, which leaves out
 * the kerning between them (about 1% wider at most, so it errs toward fitting)
 * and measures each token once, so long lists take linear time.
 */
export function wrapLines(text: string, sizePt: number, widthIn: number, bold = false): string[] {
  const max = Math.max(widthIn, 0.1)
  const width = (s: string) => textWidth(s, sizePt, bold)
  const out: string[] = []
  for (const hard of text.split('\n')) {
    const tokens = hard.match(BREAK_TOKENS) ?? []
    let line = ''
    let used = 0
    for (const token of tokens) {
      const w = width(token)
      if (/^\s+$/.test(token)) {
        if (line) {
          line += token
          used += w
        }
        continue
      }
      if (used + w <= max) {
        line += token
        used += w
        continue
      }
      if (line.trim()) out.push(line.trimEnd())
      line = ''
      used = 0
      if (w <= max) {
        line = token
        used = w
        continue
      }
      for (const ch of token) {
        const c = width(ch)
        if (line && used + c > max) {
          out.push(line)
          line = ''
          used = 0
        }
        line += ch
        used += c
      }
    }
    out.push(line.trimEnd())
  }
  return out
}

export function lineHeightIn(sizePt: number, text: string): number {
  return ((WIDE_CHAR.test(text) ? WIDE_LINE_HEIGHT : LINE_HEIGHT) * sizePt) / 72
}

/** Height, in inches, of `paragraphs` set in a box `widthIn` wide, without the box insets. */
export function textBlockHeight(
  paragraphs: string[],
  sizePt: number,
  widthIn: number,
  style: TextStyle = {}
): number {
  let total = 0
  for (const p of paragraphs) {
    total += paragraphHeight(p, wrapLines(p, sizePt, widthIn, style.bold).length, sizePt, style)
  }
  return total
}

function paragraphHeight(text: string, lines: number, sizePt: number, style: TextStyle): number {
  return lines * lineHeightIn(sizePt, text) + (style.paraSpaceAfter ?? 0) / 72
}

export interface FittedText {
  size: number
  /** Height of the text including the box insets, in inches. */
  height: number
  fits: boolean
}

/**
 * The largest of `sizes` at which `paragraphs` fit a box, or the smallest size
 * with `fits: false`. `maxLines` caps the lines of each paragraph.
 */
export function fitText(
  paragraphs: string[],
  box: { w: number; h: number },
  sizes: number[],
  style: TextStyle & { maxLines?: number; indent?: number } = {}
): FittedText {
  const width = box.w - TEXT_INSET_X - (style.indent ?? 0)
  let last: FittedText = { size: sizes[sizes.length - 1], height: Infinity, fits: false }
  for (const size of sizes) {
    let height = TEXT_INSET_Y
    let lines = 0
    for (const p of paragraphs) {
      const n = wrapLines(p, size, width, style.bold).length
      height += paragraphHeight(p, n, size, style)
      lines = Math.max(lines, n)
    }
    const fits = height <= box.h + 1e-6 && (!style.maxLines || lines <= style.maxLines)
    last = { size, height, fits }
    if (fits) return last
  }
  return last
}

/**
 * `text` cut at a word so it takes at most `maxLines` lines, ending in an
 * ellipsis. Returns the text unchanged when it already fits.
 */
export function truncateToLines(
  text: string,
  sizePt: number,
  widthIn: number,
  maxLines: number,
  bold = false
): string {
  if (wrapLines(text, sizePt, widthIn, bold).length <= maxLines) return text
  const chars = Array.from(text)
  const fits = (n: number) =>
    wrapLines(`${chars.slice(0, n).join('').trimEnd()}…`, sizePt, widthIn, bold).length <= maxLines
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  let kept = chars.slice(0, lo).join('')
  const space = kept.lastIndexOf(' ')
  if (space > kept.length * 0.6) kept = kept.slice(0, space)
  return `${kept.trimEnd()}…`
}

export interface ScriptOptions {
  lang?: string
  rtlMode?: boolean
}

const RTL_SCRIPT = /[\p{Script=Arabic}\p{Script=Hebrew}]/u

/**
 * Language and direction for `text`. Untagged runs are en-US, and PowerPoint
 * then mixes CJK glyphs from several fallback fonts; without `rtl` an Arabic
 * paragraph runs left to right. Direction follows the first letter, as bidi does.
 * Han characters alone may be Chinese, Japanese or Korean, so they take `hanLang`,
 * the deck's language.
 */
export function scriptOptions(text: string, hanLang = 'zh-CN'): ScriptOptions {
  let lang: string | undefined
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) lang = 'ja-JP'
  else if (/\p{Script=Hangul}/u.test(text)) lang = 'ko-KR'
  else if (/\p{Script=Han}/u.test(text)) lang = hanLang
  else if (/\p{Script=Arabic}/u.test(text)) lang = 'ar-SA'
  else if (/\p{Script=Hebrew}/u.test(text)) lang = 'he-IL'
  const firstLetter = /\p{L}/u.exec(text)?.[0]
  const rtl = firstLetter !== undefined && RTL_SCRIPT.test(firstLetter)
  const out: ScriptOptions = {}
  if (lang) out.lang = lang
  if (rtl) out.rtlMode = true
  return out
}
