/** The slide renderers, one per layout, and the footer. */
import { nativeChartArgs } from './pptxCharts'
import { type DrawContext, fitOrShorten, hex } from './pptxDraw'
import { type PptxColumn, type PptxSlide, type SlideOf, fieldPath } from './pptxInput'
import { drawKpis } from './pptxKpiCards'
import {
  BULLET_INDENT,
  BULLET_SPACE_AFTER,
  type Box,
  type PlanOf,
  type PlannedSlide,
  type TitleBlock,
  isPlanOf,
} from './pptxLayout'
import { addPicture, placePicture } from './pptxPictures'
import {
  ARABIC_SCRIPT,
  type Slide,
  addText,
  bulletRuns,
  directionRuns,
  paragraphOptions,
  runOptions,
} from './pptxRuns'
import { TEXT_INSET_X, TEXT_INSET_Y, fitText, lineHeightIn, truncateToLines } from './pptxText'
import { type PptxPalette } from './pptxVocabulary'
import { hasRtlLetter } from './textDirection'

/** Series colors after the palette's own, so a chart of up to ten slices does not repeat one. */
const EXTRA_SERIES_COLORS = ['#7c3aed', '#0d9488', '#ea580c', '#db2777']

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

function drawBullets(slide: Slide, planned: PlanOf<'title-bullets'>, ctx: DrawContext): void {
  const list = planned.bullets
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

function drawChart(slide: Slide, planned: PlanOf<'title-chart'>, ctx: DrawContext): void {
  const { spec, body } = planned
  const chart = spec.chart
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

function drawTable(slide: Slide, planned: PlanOf<'title-table'>, ctx: DrawContext): void {
  const { layout, page } = planned.table
  const { rows, rowHeights } = layout.pages[page]
  const p = ctx.palette
  const data = rows.map((row, r) =>
    row.map(text => ({
      text: hasRtlLetter(text) ? directionRuns(text, paragraphOptions(slide, text, 'left')) : text,
      options: {
        ...(r === 0
          ? { bold: true, color: 'FFFFFF', fill: { color: hex(p.primary) } }
          : {
              color: hex(p.text),
              fill: r % 2 === 0 ? { color: hex(p.surface) } : undefined,
            }),
        align: 'left' as const,
        valign: 'top' as const,
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

function drawTwoColumn(slide: Slide, planned: PlanOf<'two-column'>, ctx: DrawContext): void {
  const { body, spec } = planned
  const gap = 0.4
  const colW = (body.w - gap) / 2
  drawColumn(slide, spec.columns.left, { ...body, w: colW }, `${spec.where}.columns.left`, ctx)
  drawColumn(
    slide,
    spec.columns.right,
    { ...body, x: body.x + colW + gap, w: colW },
    `${spec.where}.columns.right`,
    ctx
  )
}

function drawImage(slide: Slide, planned: PlanOf<'image'>, ctx: DrawContext): void {
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

function drawQuote(slide: Slide, spec: SlideOf<'quote'>, ctx: DrawContext): void {
  const { frame, palette } = ctx
  const quote = spec.quote
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

export function drawFooter(
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

export function drawSlide(slide: Slide, planned: PlannedSlide, ctx: DrawContext): void {
  if (planned.title) drawTitle(slide, planned.title, ctx)
  if (isPlanOf(planned, 'cover')) return drawCover(slide, planned.spec, ctx)
  if (isPlanOf(planned, 'section')) return drawSection(slide, planned.spec, ctx)
  if (isPlanOf(planned, 'title-bullets')) return drawBullets(slide, planned, ctx)
  if (isPlanOf(planned, 'title-chart')) return drawChart(slide, planned, ctx)
  if (isPlanOf(planned, 'title-table')) return drawTable(slide, planned, ctx)
  if (isPlanOf(planned, 'kpis')) return drawKpis(slide, planned, ctx)
  if (isPlanOf(planned, 'two-column')) return drawTwoColumn(slide, planned, ctx)
  if (isPlanOf(planned, 'image')) return drawImage(slide, planned, ctx)
  if (isPlanOf(planned, 'quote')) return drawQuote(slide, planned.spec, ctx)
}
