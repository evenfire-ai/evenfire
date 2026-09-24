/**
 * Builds the .pptx for clerum__generate_pptx with pptxgenjs.
 *
 * Coordinates are inches. Arguments are read by pptxInput (and pptxTemplates),
 * then every slide is laid out from measured text before anything is drawn:
 * lists and tables that do not fit continue on further slides, titles and
 * values shrink to fit their boxes, and pictures keep their proportions.
 */
import JSZip from 'jszip'
import { bidiLanguage, documentEastAsianScript, isRtlText, scriptSegments } from './docxScript'
import { fitImageSize } from './embeddedImages'
import { nativeChartArgs } from './pptxCharts'
import {
  type PptxColumn,
  PptxInputError,
  type PptxKpi,
  type PptxPicture,
  type PptxSlide,
  type ReadContext,
  fieldPath,
  isRecord,
  readPicture,
  readSlides,
  readText,
} from './pptxInput'
import { type TableLayout, layoutTable } from './pptxTables'
import { PPTX_TEMPLATES, type PptxTemplate, buildTemplateSlides } from './pptxTemplates'
import {
  PPTX_FONT_FACE,
  TEXT_INSET_X,
  TEXT_INSET_Y,
  fitText,
  lineHeightIn,
  scriptOptions,
  textBlockHeight,
  textWidth,
  truncateToLines,
  wrapLines,
} from './pptxText'

const PptxGenJS = require('pptxgenjs')

interface PptxPalette {
  primary: string
  primaryDark: string
  text: string
  muted: string
  border: string
  accent: string
  surface: string
  background: string
  statusGreen: string
  statusYellow: string
  statusRed: string
}

export const PPTX_PALETTES: Record<string, PptxPalette> = {
  default: {
    primary: '#0f172a',
    primaryDark: '#020617',
    text: '#0f172a',
    muted: '#475569',
    border: '#cbd5e1',
    accent: '#3b82f6',
    surface: '#f1f5f9',
    background: '#ffffff',
    statusGreen: '#16a34a',
    statusYellow: '#ca8a04',
    statusRed: '#dc2626',
  },
  corporate: {
    primary: '#1e3a8a',
    primaryDark: '#1e293b',
    text: '#1e293b',
    muted: '#475569',
    border: '#cbd5e1',
    accent: '#0891b2',
    surface: '#e0f2fe',
    background: '#ffffff',
    statusGreen: '#059669',
    statusYellow: '#ca8a04',
    statusRed: '#b91c1c',
  },
  warm: {
    primary: '#b45309',
    primaryDark: '#78350f',
    text: '#2f2823',
    muted: '#66584c',
    border: '#d6d2cc',
    accent: '#0d9488',
    surface: '#f7f7f5',
    background: '#fefdfb',
    statusGreen: '#65a30d',
    statusYellow: '#ca8a04',
    statusRed: '#9f1239',
  },
  alert: {
    primary: '#9f1239',
    primaryDark: '#4c0519',
    text: '#1f2937',
    muted: '#4b5563',
    border: '#fecaca',
    accent: '#dc2626',
    surface: '#fee2e2',
    background: '#ffffff',
    statusGreen: '#16a34a',
    statusYellow: '#ca8a04',
    statusRed: '#dc2626',
  },
}

/** Series colors after the palette's own, so a chart of up to ten slices does not repeat one. */
const EXTRA_SERIES_COLORS = ['#7c3aed', '#0d9488', '#ea580c', '#db2777']

export const PPTX_ASPECT_RATIOS: Record<string, { name: string; width: number; height: number }> = {
  wide: { name: 'LAYOUT_WIDE', width: 13.333, height: 7.5 },
  '16x9': { name: 'LAYOUT_16x9', width: 10, height: 5.625 },
  '16x10': { name: 'LAYOUT_16x10', width: 10, height: 6.25 },
  '4x3': { name: 'LAYOUT_4x3', width: 10, height: 7.5 },
}

/** pptxgenjs takes bare uppercase hex. */
function hex(c: string): string {
  return c.replace(/^#/, '').toUpperCase()
}

/** Indent pptxgenjs gives a bulleted paragraph, in inches. */
const BULLET_INDENT = 27 / 72
// U+2022, not U+25CF: PowerPoint sets the ambiguous-width U+25CF in the East Asian face of
// a CJK-tagged paragraph, where the dot is larger than on the Latin lines around it.
const BULLET = { code: '2022' }
/** Space after each bullet, in points. */
const BULLET_SPACE_AFTER = 8
const KPIS_PER_SLIDE = 8
/** One or two cards stretched across a wide slide leave their figures lost in the card. */
const MAX_CARD_WIDTH = 4.5

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface Frame {
  width: number
  height: number
  wide: boolean
  marginX: number
  titleY: number
  footerY: number
  /** Lowest point body content may reach. */
  bodyBottom: number
}

function frameFor(width: number, height: number): Frame {
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

interface TitleBlock {
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
interface PlannedSlide {
  spec: PptxSlide
  title?: TitleBlock
  body: Box
  bullets?: { items: string[]; size: number }
  table?: { layout: TableLayout; page: number }
  kpis?: PptxKpi[]
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
function planSlide(spec: PptxSlide, frame: Frame, warnings: string[]): PlannedSlide[] {
  const titled = spec.layout !== 'cover' && spec.layout !== 'section' && spec.layout !== 'quote'
  const titleFor = (text: string | undefined) =>
    titled && text ? layoutTitle(text, frame, fieldPath(spec, 'title'), warnings) : undefined

  if (spec.layout === 'title-bullets' && spec.bullets) {
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

  if (spec.layout === 'title-table' && spec.table) {
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

  if (spec.layout === 'kpis' && spec.kpis) {
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
        kpis: spec.kpis!.slice(i * perSlide, (i + 1) * perSlide),
      }
    })
  }

  const title = titleFor(spec.title)
  return [{ spec, title, body: bodyBox(frame, title) }]
}

type Slide = any

interface DrawContext {
  frame: Frame
  palette: PptxPalette
  pptx: any
  warnings: string[]
  logo?: PptxPicture
}

/** The language of each slide's text of Han characters alone: the deck's. */
const hanLanguage = new WeakMap<Slide, string>()

/** Every string in the slides, to find the deck's East Asian language from. */
function deckText(specs: PptxSlide[]): string {
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
function runOptions(slide: Slide, text: string, align?: unknown): Record<string, unknown> {
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
const ARABIC_SCRIPT = /\p{Script=Arabic}/u
const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}]/u

type TextRun = { text: string; options: Record<string, unknown> }

/**
 * `text` as runs of one direction each, tagged with their own language:
 * PowerPoint orders a run by its language, so Latin words in a run tagged
 * Arabic print in reverse. `paragraph` (alignment, direction) goes on every
 * run, since pptxgenjs starts a new paragraph where the alignment changes.
 */
function directionRuns(text: string, paragraph: Record<string, unknown>): TextRun[] {
  return scriptSegments(text, isRtlText(text)).map(segment => ({
    text: segment.text,
    options: { ...paragraph, lang: segment.rtl ? bidiLanguage(segment.text) : 'en-US' },
  }))
}

/** Paragraph options without the language, which directionRuns sets per run. */
function paragraphOptions(slide: Slide, text: string, align?: unknown): Record<string, unknown> {
  const { lang: _lang, ...paragraph } = runOptions(slide, text, align)
  return align && !paragraph.align ? { align, ...paragraph } : paragraph
}

function addText(slide: Slide, text: string, box: Box, options: Record<string, unknown>): void {
  const upright = ARABIC_SCRIPT.test(text) ? { italic: false } : {}
  if (!RTL_LETTER.test(text)) {
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
function bulletRuns(slide: Slide, items: string[]): TextRun[] {
  // breakLine keeps one paragraph per item: pptxgenjs merges consecutive runs
  // into one paragraph whenever an alignment is set, as it is for RTL items.
  return items.flatMap(text => {
    const runs = text.split('\n').flatMap((line, i) => {
      const lineRuns = RTL_LETTER.test(text)
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

/**
 * A picture drawn to fill its space is shown at most this much larger than its
 * pixels at 96 dpi, or it blurs.
 */
const MAX_UPSCALE = 2
const PIXELS_PER_INCH = 96

/** Where a small picture is reported, and whether its field takes a width. */
interface PictureReport {
  where: string
  sized: boolean
  warnings: string[]
}

/**
 * Box for `image` inside `area`, at the image's own proportions. Without a
 * requested size it fills the area, up to MAX_UPSCALE times its own size.
 */
function placePicture(
  picture: { image: PptxPicture['image']; width?: number; height?: number },
  area: Box,
  align: 'center' | 'top-left' = 'center',
  report?: PictureReport
): Box {
  // fitImageSize rounds to whole units; thousandths of an inch keep the ratio exact enough.
  const unit = 1000
  const { width, height, image } = picture
  let requested: { width?: number; height?: number } = {
    width: area.w * unit,
    height: area.h * unit,
  }
  if (width || height) {
    requested = { width: width && width * unit, height: height && height * unit }
  } else {
    // Sharpness depends on the pixels stored, not on the density the file declares.
    const { pixels } = image
    const most = {
      w: (pixels.width / PIXELS_PER_INCH) * MAX_UPSCALE,
      h: (pixels.height / PIXELS_PER_INCH) * MAX_UPSCALE,
    }
    if (most.w < area.w && most.h < area.h) {
      requested = { width: most.w * unit, height: most.h * unit }
      report?.warnings.push(
        `${report.where}: the image is ${pixels.width}×${pixels.height} pixels, so it is shown at ` +
          `${most.w.toFixed(1)}×${most.h.toFixed(1)} in rather than blurred to fill its space. ` +
          `Send a larger image${report.sized ? ', or set width to enlarge it anyway' : ''}.`
      )
    }
  }
  const size = fitImageSize(
    { width: image.width, height: image.height },
    { width: area.w * unit, height: area.h * unit },
    requested
  )
  const w = size.width / unit
  const h = size.height / unit
  return align === 'top-left'
    ? { x: area.x, y: area.y, w, h }
    : { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h }
}

function addPicture(slide: Slide, image: PptxPicture['image'], box: Box, altText = ''): void {
  slide.addImage({
    data: `image/${image.format};base64,${image.data.toString('base64')}`,
    ...box,
    altText,
  })
}

/** Fit `text` to `box` at one of `sizes`; if it cannot fit, shorten it at the smallest. */
function fitOrShorten(
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

function drawTitle(slide: Slide, title: TitleBlock, ctx: DrawContext): void {
  const { frame, palette } = ctx
  addText(
    slide,
    title.text,
    { x: frame.marginX, y: frame.titleY, w: frame.width - frame.marginX * 2, h: title.h },
    { fontSize: title.size, bold: true, color: hex(palette.primary) }
  )
  slide.addShape(ctx.pptx.shapes?.RECTANGLE ?? 'rect', {
    x: frame.marginX,
    y: frame.titleY + title.h + 0.05,
    w: 1.0,
    h: 0.04,
    fill: { color: hex(palette.accent) },
    line: { color: hex(palette.accent) },
  })
}

function statusColor(status: PptxSlide['status'], palette: PptxPalette): string | undefined {
  if (status === 'green') return palette.statusGreen
  if (status === 'yellow') return palette.statusYellow
  if (status === 'red') return palette.statusRed
  return undefined
}

function drawCover(slide: Slide, spec: PptxSlide, ctx: DrawContext): void {
  const { frame, palette, warnings } = ctx
  const band = statusColor(spec.status, palette)
  if (band) {
    slide.addShape(ctx.pptx.shapes?.RECTANGLE ?? 'rect', {
      x: 0,
      y: 0,
      w: frame.width,
      h: 0.18,
      fill: { color: hex(band) },
      line: { color: hex(band) },
    })
  }
  if (ctx.logo) {
    addPicture(
      slide,
      ctx.logo.image,
      placePicture(ctx.logo, { x: 0.5, y: 0.5, w: 1.5, h: 0.5 }, 'top-left')
    )
  }
  const w = frame.width - 1
  const bottom = frame.height - 0.8
  const titleSizes = frame.wide ? [44, 40, 36, 32, 28] : [36, 32, 28, 24]
  let titleFit = fitText([spec.title ?? ''], { w, h: Infinity }, titleSizes, {
    bold: true,
    maxLines: 3,
  })
  let title = spec.title ?? ''
  if (!titleFit.fits) {
    const size = titleSizes[titleSizes.length - 1]
    title = truncateToLines(title, size, w - TEXT_INSET_X, 4, true)
    if (title !== spec.title)
      warnings.push(`${fieldPath(spec, 'title')} is too long for the cover and was shortened.`)
    titleFit = fitText([title], { w, h: Infinity }, [size], { bold: true })
  }
  const subSizes = frame.wide ? [20, 18, 16, 14] : [16, 14, 12]
  let subtitle = spec.subtitle
  let subFit = subtitle
    ? fitText([subtitle], { w, h: Infinity }, subSizes, { maxLines: 3 })
    : undefined
  const stack = () => titleFit.height + (subFit ? 0.1 + subFit.height : 0)
  let top = frame.height * 0.35
  if (top + stack() > bottom) top = Math.max(1.15, bottom - stack())
  if (subtitle && subFit && top + stack() > bottom) {
    const room = bottom - top - titleFit.height - 0.1
    const fitted = fitOrShorten(
      subtitle,
      { w, h: room },
      subSizes,
      fieldPath(spec, 'subtitle'),
      warnings
    )
    subtitle = fitted.text
    subFit = { size: fitted.size, height: fitted.height, fits: true }
  }
  addText(
    slide,
    title,
    { x: 0.5, y: top, w, h: titleFit.height },
    { fontSize: titleFit.size, bold: true, color: hex(palette.primary) }
  )
  if (subtitle && subFit) {
    addText(
      slide,
      subtitle,
      { x: 0.5, y: top + titleFit.height + 0.1, w, h: subFit.height },
      { fontSize: subFit.size, italic: true, color: hex(palette.muted), valign: 'top' }
    )
  }
  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  addText(
    slide,
    dateStr,
    { x: 0.5, y: frame.height - 0.7, w, h: 0.3 },
    { fontSize: 11, color: hex(palette.muted) }
  )
}

function drawSection(slide: Slide, spec: PptxSlide, ctx: DrawContext): void {
  const { frame, palette, warnings } = ctx
  slide.addShape(ctx.pptx.shapes?.RECTANGLE ?? 'rect', {
    x: 0,
    y: 0,
    w: frame.width,
    h: frame.height,
    fill: { color: hex(palette.surface) },
    line: { color: hex(palette.surface) },
  })
  const w = frame.width - 1
  const bottom = frame.footerY - 0.1
  // The letter spacing (in points a character) is not in the measurement, so it comes off the width.
  const spacing = spec.eyebrow && !ARABIC_SCRIPT.test(spec.eyebrow) ? 4 : 0
  const eyebrow = spec.eyebrow
    ? truncateToLines(
        spec.eyebrow.toUpperCase(),
        14,
        w - TEXT_INSET_X - (Array.from(spec.eyebrow).length * spacing) / 72,
        1,
        true
      )
    : undefined
  if (eyebrow && spec.eyebrow && eyebrow !== spec.eyebrow.toUpperCase()) {
    warnings.push(`${fieldPath(spec, 'eyebrow')} is too long for one line and was shortened.`)
  }
  const eyebrowH = eyebrow ? 0.45 : 0
  const titleSizes = frame.wide ? [48, 40, 36, 32] : [40, 36, 32, 28]
  let title = spec.title ?? ''
  let titleFit = fitText([title], { w, h: Infinity }, titleSizes, { bold: true, maxLines: 2 })
  if (!titleFit.fits) {
    const size = titleSizes[titleSizes.length - 1]
    title = truncateToLines(title, size, w - TEXT_INSET_X, 3, true)
    if (title !== spec.title)
      warnings.push(
        `${fieldPath(spec, 'title')} is too long for a section slide and was shortened.`
      )
    titleFit = fitText([title], { w, h: Infinity }, [size], { bold: true })
  }
  const subSizes = [18, 16, 14, 12]
  let subtitle = spec.subtitle
  let subFit = subtitle
    ? fitText([subtitle], { w, h: Infinity }, subSizes, { maxLines: 4 })
    : undefined
  const stack = () => eyebrowH + titleFit.height + (subFit ? 0.1 + subFit.height : 0)
  let top = frame.height * 0.38
  if (top + stack() > bottom) top = Math.max(0.4, bottom - stack())
  if (subtitle && subFit && top + stack() > bottom) {
    const room = bottom - top - eyebrowH - titleFit.height - 0.1
    const fitted = fitOrShorten(
      subtitle,
      { w, h: room },
      subSizes,
      fieldPath(spec, 'subtitle'),
      warnings
    )
    subtitle = fitted.text
    subFit = { size: fitted.size, height: fitted.height, fits: true }
  }
  if (eyebrow) {
    addText(
      slide,
      eyebrow,
      { x: 0.5, y: top, w, h: eyebrowH },
      { fontSize: 14, bold: true, color: hex(palette.accent), charSpacing: spacing }
    )
  }
  addText(
    slide,
    title,
    { x: 0.5, y: top + eyebrowH, w, h: titleFit.height },
    { fontSize: titleFit.size, bold: true, color: hex(palette.primary) }
  )
  if (subtitle && subFit) {
    addText(
      slide,
      subtitle,
      { x: 0.5, y: top + eyebrowH + titleFit.height + 0.1, w, h: subFit.height },
      { fontSize: subFit.size, italic: true, color: hex(palette.muted), valign: 'top' }
    )
  }
}

function drawBullets(slide: Slide, planned: PlannedSlide, ctx: DrawContext): void {
  const list = planned.bullets!
  slide.addText(bulletRuns(slide, list.items), {
    ...planned.body,
    fontSize: list.size,
    color: hex(ctx.palette.text),
    paraSpaceAfter: BULLET_SPACE_AFTER,
    valign: 'top',
  })
}

interface Caption {
  text: string
  size: number
  h: number
}

function captionFor(
  text: string | undefined,
  width: number,
  what: string,
  ctx: DrawContext
): Caption | undefined {
  if (!text) return undefined
  const sizes = [11, 10, 9]
  const fit = fitText([text], { w: width, h: Infinity }, sizes, { maxLines: 3 })
  if (fit.fits) return { text, size: fit.size, h: fit.height }
  const short = truncateToLines(text, 9, width - TEXT_INSET_X, 3)
  ctx.warnings.push(`${what} is longer than three lines under the picture and was shortened.`)
  return { text: short, size: 9, h: fitText([short], { w: width, h: Infinity }, [9]).height }
}

function drawCaption(
  slide: Slide,
  caption: Caption,
  x: number,
  y: number,
  w: number,
  ctx: DrawContext
): void {
  addText(
    slide,
    caption.text,
    { x, y, w, h: caption.h },
    {
      fontSize: caption.size,
      italic: true,
      color: hex(ctx.palette.muted),
      align: 'center',
      valign: 'top',
    }
  )
}

function sameText(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
}

function drawChart(slide: Slide, planned: PlannedSlide, ctx: DrawContext): void {
  const { spec, body } = planned
  const chart = spec.chart!
  const caption = captionFor(chart.caption, body.w, `${fieldPath(spec, 'chart')}.caption`, ctx)
  const area = { ...body, h: body.h - (caption ? caption.h + 0.05 : 0) }
  let bottom = area.y + area.h
  if (chart.picture) {
    const box = placePicture({ image: chart.picture }, area, 'center', {
      where: `${fieldPath(spec, 'chart')}.path`,
      sized: false,
      warnings: ctx.warnings,
    })
    addPicture(slide, chart.picture, box, chart.caption ?? chart.title ?? '')
    bottom = box.y + box.h
  } else if (chart.native) {
    const p = ctx.palette
    const { type, data, options } = nativeChartArgs(
      chart.native,
      {
        // The slide already shows the title a template takes from the chart.
        title: chart.title && !sameText(chart.title, spec.title) ? chart.title : undefined,
        colors: [
          p.primary,
          p.accent,
          p.statusGreen,
          p.statusYellow,
          p.statusRed,
          p.muted,
          ...EXTRA_SERIES_COLORS,
        ].map(hex),
        textColor: hex(p.text),
        mutedColor: hex(p.muted),
      },
      ctx.pptx
    )
    slide.addChart(type, data, { ...area, ...options })
  }
  if (caption) drawCaption(slide, caption, body.x, bottom + 0.05, body.w, ctx)
}

function drawTable(slide: Slide, planned: PlannedSlide, ctx: DrawContext): void {
  const { layout, page } = planned.table!
  const { rows, rowHeights } = layout.pages[page]
  const p = ctx.palette
  const data = rows.map((row, r) =>
    row.map(text => ({
      text: RTL_LETTER.test(text)
        ? directionRuns(text, paragraphOptions(slide, text, 'left'))
        : text,
      options: {
        ...(r === 0
          ? { bold: true, color: 'FFFFFF', fill: { color: hex(p.primary) } }
          : {
              color: hex(p.text),
              fill: r % 2 === 0 ? { color: hex(p.surface) } : undefined,
            }),
        align: 'left',
        valign: 'top',
        ...runOptions(slide, text, 'left'),
      },
    }))
  )
  slide.addTable(data, {
    x: planned.body.x,
    y: planned.body.y,
    w: layout.columnWidths.reduce((a, b) => a + b, 0),
    colW: layout.columnWidths,
    rowH: rowHeights,
    fontSize: layout.fontSize,
    border: { type: 'solid', pt: 0.5, color: hex(p.border) },
    autoPage: false,
  })
}

/** Label and value sizes shared by every card on a slide, so no figure looks more important. */
interface CardType {
  labelSize: number
  /** Room above the value, the same on every card so the values line up. */
  labelHeight: number
  valueSize: number
}

const LABEL_SIZES = [11, 10, 9]
const LABEL_MAX_HEIGHT = 0.6

/** Width of the text in a card, inside its 0.2in padding. */
function cardTextWidth(cardW: number): number {
  return cardW - 0.4
}

function cardType(cards: PptxKpi[], cardW: number, columns: number, people: boolean): CardType {
  const w = cardTextWidth(cardW)
  const labels = people ? [] : cards.flatMap(c => (c.label ? [c.label] : []))
  const labelSize =
    LABEL_SIZES.find(size =>
      labels.every(l => fitText([l], { w, h: LABEL_MAX_HEIGHT }, [size], { bold: true }).fits)
    ) ?? LABEL_SIZES[LABEL_SIZES.length - 1]
  const labelHeight = Math.max(
    0,
    ...labels.map(l =>
      Math.min(
        fitText([l], { w, h: Infinity }, [labelSize], { bold: true }).height,
        LABEL_MAX_HEIGHT
      )
    )
  )
  const valueSizes = people
    ? columns >= 3
      ? [20, 18, 16, 14, 12]
      : [24, 20, 18, 16, 14, 12]
    : columns >= 3
      ? [24, 22, 20, 18, 16, 14, 12]
      : [32, 28, 24, 20, 18, 16, 14, 12]
  // The largest size at which every value that can fit one line does; a value
  // too long even at the smallest wraps at that size instead of shrinking the rest.
  const inner = w - TEXT_INSET_X
  const smallest = valueSizes[valueSizes.length - 1]
  const oneLine = cards.filter(c => textWidth(c.value, smallest, true) <= inner)
  const valueSize =
    (oneLine.length > 0 &&
      valueSizes.find(size => oneLine.every(c => textWidth(c.value, size, true) <= inner))) ||
    smallest
  return { labelSize, labelHeight, valueSize }
}

function drawCard(
  slide: Slide,
  card: PptxKpi,
  box: Box,
  type: CardType,
  people: boolean,
  ctx: DrawContext
): void {
  const p = ctx.palette
  slide.addShape(ctx.pptx.shapes?.ROUNDED_RECTANGLE ?? 'roundRect', {
    ...box,
    fill: { color: hex(p.surface) },
    line: { color: hex(p.border), width: 0.5 },
    rectRadius: 0.05,
  })
  const x = box.x + 0.2
  const w = cardTextWidth(box.w)
  const inner = w - TEXT_INSET_X
  let y = box.y + 0.15
  if (card.label && !people) {
    const label = fitOrShorten(
      card.label,
      { w, h: LABEL_MAX_HEIGHT },
      [type.labelSize],
      `${card.where}.label`,
      ctx.warnings,
      { bold: true }
    )
    addText(
      slide,
      label.text,
      { x, y, w, h: label.height },
      {
        fontSize: label.size,
        color: hex(p.muted),
        bold: true,
      }
    )
  }
  y += type.labelHeight
  let bottom = box.y + box.h - 0.1
  const glyph = card.deltaDirection === 'up' ? '▲ ' : card.deltaDirection === 'down' ? '▼ ' : '— '
  const delta = card.delta
    ? fitOrShorten(
        `${glyph}${card.delta}`,
        { w, h: 0.55 },
        [11, 10, 9],
        `${card.where}.delta`,
        ctx.warnings
      )
    : undefined
  if (delta) bottom -= delta.height
  const size = type.valueSize
  if (textWidth(card.value, size, true) <= inner) {
    const h = lineHeightIn(size, card.value) + TEXT_INSET_Y
    addText(
      slide,
      card.value,
      { x, y, w, h },
      {
        fontSize: size,
        bold: true,
        color: hex(p.primary),
        wrap: false,
      }
    )
    y += h
  } else {
    // A value that wraps keeps the size of the other cards' values and stops above the delta.
    const value = fitOrShorten(
      card.value,
      { w, h: bottom - y },
      [size],
      `${card.where}.value`,
      ctx.warnings,
      { bold: true }
    )
    addText(
      slide,
      value.text,
      { x, y, w, h: value.height },
      { fontSize: size, bold: true, color: hex(p.primary) }
    )
    y += value.height
  }
  if (delta) {
    const color =
      card.deltaDirection === 'up'
        ? p.statusGreen
        : card.deltaDirection === 'down'
          ? p.statusRed
          : p.muted
    addText(
      slide,
      delta.text,
      { x, y: bottom, w, h: delta.height },
      { fontSize: delta.size, color: hex(color) }
    )
  }
  if (card.note) {
    const room = bottom - y
    if (room > TEXT_INSET_Y + 0.1) {
      const note = fitOrShorten(
        card.note,
        { w, h: room },
        people ? [14, 12, 11, 10] : [12, 11, 10, 9],
        card.notePath ?? `${card.where}.note`,
        ctx.warnings
      )
      addText(
        slide,
        note.text,
        { x, y, w, h: note.height },
        {
          fontSize: note.size,
          color: hex(people ? p.muted : p.text),
          valign: 'top',
        }
      )
    } else {
      ctx.warnings.push(
        `${card.notePath ?? card.where}: the card has no room left for this text, which was left out.`
      )
    }
  }
}

function drawKpis(slide: Slide, planned: PlannedSlide, ctx: DrawContext): void {
  const cards = planned.kpis!
  const body = planned.body
  // One row up to four cards, then two rows with the longer one first:
  // five cards are three and two, not four and one.
  const rows = cards.length <= 4 ? 1 : 2
  const cols = Math.ceil(cards.length / rows)
  const gap = 0.2
  const people = planned.spec.kpiStyle === 'people'
  const cellW = Math.min((body.w - gap * (cols - 1)) / cols, MAX_CARD_WIDTH)
  const tallest = cards.some(c => c.note) && !people ? 3.2 : 2.0
  const cellH = Math.min((body.h - gap * (rows - 1)) / rows, tallest)
  const type = cardType(cards, cellW, cols, people)
  cards.forEach((card, i) => {
    const row = Math.floor(i / cols)
    const inRow = Math.min(cols, cards.length - row * cols)
    // Each row is centred, so a shorter last row sits under the middle of the first.
    const left = body.x + (body.w - (cellW * inRow + gap * (inRow - 1))) / 2
    const box = {
      x: left + (i % cols) * (cellW + gap),
      y: body.y + row * (cellH + gap),
      w: cellW,
      h: cellH,
    }
    drawCard(slide, card, box, type, people, ctx)
  })
}

function drawColumn(
  slide: Slide,
  col: PptxColumn,
  area: Box,
  where: string,
  ctx: DrawContext
): void {
  const color = hex(ctx.palette.text)
  const sizes = [14, 13, 12, 11]
  if (col.bullets) {
    const columnStyle = { paraSpaceAfter: 6, indent: BULLET_INDENT }
    const bullets = col.bullets
    const fitFirst = (count: number) => fitText(bullets.slice(0, count), area, sizes, columnStyle)
    let items = bullets
    let fit = fitFirst(items.length)
    if (!fit.fits && items.length > 1) {
      // Fewer bullets never need more room, so the most that fit is found by halving.
      let lo = 1
      let hi = items.length - 1
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (fitFirst(mid).fits) lo = mid
        else hi = mid - 1
      }
      items = items.slice(0, lo)
      fit = fitFirst(lo)
    }
    if (!fit.fits) {
      const size = sizes[sizes.length - 1]
      const width = area.w - TEXT_INSET_X - BULLET_INDENT
      const lines = Math.max(
        Math.floor((area.h - TEXT_INSET_Y - 6 / 72) / lineHeightIn(size, items[0])),
        1
      )
      items = [truncateToLines(items[0], size, width, lines)]
      fit = { size, height: area.h, fits: true }
      ctx.warnings.push(
        `${where}.bullets[0] is too long for the column and was shortened; shorten it, or ` +
          'give it a title-bullets slide, which has the whole slide width.'
      )
    }
    const dropped = col.bullets.length - items.length
    if (dropped > 0) {
      ctx.warnings.push(
        `${where}.bullets: the last ${dropped} of ${col.bullets.length} bullets did not fit in ` +
          'the column and were left out; move them to another slide, or use a title-bullets ' +
          'slide, which continues on more slides.'
      )
    }
    slide.addText(bulletRuns(slide, items), {
      ...area,
      fontSize: fit.size,
      color,
      paraSpaceAfter: 6,
      valign: 'top',
    })
  } else if (col.text) {
    const text = fitOrShorten(col.text, area, sizes, `${where}.text`, ctx.warnings)
    addText(slide, text.text, area, {
      fontSize: text.size,
      color,
      paraSpaceAfter: 6,
      valign: 'top',
    })
  } else if (col.picture) {
    const caption = captionFor(col.picture.caption, area.w, `${where}.image.caption`, ctx)
    const box = placePicture(
      col.picture,
      { ...area, h: area.h - (caption ? caption.h + 0.05 : 0) },
      'center',
      { where: `${where}.image`, sized: true, warnings: ctx.warnings }
    )
    addPicture(slide, col.picture.image, box, col.picture.caption ?? '')
    if (caption) drawCaption(slide, caption, area.x, box.y + box.h + 0.05, area.w, ctx)
  }
}

function drawTwoColumn(slide: Slide, planned: PlannedSlide, ctx: DrawContext): void {
  const { body, spec } = planned
  const gap = 0.4
  const colW = (body.w - gap) / 2
  drawColumn(slide, spec.columns!.left, { ...body, w: colW }, `${spec.where}.columns.left`, ctx)
  drawColumn(
    slide,
    spec.columns!.right,
    { ...body, x: body.x + colW + gap, w: colW },
    `${spec.where}.columns.right`,
    ctx
  )
}

function drawImage(slide: Slide, planned: PlannedSlide, ctx: DrawContext): void {
  const { body, spec } = planned
  const picture = spec.picture
  if (!picture) return
  const caption = captionFor(picture.caption, body.w, `${fieldPath(spec, 'image')}.caption`, ctx)
  const box = placePicture(
    picture,
    { ...body, h: body.h - (caption ? caption.h + 0.05 : 0) },
    'center',
    { where: fieldPath(spec, 'image'), sized: true, warnings: ctx.warnings }
  )
  addPicture(slide, picture.image, box, picture.caption ?? '')
  if (caption) drawCaption(slide, caption, body.x, box.y + box.h + 0.05, body.w, ctx)
}

function drawQuote(slide: Slide, spec: PptxSlide, ctx: DrawContext): void {
  const { frame, palette } = ctx
  const quote = spec.quote!
  addText(
    slide,
    '“',
    { x: frame.marginX, y: frame.height * 0.18, w: 2, h: 2 },
    { fontSize: frame.wide ? 120 : 90, color: hex(palette.accent), bold: true }
  )
  const box = {
    x: frame.marginX + 1.0,
    y: frame.height * 0.32,
    w: frame.width - frame.marginX * 2 - 1.0,
    h: frame.height * 0.44,
  }
  const sizes = frame.wide ? [28, 24, 20, 18, 16] : [22, 20, 18, 16, 14]
  const text = fitOrShorten(
    quote.text,
    box,
    sizes,
    `${fieldPath(spec, 'quote')}.text`,
    ctx.warnings
  )
  addText(slide, text.text, box, {
    fontSize: text.size,
    italic: true,
    color: hex(palette.text),
    valign: 'top',
  })
  if (quote.attribution) {
    const full = `— ${quote.attribution}`
    const line = truncateToLines(full, 14, box.w - TEXT_INSET_X, 1, true)
    if (line !== full) {
      ctx.warnings.push(
        `${fieldPath(spec, 'quote')}.attribution is too long for one line and was shortened.`
      )
    }
    addText(
      slide,
      line,
      { x: box.x, y: frame.height * 0.78, w: box.w, h: 0.5 },
      { fontSize: 14, bold: true, color: hex(palette.muted) }
    )
  }
}

function drawFooter(
  slide: Slide,
  left: string | undefined,
  page: number,
  total: number,
  ctx: DrawContext
): void {
  const { frame, palette } = ctx
  const muted = hex(palette.muted)
  if (left) {
    addText(
      slide,
      left,
      { x: frame.marginX, y: frame.footerY, w: frame.width / 2, h: 0.3 },
      { fontSize: 9, color: muted, align: 'left' }
    )
  }
  slide.addText(`${page} / ${total}`, {
    x: frame.width - frame.marginX - 1.0,
    y: frame.footerY,
    w: 1.0,
    h: 0.3,
    fontSize: 9,
    color: muted,
    align: 'right',
  })
}

function drawSlide(slide: Slide, planned: PlannedSlide, ctx: DrawContext): void {
  const { spec } = planned
  if (planned.title) drawTitle(slide, planned.title, ctx)
  switch (spec.layout) {
    case 'cover':
      return drawCover(slide, spec, ctx)
    case 'section':
      return drawSection(slide, spec, ctx)
    case 'title-bullets':
      return drawBullets(slide, planned, ctx)
    case 'title-chart':
      return drawChart(slide, planned, ctx)
    case 'title-table':
      return drawTable(slide, planned, ctx)
    case 'kpis':
      return drawKpis(slide, planned, ctx)
    case 'two-column':
      return drawTwoColumn(slide, planned, ctx)
    case 'image':
      return drawImage(slide, planned, ctx)
    case 'quote':
      return drawQuote(slide, spec, ctx)
  }
}

function pick<T>(
  table: Record<string, T>,
  value: unknown,
  fallback: string,
  field: string,
  warnings: string[]
): T {
  if (value === undefined || value === null || value === '') return table[fallback]
  if (typeof value === 'string' && table[value]) return table[value]
  warnings.push(
    `${field} ${JSON.stringify(value)} is not one of ${Object.keys(table).join(', ')}; ` +
      `"${fallback}" was used.`
  )
  return table[fallback]
}

/** The slides `args` describe, from a template's data or from slides[]. */
function readDeck(args: Record<string, unknown>, ctx: ReadContext): PptxSlide[] {
  const template = args.template ?? 'custom'
  if (template === 'custom') {
    if (args.slides === undefined && args.data !== undefined) {
      throw new PptxInputError(
        `data is only read with a template: set template to one of ${PPTX_TEMPLATES.join(', ')}, ` +
          'or send the slides in slides[].'
      )
    }
    if (args.data !== undefined) {
      ctx.warnings.push(
        `data was ignored: it is only read when template is one of ${PPTX_TEMPLATES.join(', ')}.`
      )
    }
    return readSlides(args.slides, ctx)
  }
  if (!(PPTX_TEMPLATES as readonly unknown[]).includes(template)) {
    throw new PptxInputError(
      `template ${JSON.stringify(template)} is not a template. Use one of ` +
        `${PPTX_TEMPLATES.join(', ')} with data, or custom with slides[].`
    )
  }
  const slides = buildTemplateSlides(template as PptxTemplate, args.data, ctx)
  if (args.slides !== undefined) {
    ctx.warnings.push(
      `slides was left out: template "${String(template)}" builds the slides from data. Leave ` +
        'template out to send your own slides.'
    )
  }
  return slides
}

/**
 * Build the deck `args` describe. Returns the file contents and the number of
 * slides; anything repaired or left out is added to `warnings`. Throws
 * PptxInputError, naming the field, for arguments no deck can be built from.
 */
export async function buildPptxDeck(
  args: Record<string, unknown>,
  outputDir: string,
  warnings: string[]
): Promise<{ buffer: Buffer; slides: number }> {
  const ctx: ReadContext = { outputDir, warnings }
  const specs = readDeck(args, ctx)
  const palette = pick(PPTX_PALETTES, args.palette, 'default', 'palette', warnings)
  const aspect = pick(PPTX_ASPECT_RATIOS, args.aspectRatio, 'wide', 'aspectRatio', warnings)
  if (args.branding !== undefined && args.branding !== null && !isRecord(args.branding)) {
    throw new PptxInputError(
      'branding must be an object with companyName, logoPath and footerText.'
    )
  }
  const branding = isRecord(args.branding) ? args.branding : {}
  const companyName = readText(branding.companyName, 'branding.companyName', 200, ctx)
  const footerText = readText(branding.footerText, 'branding.footerText', 200, ctx)
  const logo =
    branding.logoPath !== undefined && branding.logoPath !== null && branding.logoPath !== ''
      ? readPicture(branding.logoPath, 'branding.logoPath', ctx)
      : undefined

  const pptx = new PptxGenJS()
  pptx.layout = aspect.name
  // The family is set on the theme, never on a run: pptxgenjs writes a run's
  // face as its East Asian face too, and Arial has no CJK, so PowerPoint would
  // pick CJK glyphs one by one from fallback fonts. Left to the theme, it uses
  // the face for each run's language tag instead.
  pptx.theme = { headFontFace: PPTX_FONT_FACE, bodyFontFace: PPTX_FONT_FACE }
  // Always assign every metadata field (even when empty). pptxgenjs otherwise
  // fills `dc:subject` / `dc:creator` with its own default strings, which would
  // surface as an unintentional brand mark in the deliverable.
  pptx.title = readText(args.title, 'title', 200, ctx) ?? ''
  pptx.subject = readText(args.subject, 'subject', 200, ctx) ?? ''
  pptx.author = readText(args.author, 'author', 200, ctx) ?? ''
  // pptxgenjs writes the company into docProps/app.xml without escaping it,
  // where an unescaped "&" or "<" makes the whole file unreadable.
  pptx.company = (companyName ?? '').replace(
    /[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!
  )

  const frame = frameFor(aspect.width, aspect.height)
  const planned = specs.flatMap(spec => planSlide(spec, frame, warnings))
  const drawCtx: DrawContext = { frame, palette, pptx, warnings, logo }

  let footer = [companyName, footerText].filter(Boolean).join(' · ') || undefined
  if (footer && wrapLines(footer, 9, frame.width / 2 - TEXT_INSET_X).length > 1) {
    footer = truncateToLines(footer, 9, frame.width / 2 - TEXT_INSET_X, 1)
    warnings.push(
      'branding: the company name and footer text are too long for one footer line and were shortened.'
    )
  }

  const han = documentEastAsianScript(deckText(specs))?.lang
  planned.forEach((plan, i) => {
    const slide = pptx.addSlide()
    if (han) hanLanguage.set(slide, han)
    slide.background = { color: hex(palette.background) }
    drawSlide(slide, plan, drawCtx)
    if (plan.spec.notes && planned[i - 1]?.spec !== plan.spec) slide.addNotes(plan.spec.notes)
    // The cover carries its own date instead of the footer.
    if (plan.spec.layout !== 'cover') drawFooter(slide, footer, i + 1, planned.length, drawCtx)
  })

  // A title shortened on a slide split into parts is reported once, not per part.
  const unique = [...new Set(warnings)]
  warnings.splice(0, warnings.length, ...unique)

  const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
  return { buffer: await withOnePropertiesPerParagraph(buffer), slides: planned.length }
}

const SLIDE_PART = /^ppt\/slides\/slide\d+\.xml$/
const PARAGRAPH = /<a:p>([\s\S]*?)<\/a:p>/g
const PARAGRAPH_PROPERTIES = /<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g

/**
 * pptxgenjs writes paragraph properties before every run of a paragraph, where
 * a paragraph may have them once, before its first run. The first set is the
 * paragraph's own (its bullet, alignment and direction), so the rest go.
 */
async function withOnePropertiesPerParagraph(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer)
  let changed = false
  for (const name of Object.keys(zip.files).filter(n => SLIDE_PART.test(n))) {
    const xml = await zip.file(name)!.async('string')
    const fixed = xml.replace(PARAGRAPH, (_p, inner: string) => {
      let seen = false
      const once = inner.replace(PARAGRAPH_PROPERTIES, props =>
        seen ? '' : ((seen = true), props)
      )
      return `<a:p>${once}</a:p>`
    })
    if (fixed !== xml) {
      zip.file(name, fixed)
      changed = true
    }
  }
  // Stored, as pptxgenjs writes the package, so the pictures are not compressed again.
  return changed ? zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }) : buffer
}
