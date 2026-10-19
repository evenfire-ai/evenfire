/** Text runs on a slide: language, direction and bullets. */
import type PptxGenJS from 'pptxgenjs'
import { type PptxSlide, isRecord } from './pptxInput'
import { type Box } from './pptxLayout'
import { scriptOptions } from './pptxText'
import { bidiLanguage, hasRtlLetter, isRtlText, scriptSegments } from './textDirection'

// U+2022, not U+25CF: PowerPoint sets the ambiguous-width U+25CF in the East Asian face of
// a CJK-tagged paragraph, where the dot is larger than on the Latin lines around it.
const BULLET = { code: '2022' }
export type Slide = PptxGenJS.Slide

/** The language of each slide's text of Han characters alone: the deck's. */
export const hanLanguage = new WeakMap<Slide, string>()

/** Every string in the slides, to find the deck's East Asian language from. */
export function deckText(specs: PptxSlide[]): string {
  const out: string[] = []
  const pending: unknown[] = [specs]
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) for (const item of value) pending.push(item)
    else if (isRecord(value) && !ArrayBuffer.isView(value)) pending.push(...Object.values(value))
  }
  return out.join('\n')
}

/**
 * Language and direction for a run of `text` on `slide`. A right-to-left
 * paragraph is right-aligned unless it was centred.
 */
export function runOptions(slide: Slide, text: string, align?: unknown): Record<string, unknown> {
  const script = scriptOptions(text, hanLanguage.get(slide))
  const out: Record<string, unknown> = {}
  if (script.lang) out.lang = script.lang
  if (script.rtlMode) {
    out.rtlMode = true
    if (!align || align === 'left') out.align = 'right'
  }
  return out
}

/**
 * Arabic-script text. It is never set italic: PowerPoint takes an italic Arabic
 * run from Arial Italic, which has no Arabic glyphs, and prints unrelated Latin
 * letters. Letter spacing pulls its joined letters apart, so the section
 * eyebrow leaves it unspaced.
 */
export const ARABIC_SCRIPT = /\p{Script=Arabic}/u

type TextRun = { text: string; options: Record<string, unknown> }

/**
 * `text` as runs of one direction each, tagged with their own language:
 * PowerPoint orders a run by its language, so Latin words in a run tagged
 * Arabic print in reverse. `paragraph` (alignment, direction) goes on every
 * run, since pptxgenjs starts a new paragraph where the alignment changes.
 */
export function directionRuns(text: string, paragraph: Record<string, unknown>): TextRun[] {
  return scriptSegments(text, isRtlText(text)).map(segment => ({
    text: segment.text,
    options: { ...paragraph, lang: segment.rtl ? bidiLanguage(segment.text) : 'en-US' },
  }))
}

/** Paragraph options without the language, which directionRuns sets per run. */
export function paragraphOptions(
  slide: Slide,
  text: string,
  align?: unknown
): Record<string, unknown> {
  const { lang: _lang, ...paragraph } = runOptions(slide, text, align)
  return align && !paragraph.align ? { align, ...paragraph } : paragraph
}

export function addText(
  slide: Slide,
  text: string,
  box: Box,
  options: Record<string, unknown>
): void {
  const upright = ARABIC_SCRIPT.test(text) ? { italic: false } : {}
  if (!hasRtlLetter(text)) {
    slide.addText(text, {
      ...box,
      ...options,
      ...upright,
      ...runOptions(slide, text, options.align),
    })
    return
  }
  const paragraph = paragraphOptions(slide, text, options.align)
  slide.addText(directionRuns(text, paragraph), { ...box, ...options, ...upright, ...paragraph })
}

/**
 * Paragraphs of a bulleted list; each carries its own language and direction.
 * A line break in an item is a soft break, so its lines stay under one bullet.
 */
export function bulletRuns(slide: Slide, items: string[]): TextRun[] {
  // breakLine keeps one paragraph per item: pptxgenjs merges consecutive runs
  // into one paragraph whenever an alignment is set, as it is for RTL items.
  return items.flatMap(text => {
    const runs = text.split('\n').flatMap((line, i) => {
      const lineRuns = hasRtlLetter(text)
        ? directionRuns(line, paragraphOptions(slide, text))
        : [{ text: line, options: runOptions(slide, text) }]
      if (i > 0) lineRuns[0].options.softBreakBefore = true
      return lineRuns
    })
    runs[0].options.bullet = BULLET
    runs[runs.length - 1].options.breakLine = true
    return runs
  })
}
