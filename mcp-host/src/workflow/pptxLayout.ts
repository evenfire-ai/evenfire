/** Slide planning: frames, title blocks and how lists and tables split across slides. */
import {
  type PptxKpi,
  type PptxSlide,
  type SlideLayout,
  type SlideOf,
  fieldPath,
} from './pptxInput'
import { type TableLayout, layoutTable } from './pptxTables'
import {
  TEXT_INSET_X,
  TEXT_INSET_Y,
  fitText,
  lineHeightIn,
  textBlockHeight,
  truncateToLines,
} from './pptxText'

/** Indent pptxgenjs gives a bulleted paragraph, in inches. */
export const BULLET_INDENT = 27 / 72
/** Space after each bullet, in points. */
export const BULLET_SPACE_AFTER = 8
const KPIS_PER_SLIDE = 8
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Frame {
  width: number
  height: number
  wide: boolean
  marginX: number
  titleY: number
  footerY: number
  /** Lowest point body content may reach. */
  bodyBottom: number
}

export function frameFor(width: number, height: number): Frame {
  const footerY = height - 0.45
  return {
    width,
    height,
    wide: width > 12,
    marginX: width <= 10 ? 0.4 : 0.5,
    titleY: 0.4,
    footerY,
    bodyBottom: footerY - 0.2,
  }
}

export interface TitleBlock {
  text: string
  size: number
  h: number
}

/** A slide title that fits in two lines (three at the smallest size) and the height it takes. */
function layoutTitle(title: string, frame: Frame, field: string, warnings: string[]): TitleBlock {
  const sizes = frame.wide ? [28, 24, 20, 18] : [22, 20, 18, 16]
  const w = frame.width - frame.marginX * 2
  let fit = fitText([title], { w, h: Infinity }, sizes, { bold: true, maxLines: 2 })
  let text = title
  if (!fit.fits) {
    const size = sizes[sizes.length - 1]
    text = truncateToLines(title, size, w - TEXT_INSET_X, 3, true)
    if (text !== title) {
      warnings.push(`${field} is too long for a slide title and was shortened.`)
    }
    fit = fitText([text], { w, h: Infinity }, [size], { bold: true })
  }
  return { text, size: fit.size, h: Math.max(0.7, fit.height) }
}

function bodyBox(frame: Frame, title: TitleBlock | undefined): Box {
  const y = title ? Math.max(1.3, frame.titleY + title.h + 0.2) : 1.3
  return {
    x: frame.marginX,
    y,
    w: frame.width - frame.marginX * 2,
    h: frame.bodyBottom - y,
  }
}

/** One slide as it will be drawn, after lists and tables are split into pages. */
interface PlanCommon {
  title?: TitleBlock
  body: Box
}

/** Layouts drawn on one slide whatever their content. */
type SingleLayout = Exclude<SlideLayout, 'title-bullets' | 'title-table' | 'kpis'>

/**
 * One slide to draw: its spec, and for a layout that runs over several slides
 * the part on this one, which it always has.
 */
export type PlannedSlide = PlanCommon &
  (
    | { spec: SlideOf<'title-bullets'>; bullets: { items: string[]; size: number } }
    | { spec: SlideOf<'title-table'>; table: { layout: TableLayout; page: number } }
    | { spec: SlideOf<'kpis'>; kpis: PptxKpi[] }
    | { spec: SlideOf<SingleLayout> }
  )

/** The plan of a slide of `layout`. */
export type PlanOf<L extends SlideLayout> = L extends SingleLayout
  ? PlanCommon & { spec: SlideOf<L> }
  : Extract<PlannedSlide, { spec: { layout: L } }>

/** Whether `planned` is a slide of `layout`, as a type guard. */
export function isPlanOf<L extends SlideLayout>(
  planned: PlannedSlide,
  layout: L
): planned is PlanOf<L> {
  return planned.spec.layout === layout
}

interface ListPlan {
  pages: string[][]
  size: number
}

/** Height of one bullet; a line break in it starts a line under the same bullet. */
function bulletHeight(item: string, size: number, width: number): number {
  return textBlockHeight([item], size, width, { paraSpaceAfter: BULLET_SPACE_AFTER })
}

/**
 * Bullets for boxes of `box`: all on one slide at the largest size that fits,
 * otherwise over the fewest slides the smallest size allows, at the largest
 * size that still needs no more slides than that.
 */
function planBullets(
  items: string[],
  box: Box,
  frame: Frame,
  where: string,
  warnings: string[]
): ListPlan {
  const sizes = frame.wide ? [18, 16, 14, 12] : [14, 13, 12, 11]
  const width = box.w - TEXT_INSET_X - BULLET_INDENT
  const room = box.h - TEXT_INSET_Y
  const paginate = (size: number) => {
    const pages: string[][] = []
    let page: string[] = []
    let used = 0
    let cut = 0
    for (let item of items) {
      let h = bulletHeight(item, size, width)
      if (h > room) {
        const lines = Math.max(
          Math.floor((room - BULLET_SPACE_AFTER / 72) / lineHeightIn(size, item)),
          1
        )
        item = truncateToLines(item, size, width, lines)
        h = bulletHeight(item, size, width)
        cut++
      }
      if (page.length > 0 && used + h > room + 1e-9) {
        pages.push(page)
        page = []
        used = 0
      }
      page.push(item)
      used += h
    }
    if (page.length > 0) pages.push(page)
    return { pages, cut }
  }
  const smallest = sizes[sizes.length - 1]
  const fewest = paginate(smallest).pages.length
  let chosen = { ...paginate(smallest), size: smallest }
  for (const size of sizes) {
    const attempt = paginate(size)
    if (attempt.pages.length <= fewest) {
      chosen = { ...attempt, size }
      break
    }
  }
  if (chosen.cut > 0) {
    warnings.push(
      `${where}: ${chosen.cut} bullet(s) were longer than a whole slide and were shortened.`
    )
  }
  return { pages: chosen.pages, size: chosen.size }
}

function pageTitle(title: string | undefined, page: number, pages: number): string | undefined {
  if (pages <= 1) return title
  return `${title ?? ''} (${page}/${pages})`.trim()
}

/**
 * Split a slide whose content needs more than one slide. Titles of the parts
 * are numbered "(1/3)", which reads the same in any language.
 */
export function planSlide(spec: PptxSlide, frame: Frame, warnings: string[]): PlannedSlide[] {
  const titled = spec.layout !== 'cover' && spec.layout !== 'section' && spec.layout !== 'quote'
  const titleFor = (text: string | undefined) =>
    titled && text ? layoutTitle(text, frame, fieldPath(spec, 'title'), warnings) : undefined

  if (spec.layout === 'title-bullets') {
    let title = titleFor(spec.title)
    let body = bodyBox(frame, title)
    let list = planBullets(spec.bullets, body, frame, fieldPath(spec, 'bullets'), [])
    if (list.pages.length > 1) {
      // The numbered title can take another line, so the split is redone under it.
      title = titleFor(pageTitle(spec.title, list.pages.length, list.pages.length))
      body = bodyBox(frame, title)
    }
    list = planBullets(spec.bullets, body, frame, fieldPath(spec, 'bullets'), warnings)
    const n = list.pages.length
    if (n > 1) {
      warnings.push(
        `${fieldPath(spec, 'bullets')}: the ${spec.bullets.length} bullets did not fit on one slide, so they ` +
          `continue on ${n - 1} more slide(s).`
      )
    }
    return list.pages.map((items, i) => ({
      spec,
      title: titleFor(pageTitle(spec.title, i + 1, n)),
      body,
      bullets: { items, size: list.size },
    }))
  }

  if (spec.layout === 'title-table') {
    let title = titleFor(spec.title)
    let body = bodyBox(frame, title)
    let layout = layoutTable(spec.table, body, frame.wide, fieldPath(spec, 'table'), [])
    if (layout.pages.length > 1) {
      title = titleFor(pageTitle(spec.title, layout.pages.length, layout.pages.length))
      body = bodyBox(frame, title)
    }
    layout = layoutTable(spec.table, body, frame.wide, fieldPath(spec, 'table'), warnings)
    const n = layout.pages.length
    return layout.pages.map((_, i) => ({
      spec,
      title: titleFor(pageTitle(spec.title, i + 1, n)),
      body,
      table: { layout, page: i },
    }))
  }

  if (spec.layout === 'kpis') {
    const n = Math.ceil(spec.kpis.length / KPIS_PER_SLIDE)
    if (n > 1) {
      warnings.push(
        `${fieldPath(spec, 'kpis')}: ${spec.kpis.length} KPI cards are more than the ${KPIS_PER_SLIDE} a ` +
          `slide holds, so they continue on ${n - 1} more slide(s).`
      )
    }
    // Spread evenly, so nine cards become five and four rather than eight and one.
    const perSlide = Math.ceil(spec.kpis.length / n)
    return Array.from({ length: n }, (_, i) => {
      const title = titleFor(pageTitle(spec.title, i + 1, n))
      return {
        spec,
        title,
        body: bodyBox(frame, title),
        kpis: spec.kpis.slice(i * perSlide, (i + 1) * perSlide),
      }
    })
  }

  const title = titleFor(spec.title)
  return [{ spec, title, body: bodyBox(frame, title) }]
}
