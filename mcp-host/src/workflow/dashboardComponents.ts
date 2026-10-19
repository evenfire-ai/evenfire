/** The parts a dashboard page is made of: hero, KPI cards, chart cards, tables, sections, service health, incidents and footer. */
import { coerceNumber } from './chartData'
import { DashboardCharts } from './dashboardCharts'
import { escapeHtml, escapeHtmlAttr, oneOf } from './dashboardHtml'
import { CALLOUT_TONES, HERO_STATUSES, SECTION_TYPES } from './dashboardVocabulary'
import { inlineSpans } from './inlineMarkup'
import { own } from './ownEntry'
import { headerText, normalizeTableRows } from './tableRows'

// ─── Render helpers (shared across templates) ──────────────────────
//
// The schema cannot say which fields each template or block type needs, so
// every helper reads its input defensively. A part that cannot be read throws
// an error naming the field; the caller replaces that part with a notice and
// reports it, and the rest still renders.

export interface DashboardBranding {
  companyName?: string
  footerText?: string
}

/** State gathered while one dashboard renders. */
export interface DashRender {
  charts: DashboardCharts
  warnings: string[]
  sparklines: number
  drawSparklines: boolean
  skippedSparklines: number
  /** Parts that rendered, to tell a partial page from an empty one. */
  rendered: number
  /** Why each part that could not be shown failed. */
  failures: string[]
  /**
   * Argument paths the page shows that their schema may not declare: a list
   * read under its other name, and the fields of an entry it renders
   * (InternalToolResult.aliasedArguments).
   */
  aliased: string[]
}

const KPI_CARD_FIELDS = [
  'label',
  'value',
  'delta',
  'deltaDirection',
  'deltaSentiment',
  'accent',
  'sparkline',
] as const
const SERVICE_CARD_FIELDS = ['name', 'status', 'metric', 'delta', 'deltaDirection'] as const

/** Records the `fields` of `entry` a card shows (DashRender.aliased). */
function takenFields(
  ctx: DashRender,
  entry: Record<string, unknown>,
  at: string,
  fields: readonly string[]
): void {
  for (const key of fields) if (own(entry, key) !== undefined) ctx.aliased.push(`${at}.${key}`)
}

/**
 * Inline markdown as HTML, read by the reader the PDF and DOCX text uses, so
 * the page shows what the secret check before attaching it reads. Every text
 * is escaped, and a link keeps only an http(s) or mailto target.
 */
function renderInlineMd(s: string): string {
  return inlineSpans(s)
    .map(span => {
      let html = escapeHtml(span.text)
      if (span.code) html = `<code>${html}</code>`
      if (span.strike) html = `<s>${html}</s>`
      if (span.italics) html = `<em>${html}</em>`
      if (span.bold) html = `<strong>${html}</strong>`
      if (span.link !== undefined) {
        html = `<a href="${escapeHtml(span.link)}" rel="noopener noreferrer">${html}</a>`
      }
      return html
    })
    .join('')
}

export function isDashRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function describeDashValue(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return `a string (${JSON.stringify(value.slice(0, 40))})`
  return typeof value === 'object' ? 'an object' : `a ${typeof value} (${String(value)})`
}

export function dashRecord(value: unknown, where: string, shape: string): Record<string, unknown> {
  if (!isDashRecord(value)) {
    throw new Error(`${where} must be ${shape}; received ${describeDashValue(value)}.`)
  }
  return value
}

export function dashList(value: unknown, where: string, shape: string): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be an array of ${shape}; received ${describeDashValue(value)}.`)
  }
  return value
}

/** Text of a scalar; anything else reads as empty. */
export function dashText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : ''
}

/** One paragraph or a list of them, rejecting what would print as "[object Object]". */
function dashTextList(value: unknown, where: string): string[] {
  const items = Array.isArray(value) ? value : [value]
  const out = items.map((item, i) => {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      return String(item)
    }
    const at = Array.isArray(value) ? `${where}[${i}]` : where
    throw new Error(`${at} must be text; received ${describeDashValue(item)}.`)
  })
  if (out.every(t => t.trim() === '')) throw new Error(`${where} is empty; pass the text to show.`)
  return out
}

/** `body` under its heading, in one section so a printed page never ends on the heading. */
function titledSection(title: string | undefined, body: string): string {
  return title
    ? `<section class="section"><h2 class="section__title">${escapeHtml(title)}</h2>${body}</section>`
    : body
}

/** A number as a reader expects it: grouped, without floating-point noise. */
function formatDashNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString('en-US')
  return Math.abs(n) >= 1
    ? n.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : n.toLocaleString('en-US', { maximumSignificantDigits: 4 })
}

/** A figure: numbers are formatted, text is shown as written. */
function dashFigure(value: unknown): string {
  return typeof value === 'number' ? formatDashNumber(value) : dashText(value)
}

type DeltaDirection = 'up' | 'down' | 'neutral'

/** A delta's text and arrow; a numeric delta is signed and, unless told otherwise, points its own way. */
function dashDelta(
  delta: unknown,
  direction: unknown
): { text: string; direction: DeltaDirection } {
  const directions = ['up', 'down', 'neutral'] as const
  if (typeof delta !== 'number') {
    return { text: dashText(delta), direction: oneOf(direction, directions, 'neutral') }
  }
  const own = delta > 0 ? 'up' : delta < 0 ? 'down' : 'neutral'
  return {
    text: `${delta > 0 ? '+' : ''}${formatDashNumber(delta)}`,
    direction: oneOf(direction, directions, own),
  }
}

function deltaHtml(text: string, direction: DeltaDirection, sentiment: string): string {
  if (!text) return ''
  return `<p class="kpi-card__delta" data-direction="${direction}" data-sentiment="${sentiment}">${escapeHtml(text)}</p>`
}

function failureCallout(heading: string, message: string): string {
  return `<section class="section"><h2 class="section__title">${escapeHtml(heading)}</h2><div class="callout" data-tone="danger">${escapeHtml(message)}</div></section>`
}

function recordFailure(ctx: DashRender, where: string, e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  ctx.failures.push(message.includes(where) ? message : `${where}: ${message}`)
  return message
}

/**
 * Render one part of the page. A part that throws is replaced by a notice and
 * reported, so one malformed entry never takes the dashboard down. `counts`
 * is false for parts that are not content of their own (the hero, a divider)
 * and for parts that count their own entries (charts, card groups).
 */
export function dashPart(
  ctx: DashRender,
  where: string,
  counts: boolean,
  render: () => string
): string {
  try {
    const html = render()
    if (counts && html) ctx.rendered++
    return html
  } catch (e) {
    const message = recordFailure(ctx, where, e)
    return failureCallout(`${where} could not be shown`, message)
  }
}

/**
 * Render each entry of a card group on its own: a bad entry becomes a notice
 * in its place and the other cards stay. The group counts as content when at
 * least one entry rendered.
 */
function dashItems(
  ctx: DashRender,
  list: unknown[],
  where: string,
  render: (item: unknown, at: string) => string,
  notice: (message: string) => string
): string {
  let shown = 0
  const html = list
    .map((item, i) => {
      const at = `${where}[${i}]`
      try {
        const out = render(item, at)
        shown++
        return out
      } catch (e) {
        return notice(recordFailure(ctx, at, e))
      }
    })
    .join('\n')
  if (shown > 0) ctx.rendered++
  return html
}

const cardNotice = (message: string) =>
  `<div class="callout" data-tone="danger">${escapeHtml(message)}</div>`

export function renderHero(o: Record<string, unknown>): string {
  const eyebrowText = dashText(o.eyebrow)
  const eyebrow = eyebrowText ? `<div class="hero__eyebrow">${escapeHtml(eyebrowText)}</div>` : ''
  const status = oneOf(dashText(o.status).trim().toLowerCase(), HERO_STATUSES, 'neutral')
  const statusLabel = dashText(o.statusLabel) || status.toUpperCase()
  const statusBadge =
    o.status !== undefined || dashText(o.statusLabel)
      ? `<span class="status-badge" data-status="${status}">${escapeHtml(statusLabel)}</span>`
      : ''
  const headlineText = dashText(o.headline)
  const headline = headlineText
    ? `<p class="hero__headline">${renderInlineMd(headlineText)}</p>`
    : ''
  return `
<header class="hero" data-status="${status}">
  ${eyebrow}
  <h1 class="hero__title">${escapeHtml(dashText(o.title))}</h1>
  ${headline}
  ${statusBadge}
</header>`.trim()
}

function renderSparkline(value: unknown, where: string, ctx: DashRender): string {
  if (value === undefined || value === null) return ''
  if (!Array.isArray(value)) {
    ctx.warnings.push(`${where} must be an array of numbers; the trend was left out.`)
    return ''
  }
  const points = value.map(v => (v === null ? null : coerceNumber(v)))
  const values = points.filter((v): v is number | null => v !== undefined)
  if (values.filter(v => v !== null).length < 2) {
    ctx.warnings.push(`${where} needs at least two numbers to draw a trend; it was left out.`)
    return ''
  }
  if (!ctx.drawSparklines) {
    ctx.skippedSparklines++
    return ''
  }
  if (values.length < points.length) {
    ctx.warnings.push(`${where}: entries that were not numbers were left out of the trend.`)
  }
  return `<div class="kpi-card__sparkline-wrap"><canvas class="kpi-card__sparkline" id="sparkline-${ctx.sparklines++}" data-spark="${escapeHtmlAttr(
    JSON.stringify(values)
  )}"></canvas></div>`
}

const YEAR_LABEL = /\b(year|years|yr|fy|a[nñ]o|anio)\b/i

export function renderKpis(items: unknown, where: string, ctx: DashRender, title?: string): string {
  const kpis = dashList(items, where, 'KPI objects {label, value}')
  if (kpis.length === 0) return ''
  const cards = dashItems(
    ctx,
    kpis,
    where,
    (item, at) => {
      const kpi = dashRecord(item, at, 'a KPI object {label, value}')
      takenFields(ctx, kpi, at, KPI_CARD_FIELDS)
      // A year is not grouped: 2026, not 2,026. Only a figure that could be one
      // is taken for it; revenue per year is still grouped.
      const year =
        typeof kpi.value === 'number' &&
        Number.isInteger(kpi.value) &&
        kpi.value >= 1000 &&
        kpi.value <= 9999 &&
        YEAR_LABEL.test(dashText(kpi.label))
      const value = year ? String(kpi.value) : dashFigure(kpi.value)
      if (!value) {
        throw new Error(`${at}.value is missing; pass the figure to show, e.g. "$1.2M" or 48.`)
      }
      const { text, direction } = dashDelta(kpi.delta, kpi.deltaDirection)
      const sentiment = oneOf(
        kpi.deltaSentiment,
        ['good', 'bad', 'neutral'] as const,
        direction === 'up' ? 'good' : direction === 'down' ? 'bad' : 'neutral'
      )
      const delta = deltaHtml(text, direction, sentiment)
      const accent =
        kpi.accent === undefined
          ? ''
          : ` data-accent="${oneOf(kpi.accent, ['success', 'warning', 'danger', 'neutral'] as const, 'neutral')}"`
      return `
<div class="kpi-card"${accent}>
  <p class="kpi-card__label">${escapeHtml(dashText(kpi.label))}</p>
  <p class="kpi-card__value">${escapeHtml(value)}</p>
  ${delta}
  ${renderSparkline(kpi.sparkline, `${at}.sparkline`, ctx)}
</div>`.trim()
    },
    cardNotice
  )
  return titledSection(title, `<section class="kpi-grid">${cards}</section>`)
}

export function renderChartCards(
  charts: unknown,
  where: string,
  ctx: DashRender,
  title?: string
): string {
  const list = dashList(charts, where, 'chart objects {type, labels, datasets}')
  if (list.length === 0) return ''
  const cards = list.map((chart, i) => ctx.charts.card(chart, `${where}[${i}]`)).join('\n')
  return titledSection(title, `<section class="chart-grid">${cards}</section>`)
}

const BADGE_COLUMN_TYPES = new Set(['severity', 'priority', 'status'])
const COLUMN_TYPES = new Set(['plain', ...BADGE_COLUMN_TYPES])

function dashSeverityClass(value: unknown): string {
  const v = String(value ?? '')
    .trim()
    .toLowerCase()
  const map: Record<string, string> = {
    critical: 'severity-critical',
    high: 'severity-high',
    med: 'severity-med',
    medium: 'severity-med',
    low: 'severity-low',
    info: 'severity-info',
    p0: 'severity-p0',
    p1: 'severity-p1',
    p2: 'severity-p2',
    healthy: 'severity-low',
    degraded: 'severity-med',
    down: 'severity-critical',
    operational: 'severity-low',
    incident: 'severity-high',
  }
  return own(map, v) ?? ''
}

export function renderTableHtml(
  t: unknown,
  where: string,
  ctx: DashRender,
  title?: string
): string {
  const table = dashRecord(t, where, 'a table object {headers, rows}')
  const headers = table.headers
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new Error(`${where}.headers must be a non-empty array of column names.`)
  }
  const colTypes = isDashRecord(table.columnTypes) ? table.columnTypes : {}
  for (const [column, type] of Object.entries(colTypes)) {
    if (!COLUMN_TYPES.has(String(type))) {
      ctx.warnings.push(
        `${where}.columnTypes[${JSON.stringify(column)}] ${JSON.stringify(type)} is not a column ` +
          'type (plain, severity, priority, status), so that column shows as plain text.'
      )
    }
  }
  const headerNames = headers.map(headerText)
  const headerHtml = headerNames.map(h => `<th>${softBreaks(escapeHtml(h))}</th>`).join('')
  const rows = fitRowsToHeaders(
    normalizeTableRows(table.rows, headers, where, ctx.warnings),
    headers.length,
    where,
    ctx
  )
  let structured = 0
  const bodyHtml = rows
    .map(row => {
      const cells = row
        .map((cell, c) => {
          const colType = own(colTypes, String(c)) ?? own(colTypes, headerNames[c])
          if (cell !== null && typeof cell === 'object') structured++
          const text = tableCellText(cell)
          const cls = BADGE_COLUMN_TYPES.has(String(colType)) ? dashSeverityClass(text) : ''
          return cls
            ? `<td><span class="severity-badge ${cls}">${escapeHtml(text)}</span></td>`
            : `<td>${softBreaks(renderInlineMd(text))}</td>`
        })
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('\n')

  if (structured > 0) {
    ctx.warnings.push(
      `${where}: ${structured} cell(s) held an object or a list and are shown as text; ` +
        'send one value per cell.'
    )
  }
  return titledSection(
    title ?? (dashText(table.title) || undefined),
    `
<div class="data-table-wrap">
  <table class="data-table${headers.length > WIDE_TABLE_COLUMNS ? ' data-table--wide' : ''}">
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table>
</div>`.trimEnd()
  )
}

/**
 * A table cell as text. Numbers print as written, without the float noise of
 * 0.1 + 0.2 and without grouping, since a table column may hold years or IDs.
 */
function tableCellText(cell: unknown): string {
  if (typeof cell === 'number') {
    return Number.isInteger(cell) ? String(cell) : String(Number(cell.toPrecision(12)))
  }
  if (Array.isArray(cell)) return cell.map(tableCellText).join(', ')
  if (cell !== null && typeof cell === 'object') return JSON.stringify(cell)
  return dashText(cell)
}

/** Above this many columns a printed table breaks words anywhere so every column fits the page. */
const WIDE_TABLE_COLUMNS = 8

const SOFT_BREAK_AFTER = new Set(['&#x2F;', '.', '-', '_', '?', '&amp;', '=', ',', ':'])

/**
 * `html` with a line-break opportunity inside each long unbroken run of text,
 * after punctuation or every 10 characters, so a URL or an ID wraps instead of
 * widening its column. Words of ordinary length keep their width.
 */
function softBreaks(html: string): string {
  return html.replace(/(<[^>]*>)|((?:&[#\w]+;|[^\s<&])+)/gu, (match, tag: string | undefined) => {
    if (tag) return match
    const units = match.match(/&[#\w]+;|[^]/gu) ?? []
    if (units.length < 16) return match
    let out = ''
    let run = 0
    units.forEach((unit, i) => {
      out += unit
      run++
      if (i < units.length - 1 && (SOFT_BREAK_AFTER.has(unit) || run >= 10)) {
        out += '<wbr>'
        run = 0
      }
    })
    return out
  })
}

/** Whether a cell holds a value: anything but blank text, null or nothing, an object or list included. */
function holdsValue(cell: unknown): boolean {
  return (cell !== null && typeof cell === 'object') || dashText(cell).trim() !== ''
}

/** Each row cut or padded to one cell per header, reporting cells that held a value and were cut. */
function fitRowsToHeaders(
  rows: unknown[][],
  width: number,
  where: string,
  ctx: DashRender
): unknown[][] {
  let padded = 0
  const cut: string[] = []
  const fitted = rows.map((row, r) => {
    if (row.length < width) {
      padded++
      return [...row, ...Array<string>(width - row.length).fill('')]
    }
    if (row.slice(width).some(holdsValue)) {
      cut.push(
        `${where}.rows[${r}] has ${row.length} cells for ${width} headers; the extra ` +
          `${row.length - width} ${row.length - width === 1 ? 'was' : 'were'} left out.`
      )
    }
    return row.slice(0, width)
  })
  if (cut.length > 0) {
    const more = cut.length > 1 ? ` ${cut.length - 1} more row(s) had extra cells too.` : ''
    ctx.warnings.push(`${cut[0]}${more} Add headers for them or drop them.`)
  }
  if (padded > 0) {
    ctx.warnings.push(
      `${where}: ${padded} row(s) have fewer cells than the ${width} headers and end in empty cells.`
    )
  }
  return fitted
}

export function renderSectionHtml(s: unknown, where: string): string {
  const section = dashRecord(s, where, 'a section object {type, content}')
  if (section.type !== undefined && !SECTION_TYPES.includes(section.type as never)) {
    throw new Error(`${where}.type must be one of: ${SECTION_TYPES.join(', ')}.`)
  }
  const type = oneOf(section.type, SECTION_TYPES, 'narrative')
  const content = dashTextList(section.content, `${where}.content`)
  const titleText = dashText(section.title)
  const title = titleText ? `<h2 class="section__title">${escapeHtml(titleText)}</h2>` : ''
  let body: string
  if (type === 'narrative') {
    body = `<div class="narrative">${content.map(p => `<p>${renderInlineMd(p)}</p>`).join('\n')}</div>`
  } else if (type === 'bullets') {
    body = `<ul class="bullets">${content.map(b => `<li>${renderInlineMd(b)}</li>`).join('')}</ul>`
  } else if (type === 'callout') {
    const tone = oneOf(section.tone, CALLOUT_TONES, 'info')
    body = `<div class="callout" data-tone="${tone}">${renderInlineMd(content.join('\n'))}</div>`
  } else {
    const language = dashText(section.language)
    const lang = language ? `<div class="code-block__lang">${escapeHtml(language)}</div>` : ''
    body = `<div class="code-block">${lang}<pre><code>${escapeHtml(content.join('\n'))}</code></pre></div>`
  }
  return `<section class="section">${title}${body}</section>`
}

const SERVICE_STATUSES = ['healthy', 'degraded', 'down', 'maintenance'] as const

/** Status words models use, by the card color they mean. */
/** The entry `words` has for `text`, ignoring case; never one inherited from Object. */
function ownWord<T>(words: Partial<Record<string, T>>, text: string): T | undefined {
  return own(words, text.toLowerCase())
}

const SERVICE_STATUS_WORDS: Partial<Record<string, (typeof SERVICE_STATUSES)[number]>> = {
  healthy: 'healthy',
  ok: 'healthy',
  up: 'healthy',
  operational: 'healthy',
  online: 'healthy',
  green: 'healthy',
  degraded: 'degraded',
  warning: 'degraded',
  partial: 'degraded',
  yellow: 'degraded',
  down: 'down',
  outage: 'down',
  offline: 'down',
  failed: 'down',
  red: 'down',
  maintenance: 'maintenance',
}

export function renderServiceHealthGrid(
  services: unknown,
  where: string,
  ctx: DashRender,
  title?: string
): string {
  const list = dashList(services, where, 'service objects {name, status}')
  if (list.length === 0) return ''
  const cards = dashItems(
    ctx,
    list,
    where,
    (item, at) => {
      const s = dashRecord(item, at, 'a service object {name, status}')
      const name = dashText(s.name)
      if (!name) throw new Error(`${at}.name is missing; pass the service name.`)
      const statusText = dashText(s.status).trim() || 'unknown'
      const status = ownWord(SERVICE_STATUS_WORDS, statusText) ?? 'unknown'
      if (status === 'unknown' && statusText.toLowerCase() !== 'unknown') {
        ctx.warnings.push(
          `${at}.status ${JSON.stringify(statusText)} is not healthy, degraded, down or ` +
            'maintenance, so the card is grey.'
        )
      }
      const { text, direction } = dashDelta(s.delta, s.deltaDirection)
      const sentiment = direction === 'up' ? 'good' : direction === 'down' ? 'bad' : 'neutral'
      const delta = deltaHtml(text, direction, sentiment)
      const metric = dashFigure(s.metric)
      // The fields a card shows, whichever list the entries came under.
      takenFields(ctx, s, at, SERVICE_CARD_FIELDS)
      return `
<div class="health-card" data-status="${status}">
  <div class="health-card__head">
    <span class="health-card__dot"></span>
    <h3 class="health-card__name">${escapeHtml(name)}</h3>
  </div>
  <p class="health-card__status">${escapeHtml(statusText.toUpperCase())}</p>
  ${metric ? `<p class="health-card__metric">${escapeHtml(metric)}</p>` : ''}
  ${delta}
</div>`.trim()
    },
    cardNotice
  )
  return titledSection(title, `<section class="health-grid">${cards}</section>`)
}

const INCIDENT_SEVERITIES = ['critical', 'high', 'med', 'low', 'info'] as const

/** Severity words models use, by the color they take; p0-p2 match the table badges. */
const SEVERITY_WORDS: Partial<Record<string, (typeof INCIDENT_SEVERITIES)[number]>> = {
  critical: 'critical',
  p0: 'critical',
  high: 'high',
  major: 'high',
  p1: 'high',
  med: 'med',
  medium: 'med',
  moderate: 'med',
  low: 'low',
  minor: 'low',
  p2: 'low',
  info: 'info',
}

export function renderIncidentsTimeline(
  items: unknown,
  where: string,
  ctx: DashRender,
  title?: string
): string {
  const list = dashList(items, where, 'incident objects {time, title}')
  if (list.length === 0) return ''
  const html = dashItems(
    ctx,
    list,
    where,
    (item, at) => {
      const it = dashRecord(item, at, 'an incident object {time, title}')
      const time = dashText(it.time)
      const heading = dashText(it.title)
      if (!time && !heading) {
        throw new Error(
          `${at} needs a time and a title, e.g. {"time": "10:42", "title": "API errors"}.`
        )
      }
      const given = dashText(it.severity).trim()
      const sev = ownWord(SEVERITY_WORDS, given) ?? 'info'
      if (given && !ownWord(SEVERITY_WORDS, given)) {
        ctx.warnings.push(
          `${at}.severity ${JSON.stringify(given)} is not critical, high, medium, low or info, ` +
            'so it is shown in the info color.'
        )
      }
      const resolvedAt = dashText(it.resolvedAt)
      const resolved = resolvedAt
        ? `<span class="timeline-item__resolved">resolved ${escapeHtml(resolvedAt)}</span>`
        : `<span class="timeline-item__open">open</span>`
      const description = dashText(it.description)
      const desc = description
        ? `<p class="timeline-item__desc">${renderInlineMd(description)}</p>`
        : ''
      return `
<li class="timeline-item" data-severity="${sev}">
  <div class="timeline-item__time">${escapeHtml(time)}</div>
  <div class="timeline-item__body">
    <div class="timeline-item__head">
      <span class="severity-badge severity-${sev}">${escapeHtml((given || sev).toUpperCase())}</span>
      <h4 class="timeline-item__title">${escapeHtml(heading)}</h4>
      ${resolved}
    </div>
    ${desc}
  </div>
</li>`.trim()
    },
    message =>
      `<li class="timeline-item"><div class="timeline-item__time"></div>${cardNotice(message)}</li>`
  )
  return titledSection(title, `<ol class="timeline">${html}</ol>`)
}

/** meta.date as shown; a number of 10+ digits is a Unix timestamp (seconds or ms), a shorter one a year. */
function footerDate(value: unknown): string {
  const long = { year: 'numeric', month: 'long', day: 'numeric' } as const
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) >= 1e9) {
    const ms = Math.abs(value) < 1e11 ? value * 1000 : value
    return new Date(ms).toLocaleDateString('en-US', { ...long, timeZone: 'UTC' })
  }
  return dashText(value) || new Date().toLocaleDateString('en-US', long)
}

export function renderDashboardFooter(meta: unknown, branding: DashboardBranding): string {
  const m: Record<string, unknown> = isDashRecord(meta) ? meta : {}
  const companyName = dashText(branding.companyName)
  const left = companyName
    ? `<span class="dash-footer__brand">${escapeHtml(companyName)}</span>`
    : ''
  const right = [
    dashText(branding.footerText),
    dashText(m.author),
    dashText(m.runId),
    footerDate(m.date),
  ]
    .filter(part => part.trim() !== '')
    .map(escapeHtml)
    .join(' · ')
  return `<footer class="dash-footer">${left}<span>${right}</span></footer>`
}
