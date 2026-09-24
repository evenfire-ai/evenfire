/**
 * Chart.js plugins that put the numbers on the chart itself.
 *
 * A chart whose values can only be read off an axis degrades badly: shrunk into
 * a report page, or rendered where a tick label is missing, it stops carrying
 * information. These plugins print the value at each mark, the share on each
 * slice, and the reading inside a gauge, so the picture stays legible on its
 * own. They are written against the Chart.js element geometry rather than a
 * plugin package, so nothing is added to the dependency tree.
 */
import type { Chart, ChartType, Plugin } from 'chart.js'
import { CHART_FONT_STACK } from './fonts'

export type ValueFormat = 'auto' | 'plain' | 'compact' | 'currency' | 'percent'

export interface ValueLabelOptions {
  format: ValueFormat
  /** Prefix for `currency`, e.g. "$" or "€". */
  currencySymbol?: string
  decimals?: number
  textColor: string
  backgroundColor: string
  /** 'y' when bars grow horizontally, which moves labels past the bar end. */
  indexAxis?: 'x' | 'y'
  /** Multiplier tying label type to the canvas size, as the axes use. */
  fontScale?: number
}

/** Below this, money is grouped in full rather than abbreviated. */
const CURRENCY_ABBREVIATE_FROM = 100_000

const COMPACT_STEPS: Array<[number, string]> = [
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'K'],
]

/** Render one number the way a reader expects to see it on a chart. */
export function formatValue(value: number, o: ValueLabelOptions): string {
  if (!Number.isFinite(value)) return ''
  const decimals = o.decimals
  // A count the caller set prints exactly; a count guessed per value drops its
  // trailing zeros, so 45% does not read as 45.0%.
  const fixed = (n: number, d: number): string =>
    decimals !== undefined
      ? n.toFixed(d)
      : n
          .toFixed(d)
          .replace(/\.0+$/, '')
          .replace(/(\.\d*?)0+$/, '$1')

  switch (o.format) {
    case 'percent':
      return `${fixed(value, decimals ?? 1)}%`
    case 'currency': {
      const sym = o.currencySymbol ?? '$'
      const abs = Math.abs(value)
      const sign = value < 0 ? '-' : ''
      // Money reads better grouped until it gets long: $1,200 beats $1.2K,
      // while $120K beats $120,000 on a crowded axis.
      if (abs >= CURRENCY_ABBREVIATE_FROM) {
        for (const [step, suffix] of COMPACT_STEPS) {
          if (abs >= step) return `${sign}${sym}${fixed(abs / step, decimals ?? 1)}${suffix}`
        }
      }
      // Unless a count is set, cents are kept, both places: $4.99 must not read
      // as $5, nor $4.90 as $4.9.
      const places = decimals ?? (Number.isInteger(abs) ? 0 : Math.max(2, guessDecimals(abs)))
      const shown =
        decimals === undefined && places > 0
          ? abs.toFixed(places).replace(/(\.\d\d\d*?)0+$/, '$1')
          : fixed(abs, places)
      return `${sign}${sym}${group(shown)}`
    }
    case 'compact': {
      const abs = Math.abs(value)
      for (const [step, suffix] of COMPACT_STEPS) {
        if (abs >= step)
          return `${value < 0 ? '-' : ''}${fixed(abs / step, decimals ?? 1)}${suffix}`
      }
      return fixed(value, decimals ?? guessDecimals(value))
    }
    case 'plain':
      return group(fixed(value, decimals ?? guessDecimals(value)))
    case 'auto':
    default:
      return Math.abs(value) >= 10_000
        ? formatValue(value, { ...o, format: 'compact' })
        : group(fixed(value, decimals ?? guessDecimals(value)))
  }
}

/**
 * Enough decimal places for the value to survive rounding: a fixed count prints
 * 0.0012 as "0", so values below 1 get places by their order of magnitude.
 */
function guessDecimals(value: number): number {
  if (Number.isInteger(value)) return 0
  const abs = Math.abs(value)
  if (abs >= 10) return 1
  if (abs >= 1) return 2
  if (abs === 0) return 0
  // Two significant figures: 0.0012 -> 4 places, 0.5 -> 2.
  return Math.min(8, 1 - Math.floor(Math.log10(abs)))
}

function group(text: string): string {
  const [int, frac] = text.split('.')
  const sign = int.startsWith('-') ? '-' : ''
  const digits = sign ? int.slice(1) : int
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}${frac ? `.${frac}` : ''}`
}

/** Elements smaller than this are left unlabelled — the text would not fit. */
const MIN_ARC_SHARE = 0.04

/** Roughly how many value labels fit across a plot before they collide. */
const READABLE_LABEL_COUNT = 14

/**
 * Label every `stride`-th point. Returns 0 when the series is so dense that
 * even thinned labels would be noise rather than information.
 */
function labelStride(points: number): number {
  if (points <= READABLE_LABEL_COUNT) return 1
  const stride = Math.ceil(points / READABLE_LABEL_COUNT)
  return stride <= 3 ? stride : 0
}

interface Point {
  x: number
  y: number
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/**
 * The column of a radial scale's tick labels, which runs straight up from the
 * centre of a polar area chart. Undefined on charts without one.
 */
function radialTickColumn(chart: Chart): Box | undefined {
  const r = (chart.scales as Record<string, unknown> | undefined)?.r as
    | {
        xCenter?: number
        yCenter?: number
        drawingArea?: number
        ticks?: Array<{ label?: unknown }>
        options?: { ticks?: { display?: boolean } }
      }
    | undefined
  if (!r || r.options?.ticks?.display === false) return undefined
  const { xCenter, yCenter, drawingArea } = r
  if (xCenter === undefined || yCenter === undefined || drawingArea === undefined) return undefined
  const widest = Math.max(
    0,
    ...(r.ticks ?? []).map(t => chart.ctx.measureText(String(t.label ?? '')).width)
  )
  const half = widest / 2 + 6
  return {
    left: xCenter - half,
    right: xCenter + half,
    top: yCenter - drawingArea - 12,
    bottom: yCenter,
  }
}

/** The rectangle of every drawn bar, with the element it belongs to. */
function barBoxes(chart: Chart, horizontal: boolean): Array<Box & { element: unknown }> {
  const out: Array<Box & { element: unknown }> = []
  chart.data.datasets.forEach((_, di) => {
    const meta = chart.getDatasetMeta(di)
    if (meta.hidden) return
    for (const element of meta.data) {
      const el = element as {
        x?: number
        y?: number
        base?: number
        width?: number
        height?: number
      }
      const thickness = horizontal ? el.height : el.width
      if (el.x === undefined || el.y === undefined || el.base === undefined) continue
      if (typeof thickness !== 'number' || !(thickness > 0)) continue
      out.push(
        horizontal
          ? {
              element,
              left: Math.min(el.x, el.base),
              right: Math.max(el.x, el.base),
              top: el.y - thickness / 2,
              bottom: el.y + thickness / 2,
            }
          : {
              element,
              left: el.x - thickness / 2,
              right: el.x + thickness / 2,
              top: Math.min(el.y, el.base),
              bottom: Math.max(el.y, el.base),
            }
      )
    }
  })
  return out
}

/** The legend and title boxes, which value labels must not print over. */
function reservedBoxes(chart: Chart): Box[] {
  const blocks = [
    (chart as { legend?: Partial<Box> }).legend,
    (chart as { titleBlock?: Partial<Box> }).titleBlock,
  ]
  return blocks.filter(
    (b): b is Box =>
      b !== undefined &&
      [b.left, b.top, b.right, b.bottom].every(v => typeof v === 'number') &&
      b.right! > b.left! &&
      b.bottom! > b.top!
  )
}

function isArcChart(type: ChartType | string): boolean {
  return type === 'pie' || type === 'doughnut' || type === 'polarArea'
}

/** Perceived lightness of a #rgb/#rrggbb fill, 0 (black) to 1 (white). */
function luminance(color: string): number | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!hex) return undefined
  let body = hex[1]
  if (body.length === 3)
    body = body
      .split('')
      .map(c => c + c)
      .join('')
  const r = parseInt(body.slice(0, 2), 16) / 255
  const g = parseInt(body.slice(2, 4), 16) / 255
  const b = parseInt(body.slice(4, 6), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The fill this element was drawn with, when it resolves to a single color. */
function elementFill(element: unknown, index: number): string | undefined {
  const opts = (element as { options?: { backgroundColor?: unknown } }).options
  const bg = opts?.backgroundColor
  if (typeof bg === 'string') return bg
  if (Array.isArray(bg)) {
    const c = bg[index % bg.length]
    return typeof c === 'string' ? c : undefined
  }
  return undefined
}

/**
 * Draw each value beside its mark. Slice charts additionally get their share of
 * the total, which is the number a reader of a pie actually wants.
 */
export function valueLabelsPlugin(options: ValueLabelOptions): Plugin {
  return {
    id: 'clerumValueLabels',
    // After everything else, so scale ticks drawn above the data do not cover them.
    afterDraw(chart: Chart) {
      try {
        drawValueLabels(chart, options)
      } catch {
        // A label is an enhancement; never let it cost the whole render.
      }
    },
  }
}

function drawValueLabels(chart: Chart, o: ValueLabelOptions): void {
  const { ctx } = chart
  const arcs = isArcChart((chart.config as { type?: ChartType }).type ?? 'bar')

  // Each ring of a pie or doughnut is a whole of its own.
  const totals = chart.data.datasets.map(ds =>
    arcs
      ? (ds.data ?? []).reduce<number>(
          (sum, v) => sum + (typeof v === 'number' ? Math.abs(v) : 0),
          0
        )
      : 0
  )

  const points = chart.data.datasets.reduce((n, d) => n + (d.data?.length ?? 0), 0)
  const stride = labelStride(points)
  if (stride === 0) return

  const size = Math.round(12 * (o.fontScale ?? 1))
  // Labels of different series can land on the same spot; the first one drawn
  // keeps it. In a bar chart a label may cover its own bar, never another.
  const taken = reservedBoxes(chart)
  const bars = arcs ? [] : barBoxes(chart, o.indexAxis === 'y')
  ctx.save()
  const ticks = arcs ? radialTickColumn(chart) : undefined
  ctx.font = `600 ${size}px ${CHART_FONT_STACK}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  chart.data.datasets.forEach((dataset, di) => {
    const meta = chart.getDatasetMeta(di)
    if (meta.hidden) return

    const total = totals[di]
    meta.data.forEach((element, ei) => {
      // Keep the first and last of a thinned series so the range stays readable.
      if (stride > 1 && ei % stride !== 0 && ei !== meta.data.length - 1) return
      const raw = dataset.data[ei]
      const value = typeof raw === 'number' ? raw : readY(raw)
      if (value === null) return

      let text = formatValue(value, o)
      if (arcs && total > 0) {
        text = `${text} (${((Math.abs(value) / total) * 100).toFixed(0)}%)`
      }
      if (!text) return

      if (arcs && total > 0 && Math.abs(value) / total < MIN_ARC_SHARE) return
      const half = ctx.measureText(text).width / 2 + 2
      const spot = labelSpot(chart, element, arcs, o.indexAxis === 'y', half)
      if (!spot) return
      const box = {
        left: spot.x - half,
        right: spot.x + half,
        top: spot.y - size / 2 - 1,
        bottom: spot.y + size / 2 + 1,
      }
      // A label on the tick column moves to the side of it its slice is on.
      if (ticks && intersects(box, ticks)) {
        const shift =
          spot.x < (ticks.left + ticks.right) / 2 ? ticks.left - box.right : ticks.right - box.left
        box.left += shift
        box.right += shift
        spot.x += shift
      }
      if (taken.some(other => intersects(box, other))) return
      if (bars.some(bar => bar.element !== element && intersects(box, bar))) return
      taken.push(box)

      // A label that lands on top of a filled slice has to invert; one that
      // sits in open plot area keeps the theme color over a halo of the ground.
      let ink = o.textColor
      let halo = o.backgroundColor
      if (arcs) {
        const light = luminance(elementFill(element, ei) ?? '')
        if (light !== undefined) {
          ink = light < 0.5 ? '#ffffff' : '#0f172a'
          halo = light < 0.5 ? '#00000055' : '#ffffff99'
        }
      }

      ctx.lineWidth = 3
      ctx.strokeStyle = halo
      ctx.strokeText(text, spot.x, spot.y)
      ctx.fillStyle = ink
      ctx.fillText(text, spot.x, spot.y)
    })
  })

  ctx.restore()
}

function readY(raw: unknown): number | null {
  // A floating bar is stored as [from, to]; the number worth printing is the
  // step it spans, which is what a waterfall is read for.
  if (Array.isArray(raw) && raw.length === 2) {
    const from = Number(raw[0])
    const to = Number(raw[1])
    return Number.isFinite(from) && Number.isFinite(to) ? to - from : null
  }
  if (raw && typeof raw === 'object' && 'y' in raw) {
    const y = (raw as { y: unknown }).y
    return typeof y === 'number' ? y : null
  }
  return null
}

/** Where the number goes for this element, in canvas coordinates. */
function labelSpot(
  chart: Chart,
  element: unknown,
  arcs: boolean,
  horizontal: boolean,
  halfWidth: number
): Point | undefined {
  const el = element as {
    x?: number
    y?: number
    base?: number
    getCenterPoint?: () => Point
  }

  if (arcs) {
    const centre = el.getCenterPoint?.()
    return centre ? { x: centre.x, y: centre.y } : undefined
  }

  if (el.x === undefined || el.y === undefined) return undefined
  const area = chart.chartArea

  // A horizontal bar grows along x, so its number sits just past the bar end.
  if (horizontal) {
    const outward = el.base !== undefined && el.x < el.base ? -(halfWidth + 6) : halfWidth + 6
    return { x: clampTo(el.x + outward, halfWidth, chart.width - halfWidth), y: el.y }
  }

  // Vertical bars and line points read best just above the mark; a negative bar
  // grows downward, so its label goes below.
  const offset = el.base !== undefined && el.y > el.base ? 14 : -12
  return {
    // Clamped against the canvas rather than the plot: a label on the first or
    // last mark sits over the axis gutter, but must not leave the image.
    x: clampTo(el.x, halfWidth, chart.width - halfWidth),
    y: clampTo(el.y + offset, area.top + 9, area.bottom - 9),
  }
}

function clampTo(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/** Color distance below which two slice colors read as the same. */
const MIN_COLOR_DISTANCE = 48

function rgb(color: string): [number, number, number] | undefined {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1]
  if (!hex) return undefined
  return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

function mix(color: string, toward: string, share: number): string | undefined {
  const a = rgb(color)
  const b = rgb(toward)
  if (!a || !b) return undefined
  return `#${a
    .map((c, i) => Math.round(c + (b[i] - c) * share))
    .map(c => c.toString(16).padStart(2, '0'))
    .join('')}`
}

function distance(a: string, b: string): number {
  const x = rgb(a)
  const y = rgb(b)
  if (!x || !y) return a === b ? 0 : Infinity
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

/**
 * One fill per slice: the caller's colors first, then the palette, then the
 * palette shaded toward and away from the background, skipping shades too close
 * to a color already used. Only when those run out do colors repeat, and then
 * never on the last slice, which sits beside the first.
 */
export function sliceColors(
  count: number,
  requested: string[] | undefined,
  palette: string[],
  background: string
): { colors: string[]; padded: boolean; repeated: boolean } {
  const own = (requested ?? []).filter(c => typeof c === 'string').slice(0, count)
  const light = (rgb(background) ?? [255, 255, 255]).reduce((sum, c) => sum + c, 0) > 382
  const shades = [
    ...palette.map(c => mix(c, background, 0.45)),
    ...palette.map(c => mix(c, light ? '#000000' : '#ffffff', 0.4)),
    ...palette.map(c => mix(c, background, 0.7)),
  ].filter((c): c is string => c !== undefined)
  const pool = [...own]
  for (const candidate of [...palette, ...shades]) {
    if (pool.length >= count) break
    if (pool.every(used => distance(used, candidate) >= MIN_COLOR_DISTANCE)) pool.push(candidate)
  }
  const distinct = pool.length
  const colors = Array.from({ length: count }, (_, i) => pool[i % distinct])
  if (count > distinct && count > 1 && colors[count - 1] === colors[0]) {
    colors[count - 1] = pool[Math.min(1, distinct - 1)]
  }
  return {
    colors,
    padded: requested !== undefined && own.length < count,
    repeated: count > distinct,
  }
}

export interface GaugeCenterOptions {
  value: number
  max: number
  textColor: string
  mutedColor: string
  format: ValueLabelOptions
}

/**
 * Print the reading inside the dial. Without it a gauge shows a coloured arc
 * and no number, which is the one thing a gauge exists to communicate.
 */
export function gaugeCenterPlugin(o: GaugeCenterOptions): Plugin {
  return {
    id: 'clerumGaugeCenter',
    afterDatasetsDraw(chart: Chart) {
      try {
        const { ctx, chartArea } = chart
        const cx = (chartArea.left + chartArea.right) / 2
        // The dial is a half circle, so its visual centre sits low in the box.
        const cy = chartArea.bottom - (chartArea.bottom - chartArea.top) * 0.12
        const size = Math.max(18, Math.min(52, (chartArea.right - chartArea.left) / 9))

        ctx.save()
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = o.textColor
        ctx.font = `700 ${size}px ${CHART_FONT_STACK}`
        ctx.fillText(formatValue(o.value, o.format), cx, cy)
        ctx.fillStyle = o.mutedColor
        ctx.font = `500 ${Math.round(size * 0.42)}px ${CHART_FONT_STACK}`
        // Neutral rather than an English word: the caller's title and labels
        // may be in any language, and this sits inside the same picture.
        ctx.fillText(`/ ${formatValue(o.max, o.format)}`, cx, cy + size * 0.62)
        ctx.restore()
      } catch {
        // Enhancement only.
      }
    },
  }
}

/** Paint the theme background behind the plot. */
export function backgroundPlugin(color: string): Plugin {
  return {
    id: 'clerumBackground',
    beforeDraw(chart: Chart) {
      const { ctx } = chart
      ctx.save()
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = color
      ctx.fillRect(0, 0, chart.width, chart.height)
      ctx.restore()
    },
  }
}

/**
 * State the chart is empty instead of writing out a blank rectangle, so a
 * dataset that reduced to nothing is visible as such in the report.
 */
export function emptyStatePlugin(message: string, textColor: string): Plugin {
  return {
    id: 'clerumEmptyState',
    afterDraw(chart: Chart) {
      const { ctx, chartArea } = chart
      ctx.save()
      ctx.fillStyle = textColor
      ctx.font = `500 14px ${CHART_FONT_STACK}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(
        message,
        (chartArea.left + chartArea.right) / 2,
        (chartArea.top + chartArea.bottom) / 2
      )
      ctx.restore()
    },
  }
}
