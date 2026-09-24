/**
 * Reading clerum__generate_pptx arguments into slide specs.
 *
 * Everything the renderer draws passes through here first, so a malformed
 * argument becomes a message naming the field and the fix rather than a
 * JavaScript TypeError, a slide with an error printed on it, or an empty slide
 * reported as success. Repairs (rows sent as records read by header, text
 * shortened to its length limit) are made here and reported as warnings.
 */
import { type EmbeddableImage, loadEmbeddableImage } from './embeddedImages'
import { ChartSpecError, type NativeChart, readNativeChart } from './pptxCharts'
import { headerText, normalizeTableRows } from './tableRows'

/** An argument the deck cannot be built from; the message names the field. */
export class PptxInputError extends Error {}

export const SLIDE_LAYOUTS = [
  'cover',
  'section',
  'title-bullets',
  'title-chart',
  'title-table',
  'kpis',
  'two-column',
  'image',
  'quote',
] as const

export type SlideLayout = (typeof SLIDE_LAYOUTS)[number]

export const STATUSES = ['green', 'yellow', 'red'] as const
export type Status = (typeof STATUSES)[number]

const DELTA_DIRECTIONS = ['up', 'down', 'neutral'] as const

/** Longest text each field keeps, so a runaway model cannot bloat the archive. */
export const TEXT_LIMITS = {
  title: 200,
  eyebrow: 100,
  subtitle: 400,
  bullet: 1000,
  header: 200,
  cell: 500,
  label: 120,
  value: 80,
  delta: 80,
  note: 1000,
  caption: 400,
  quote: 2000,
  attribution: 200,
  narrative: 4000,
  notes: 8000,
}

export interface PptxKpi {
  /** Argument path of the card, for messages. */
  where: string
  /** Argument path of `note`, when it is not `${where}.note`. */
  notePath?: string
  label?: string
  value: string
  delta?: string
  deltaDirection?: (typeof DELTA_DIRECTIONS)[number]
  /** A longer explanation under the value. */
  note?: string
}

export interface PptxTable {
  headers: string[]
  rows: string[][]
}

export interface PptxPicture {
  image: EmbeddableImage
  caption?: string
  /** Requested size in inches; the other side follows the image's proportions. */
  width?: number
  height?: number
}

export interface PptxChart {
  title?: string
  caption?: string
  picture?: EmbeddableImage
  native?: NativeChart
}

export interface PptxColumn {
  bullets?: string[]
  text?: string
  picture?: PptxPicture
}

export interface PptxSlide {
  layout: SlideLayout
  /** Where the slide came from, as the model wrote it: "slides[2]", or "data" for a template. */
  where: string
  title?: string
  eyebrow?: string
  subtitle?: string
  status?: Status
  bullets?: string[]
  table?: PptxTable
  kpis?: PptxKpi[]
  /** People cards: the name large, the role under it. */
  kpiStyle?: 'people'
  chart?: PptxChart
  picture?: PptxPicture
  quote?: { text: string; attribution?: string }
  columns?: { left: PptxColumn; right: PptxColumn }
  notes?: string
  /** Argument paths of fields that did not come from `${where}.<field>`, for messages. */
  paths?: Record<string, string>
}

/** Argument path of one of a slide's fields, as messages name it. */
export function fieldPath(slide: PptxSlide, field: string): string {
  return slide.paths?.[field] ?? `${slide.where}.${field}`
}

export interface ReadContext {
  outputDir: string
  warnings: string[]
  /** Set once a text field holding markup has been reported. */
  markupNoted?: boolean
}

/**
 * Markdown and HTML a model writes into text that a slide prints as it is:
 * **bold**, `code`, [label](url) and <b>, <i>, <strong>, <em> or <br>. A single
 * asterisk is left alone, since 2*3*4 is ordinary text.
 */
const MARKUP =
  /\*\*[^*\s][^*]*\*\*|`[^`\n]+`|\[[^[\]\n]+\]\((?:https?:|mailto:)[^)\s]+\)|<\/?(?:b|i|strong|em|br)\b[^<>]*>/i

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`
}

/** `text` shortened to `max` characters at a word, ending in an ellipsis. */
export function shorten(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  let kept = chars.slice(0, max - 1).join('')
  const space = kept.lastIndexOf(' ')
  if (space > kept.length * 0.8) kept = kept.slice(0, space)
  return `${kept.trimEnd()}…`
}

/** Optional text. Numbers and booleans are written as they print. */
export function readText(
  value: unknown,
  where: string,
  max: number,
  ctx: ReadContext
): string | undefined {
  if (value === undefined || value === null) return undefined
  const raw = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value
  if (typeof raw !== 'string') {
    throw new PptxInputError(`${where} must be text; received ${describe(value)}.`)
  }
  const text = raw.trim()
  if (!text) return undefined
  if (!ctx.markupNoted && MARKUP.test(text)) {
    ctx.markupNoted = true
    ctx.warnings.push(
      `${where} holds markdown or HTML, which slides print as written; PPTX text is plain, ` +
        'so send it without **bold**, `code`, [label](url) or tags.'
    )
  }
  if (Array.from(text).length > max) {
    ctx.warnings.push(`${where} is longer than ${max} characters and was shortened.`)
    return shorten(text, max)
  }
  return text
}

/** A Markdown list marker, which the slide's own bullet would print twice. */
const LIST_MARKER = /^[-*+•]\s+/

/** A list of text items. One string is read as one item per line. */
export function readStringList(
  value: unknown,
  where: string,
  max: number,
  ctx: ReadContext
): string[] | undefined {
  if (value === undefined || value === null) return undefined
  let items: Array<string | undefined>
  if (typeof value === 'string') {
    items = value.split('\n').map((line, i) => readText(line, `${where} line ${i + 1}`, max, ctx))
  } else if (Array.isArray(value)) {
    items = value.map((item, i) => readText(item, `${where}[${i}]`, max, ctx))
  } else {
    throw new PptxInputError(`${where} must be a list of text items; received ${describe(value)}.`)
  }
  return items.map(item => item?.replace(LIST_MARKER, '')).filter((item): item is string => !!item)
}

export function readEnum<T extends string>(
  value: unknown,
  where: string,
  allowed: readonly T[]
): T | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (!(allowed as readonly unknown[]).includes(value)) {
    throw new PptxInputError(
      `${where} must be one of ${allowed.join(', ')}; received ${JSON.stringify(value)}.`
    )
  }
  return value as T
}

function requireList(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new PptxInputError(`${where} must be a list; received ${describe(value)}.`)
  }
  return value
}

export function readKpis(value: unknown, where: string, ctx: ReadContext): PptxKpi[] {
  return requireList(value, where).map((item, i) => {
    const at = `${where}[${i}]`
    if (!isRecord(item)) {
      throw new PptxInputError(
        `${at} must be an object such as {"label": "Revenue", "value": "$1.2M"}; received ${describe(item)}.`
      )
    }
    const value = readText(item.value, `${at}.value`, TEXT_LIMITS.value, ctx)
    if (value === undefined) {
      throw new PptxInputError(
        `${at}.value is missing: give the figure to show, e.g. "$1.2M" or 48.`
      )
    }
    const kpi: PptxKpi = { where: at, value }
    kpi.label = readText(item.label, `${at}.label`, TEXT_LIMITS.label, ctx)
    kpi.delta = readText(item.delta, `${at}.delta`, TEXT_LIMITS.delta, ctx)
    kpi.deltaDirection = readEnum(item.deltaDirection, `${at}.deltaDirection`, DELTA_DIRECTIONS)
    return kpi
  })
}

function cellText(value: unknown, where: string, ctx: ReadContext): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') {
    throw new PptxInputError(`${where} is ${describe(value)}; a cell holds text or a number.`)
  }
  return readText(value, where, TEXT_LIMITS.cell, ctx) ?? ''
}

export function readTable(value: unknown, where: string, ctx: ReadContext): PptxTable {
  if (!isRecord(value)) {
    throw new PptxInputError(
      `${where} must be an object with headers and rows; received ${describe(value)}.`
    )
  }
  if (!Array.isArray(value.headers) || value.headers.length === 0) {
    throw new PptxInputError(`${where}.headers must list the column headings, left to right.`)
  }
  const headers = value.headers.map(
    (h, i) => readText(headerText(h), `${where}.headers[${i}]`, TEXT_LIMITS.header, ctx) ?? ''
  )
  if (value.rows !== undefined && !Array.isArray(value.rows)) {
    throw new PptxInputError(
      `${where}.rows must be a list of rows, each a list of cells in header order.`
    )
  }
  const rows = normalizeTableRows(value.rows, value.headers, where, ctx.warnings)
  let cut = 0
  const cells = rows.map((row, r) => {
    if (row.length > headers.length) cut++
    return headers.map((_, c) => cellText(row[c], `${where}.rows[${r}][${c}]`, ctx))
  })
  if (cut > 0) {
    ctx.warnings.push(
      `${where}: ${cut} row(s) had more cells than the ${headers.length} headers; the extra cells were left out.`
    )
  }
  if (cells.length === 0) {
    ctx.warnings.push(
      `${where} has no rows, so the table shows only its headings; add rows, or leave the ` +
        'slide out.'
    )
  }
  return { headers, rows: cells }
}

/**
 * Load an image argument. A missing or unreadable file is a warning and
 * returns undefined; a path escaping the output folder fails the call, as it
 * does in every generator.
 */
export function readPicture(
  value: unknown,
  where: string,
  ctx: ReadContext
): PptxPicture | undefined {
  if (value !== undefined && typeof value !== 'string' && !isRecord(value)) {
    throw new PptxInputError(
      `${where} must be a file name such as 'sales.png' or {"path": "sales.png"}; received ${describe(value)}.`
    )
  }
  const pathField = typeof value === 'string' ? where : `${where}.path`
  const local: string[] = []
  let image: EmbeddableImage | undefined
  try {
    image = loadEmbeddableImage(value, ctx.outputDir, local, pathField)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new PptxInputError(
      `${pathField}: ${message}. Pass the file name in the output folder, as ` +
        "clerum__generate_chart returns it (e.g. 'sales.png')."
    )
  }
  for (const w of local) ctx.warnings.push(w.startsWith(pathField) ? w : `${pathField}: ${w}`)
  if (!image) {
    if (isRecord(value) && typeof value.caption === 'string' && value.caption.trim()) {
      ctx.warnings.push(`${where}.caption was left out with the image it describes.`)
    }
    return undefined
  }
  const picture: PptxPicture = { image }
  if (isRecord(value)) {
    picture.caption = readText(value.caption, `${where}.caption`, TEXT_LIMITS.caption, ctx)
    for (const side of ['width', 'height'] as const) {
      const n = value[side]
      if (n === undefined || n === null) continue
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
        throw new PptxInputError(`${where}.${side} must be a positive number of inches.`)
      }
      picture[side] = n
    }
  }
  return picture
}

export function readChart(value: unknown, where: string, ctx: ReadContext): PptxChart {
  if (!isRecord(value)) {
    throw new PptxInputError(
      `${where} must be an object: {"path": "sales.png"} for a chart image from ` +
        'clerum__generate_chart, or {"type", "labels", "datasets"} for a native chart.'
    )
  }
  const chart: PptxChart = {
    title: readText(value.title, `${where}.title`, TEXT_LIMITS.title, ctx),
    caption: readText(value.caption, `${where}.caption`, TEXT_LIMITS.caption, ctx),
  }
  try {
    chart.native = readNativeChart(value, where, ctx.warnings)
  } catch (err) {
    if (err instanceof ChartSpecError) throw new PptxInputError(err.message)
    throw err
  }
  if (value.path !== undefined && value.path !== null && value.path !== '') {
    chart.picture = readPicture(value.path, `${where}.path`, ctx)?.image
    if (chart.picture) chart.native = undefined
    else if (chart.native) {
      ctx.warnings.push(
        `${where}: the image could not be used, so the chart was drawn from its data.`
      )
    }
  } else if (!chart.native) {
    throw new PptxInputError(
      `${where} has nothing to draw: pass path with the file name clerum__generate_chart ` +
        'returned, or type, labels and datasets for a native chart.'
    )
  }
  return chart
}

function readColumn(value: unknown, where: string, ctx: ReadContext): PptxColumn {
  if (!isRecord(value)) {
    throw new PptxInputError(
      `${where} must be an object such as {"type": "bullets", "bullets": ["..."]}.`
    )
  }
  const type =
    value.type ??
    (value.bullets !== undefined ? 'bullets' : value.image !== undefined ? 'image' : 'narrative')
  if (type === 'bullets') {
    const bullets = readStringList(value.bullets, `${where}.bullets`, TEXT_LIMITS.bullet, ctx)
    if (!bullets?.length) throw new PptxInputError(`${where}.bullets needs at least one bullet.`)
    return { bullets }
  }
  if (type === 'narrative') {
    const text = readText(value.text, `${where}.text`, TEXT_LIMITS.narrative, ctx)
    if (!text) throw new PptxInputError(`${where}.text is missing for a narrative column.`)
    return { text }
  }
  if (type === 'image') {
    if (value.image === undefined) {
      throw new PptxInputError(`${where}.image is missing for an image column.`)
    }
    return { picture: readPicture(value.image, `${where}.image`, ctx) }
  }
  throw new PptxInputError(
    `${where}.type must be one of bullets, narrative, image; received ${JSON.stringify(type)}.`
  )
}

/** What each layout draws. Anything else on the slide is reported as left out. */
const LAYOUT_FIELDS: Record<SlideLayout, string[]> = {
  cover: ['title', 'subtitle', 'status'],
  section: ['title', 'eyebrow', 'subtitle'],
  'title-bullets': ['title', 'bullets'],
  'title-chart': ['title', 'chart'],
  'title-table': ['title', 'table'],
  kpis: ['title', 'kpis'],
  'two-column': ['title', 'columns'],
  image: ['title', 'image'],
  quote: ['quote'],
}

/** The layout for the content a slide carries, to suggest when it names another. */
const CONTENT_LAYOUT: Record<string, SlideLayout> = {
  bullets: 'title-bullets',
  chart: 'title-chart',
  table: 'title-table',
  kpis: 'kpis',
  columns: 'two-column',
  image: 'image',
  quote: 'quote',
}

function missing(where: string, layout: SlideLayout, field: string, shape: string): never {
  throw new PptxInputError(
    `${where} uses layout "${layout}" but has no ${field}; add ${field}: ${shape}, or pick the ` +
      'layout that matches what the slide carries.'
  )
}

function readSlide(raw: unknown, index: number, ctx: ReadContext): PptxSlide {
  const where = `slides[${index}]`
  if (!isRecord(raw)) {
    throw new PptxInputError(`${where} must be an object with a layout; received ${describe(raw)}.`)
  }
  if (!(SLIDE_LAYOUTS as readonly unknown[]).includes(raw.layout)) {
    const hint = Object.keys(CONTENT_LAYOUT).find(k => raw[k] !== undefined)
    throw new PptxInputError(
      `${where}.layout ${JSON.stringify(raw.layout)} is not a layout. Use one of ` +
        `${SLIDE_LAYOUTS.join(', ')}` +
        (hint ? `; a slide with ${hint} uses "${CONTENT_LAYOUT[hint]}".` : '.')
    )
  }
  const layout = raw.layout as SlideLayout
  const slide: PptxSlide = {
    layout,
    where,
    title: readText(raw.title, `${where}.title`, TEXT_LIMITS.title, ctx),
    notes: readText(raw.notes, `${where}.notes`, TEXT_LIMITS.notes, ctx),
  }
  const used = LAYOUT_FIELDS[layout]
  if (used.includes('eyebrow')) {
    slide.eyebrow = readText(raw.eyebrow, `${where}.eyebrow`, TEXT_LIMITS.eyebrow, ctx)
  }
  if (used.includes('subtitle')) {
    slide.subtitle = readText(raw.subtitle, `${where}.subtitle`, TEXT_LIMITS.subtitle, ctx)
  }
  if (used.includes('status')) slide.status = readEnum(raw.status, `${where}.status`, STATUSES)

  switch (layout) {
    case 'cover':
    case 'section':
      if (!slide.title) missing(where, layout, 'title', '"..."')
      break
    case 'title-bullets':
      slide.bullets = readStringList(raw.bullets, `${where}.bullets`, TEXT_LIMITS.bullet, ctx)
      if (!slide.bullets?.length) missing(where, layout, 'bullets', '["...", "..."]')
      break
    case 'title-chart':
      if (raw.chart === undefined) missing(where, layout, 'chart', '{"path": "sales.png"}')
      slide.chart = readChart(raw.chart, `${where}.chart`, ctx)
      break
    case 'title-table':
      if (raw.table === undefined)
        missing(where, layout, 'table', '{"headers": [...], "rows": [[...]]}')
      slide.table = readTable(raw.table, `${where}.table`, ctx)
      break
    case 'kpis':
      if (raw.kpis === undefined)
        missing(where, layout, 'kpis', '[{"label": "...", "value": "..."}]')
      slide.kpis = readKpis(raw.kpis, `${where}.kpis`, ctx)
      if (slide.kpis.length === 0)
        missing(where, layout, 'kpis', '[{"label": "...", "value": "..."}]')
      break
    case 'two-column': {
      const cols = raw.columns
      if (!isRecord(cols) || cols.left === undefined || cols.right === undefined) {
        missing(where, layout, 'columns', '{"left": {...}, "right": {...}}')
      }
      slide.columns = {
        left: readColumn(cols.left, `${where}.columns.left`, ctx),
        right: readColumn(cols.right, `${where}.columns.right`, ctx),
      }
      break
    }
    case 'image':
      if (raw.image === undefined) missing(where, layout, 'image', '{"path": "photo.png"}')
      slide.picture = readPicture(raw.image, `${where}.image`, ctx)
      break
    case 'quote': {
      const q = typeof raw.quote === 'string' ? { text: raw.quote } : raw.quote
      const text = isRecord(q)
        ? readText(q.text, `${where}.quote.text`, TEXT_LIMITS.quote, ctx)
        : undefined
      if (!isRecord(q) || !text) missing(where, layout, 'quote', '{"text": "..."}')
      slide.quote = {
        text,
        attribution: readText(
          q.attribution,
          `${where}.quote.attribution`,
          TEXT_LIMITS.attribution,
          ctx
        ),
      }
      break
    }
  }

  const ignored = ['title', 'eyebrow', 'subtitle', 'status', ...Object.keys(CONTENT_LAYOUT)].filter(
    k => !used.includes(k) && raw[k] !== undefined && raw[k] !== null && raw[k] !== ''
  )
  if (ignored.length > 0) {
    ctx.warnings.push(
      `${where}: ${ignored.join(', ')} ${ignored.length > 1 ? 'are' : 'is'} not shown on a "${layout}" ` +
        'slide and was left out; put it on a slide whose layout draws it.'
    )
  }
  return slide
}

export function readSlides(value: unknown, ctx: ReadContext): PptxSlide[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PptxInputError(
      'slides must be a non-empty list of slides, each with a layout, or pass template and data ' +
        'to have the slides built for you.'
    )
  }
  return value.map((raw, i) => readSlide(raw, i, ctx))
}
