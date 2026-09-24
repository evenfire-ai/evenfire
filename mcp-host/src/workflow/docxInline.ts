/**
 * Inline markdown, and the bits of HTML models mix into it, as Word runs.
 */
import { ExternalHyperlink, type IFontAttributesProperties, type IRunOptions, TextRun } from 'docx'
import {
  type EastAsianScript,
  bidiLanguage,
  eastAsianScript,
  isRtlText,
  scriptSegments,
} from './docxScript'
import { htmlToMarkdownInline, markdownSpans } from './inlineMarkup'

export type DocxInline = TextRun | ExternalHyperlink

export interface RunStyle {
  color?: string
  /** Half-points. */
  size?: number
  bold?: boolean
  italics?: boolean
}

/** Formatting shared by the runs of one span; the font names faces by slot. */
type RunOptions = Omit<IRunOptions, 'text' | 'children' | 'break' | 'font'> & {
  font?: IFontAttributesProperties
}

/**
 * Runs for `text`: one per line, each after the first starting on a new line,
 * and within a line one per stretch of left-to-right or right-to-left text,
 * the RTL ones marked so Word orders and shapes them as such. `rtlParagraph`
 * is the direction of the paragraph the runs go into, by default `text`'s own.
 */
export function textRuns(
  text: string,
  options: RunOptions,
  eastAsia?: EastAsianScript,
  rtlParagraph = isRtlText(text)
): TextRun[] {
  const font = eastAsia ? { ...options.font, eastAsia: eastAsia.font } : options.font
  const runs: TextRun[] = []
  text.split('\n').forEach((line, i) => {
    scriptSegments(line, rtlParagraph).forEach((segment, k) => {
      runs.push(
        new TextRun({
          ...options,
          ...(font ? { font } : {}),
          text: segment.text,
          ...(segment.rtl ? { rightToLeft: true } : {}),
          ...(segment.rtl || eastAsia
            ? {
                language: {
                  ...(segment.rtl ? { bidirectional: bidiLanguage(segment.text) } : {}),
                  ...(eastAsia ? { eastAsia: eastAsia.lang } : {}),
                },
              }
            : {}),
          ...(i > 0 && k === 0 ? { break: 1 } : {}),
        })
      )
    })
  })
  return runs
}

interface RunContext {
  warnings: string[]
  eastAsia?: EastAsianScript
  /** The paragraph reads right to left. */
  rtl: boolean
  /** Half-points; code is set a point smaller than the text around it. */
  codeSize: number
}

function appendRuns(markdown: string, base: RunOptions, ctx: RunContext, out: DocxInline[]): void {
  for (const span of markdownSpans(markdown)) {
    const style: RunOptions = {
      ...base,
      ...(span.bold ? { bold: true } : {}),
      ...(span.italics ? { italics: true } : {}),
      ...(span.strike ? { strike: true } : {}),
    }
    if (span.image !== undefined) {
      ctx.warnings.push(
        `The image '${span.image}' was inside a line of text and was left out; ` +
          'put ![alt](file.png) on a line of its own to embed it.'
      )
      if (span.text) out.push(...textRuns(span.text, style, ctx.eastAsia, ctx.rtl))
    } else if (span.link !== undefined) {
      out.push(
        new ExternalHyperlink({
          link: span.link,
          children: textRuns(
            span.text,
            { ...style, color: '1D4ED8', underline: {} },
            ctx.eastAsia,
            ctx.rtl
          ),
        })
      )
    } else if (span.code) {
      out.push(
        ...textRuns(
          span.text,
          { ...style, font: { ascii: 'Consolas', hAnsi: 'Consolas' }, size: ctx.codeSize },
          ctx.eastAsia,
          ctx.rtl
        )
      )
    } else {
      out.push(...textRuns(span.text, style, ctx.eastAsia, ctx.rtl))
    }
  }
}

/**
 * Runs for one block of inline markdown: **bold**, *italic*, ***both***,
 * ~~strike~~, `code`, [links](https://...) and backslash escapes, after inline
 * HTML is read. An image written inside a sentence cannot be placed there, so
 * its alt text stands in for it and a warning says how to embed it.
 */
export function inlineRuns(text: string, style: RunStyle, warnings: string[]): DocxInline[] {
  const size = style.size ?? 22
  const base: RunOptions = { color: style.color, size, bold: style.bold, italics: style.italics }
  const source = htmlToMarkdownInline(text)
  const runs: DocxInline[] = []
  const ctx = {
    warnings,
    eastAsia: eastAsianScript(source),
    rtl: isRtlText(source),
    codeSize: size - 2,
  }
  appendRuns(source, base, ctx, runs)
  return runs.length > 0 ? runs : [new TextRun({ text: '', color: style.color })]
}
