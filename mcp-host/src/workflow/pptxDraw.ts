/** What every slide renderer shares: the drawing context, colors and fitted text. */
import type PptxGenJS from 'pptxgenjs'
import { type PptxPicture } from './pptxInput'
import { type Frame } from './pptxLayout'
import { TEXT_INSET_X, TEXT_INSET_Y, fitText, lineHeightIn, truncateToLines } from './pptxText'
import { type PptxPalette } from './pptxVocabulary'

/** pptxgenjs takes bare uppercase hex. */
export function hex(c: string): string {
  return c.replace(/^#/, '').toUpperCase()
}

/**
 * The deck pptxgenjs builds. Its `charts` and `shapes` name tables exist at
 * run time (getters on the instance) but its types leave them out.
 */
export type PptxDeck = PptxGenJS & {
  readonly charts?: Partial<
    Record<'AREA' | 'BAR' | 'DOUGHNUT' | 'LINE' | 'PIE', PptxGenJS.CHART_NAME>
  >
  readonly shapes?: Partial<Record<'RECTANGLE' | 'ROUNDED_RECTANGLE', PptxGenJS.ShapeType>>
}

export interface DrawContext {
  frame: Frame
  palette: PptxPalette
  pptx: PptxDeck
  warnings: string[]
  logo?: PptxPicture
}

/** Fit `text` to `box` at one of `sizes`; if it cannot fit, shorten it at the smallest. */
export function fitOrShorten(
  text: string,
  box: { w: number; h: number },
  sizes: number[],
  what: string,
  warnings: string[],
  style: { bold?: boolean } = {}
): { text: string; size: number; height: number } {
  const fit = fitText([text], box, sizes, style)
  if (fit.fits) return { text, size: fit.size, height: fit.height }
  const size = sizes[sizes.length - 1]
  const lines = Math.max(Math.floor((box.h - TEXT_INSET_Y) / lineHeightIn(size, text)), 1)
  const short = truncateToLines(text, size, box.w - TEXT_INSET_X, lines, style.bold)
  warnings.push(`${what} is too long for its space on the slide and was shortened.`)
  return {
    text: short,
    size,
    height: fitText([short], { w: box.w, h: Infinity }, [size], style).height,
  }
}
