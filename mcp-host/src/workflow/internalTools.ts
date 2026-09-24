/**
 * Internal output tools for workflow step execution.
 *
 * Available to all workflows — no MCP server required. Each tool produces
 * a document artifact (markdown, PDF, DOCX, XLSX, PPTX, PNG chart, HTML
 * dashboard) and writes it to the output directory (/output when mounted
 * from a PVC, /tmp/clerum-output otherwise).
 *
 * All libraries are pure-JS (no native deps, no headless browser):
 *   pdfmake (PDF), docx (DOCX), exceljs (XLSX), pptxgenjs (PPTX),
 *   chart.js + @napi-rs/canvas (PNG charts), built-in string write
 *   for markdown and the dashboard HTML wrapper.
 */
import { type SKRSContext2D, createCanvas } from '@napi-rs/canvas'
import {
  Chart,
  type ChartConfiguration,
  type ChartType,
  type Plugin,
  type Scale,
  registerables,
} from 'chart.js'
import {
  AlignmentType,
  Document as DocxDocument,
  Footer as DocxFooter,
  Header as DocxHeader,
  Table as DocxTable,
  HeadingLevel,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  TextRun,
} from 'docx'
import ExcelJS from 'exceljs'
import * as fs from 'fs'
import * as path from 'path'
import type { Content, ContentText, Node, TDocumentDefinitions } from 'pdfmake/interfaces'
import { config } from '../config'
import { WorkflowListTool, WorkflowStatusTool } from '../core/tools/workflowReadTools'
import { WorkflowTriggerTool } from '../core/tools/workflowTriggerTool'
import { artifactResult, claimOutputFile, outputFilename, replacedBytes } from './artifactOutput'
import { ChartDataError, coerceNumber, normalizeChartData } from './chartData'
import type { NormalizedDataset, NormalizedPoint } from './chartData'
import {
  type ValueFormat,
  type ValueLabelOptions,
  backgroundPlugin,
  emptyStatePlugin,
  formatValue,
  gaugeCenterPlugin,
  sliceColors,
  valueLabelsPlugin,
} from './chartPlugins'
import { CONTEXT_FILES_TOOLS, loadContextFilesMounts } from './contextFiles'
import { DASHBOARD_CHART_TYPES, DashboardCharts } from './dashboardCharts'
import { escapeHtml, oneOf } from './dashboardHtml'
import { dashboardScript } from './dashboardScript'
import {
  DASHBOARD_THEMES,
  type DashboardTheme,
  type DashboardThemeColors,
  type ThemeName,
} from './dashboardThemes'
import { type DocxImagePlacement, docxImageParagraph } from './docxImages'
import { textRuns } from './docxInline'
import { bodyHasText, bodyToDocxChildren } from './docxMarkdown'
import {
  DOCX_COMPLEX_FONT,
  DOCX_LATIN_FONT,
  documentEastAsianScript,
  docxDirection,
  eastAsianScript,
} from './docxScript'
import { DOCX_PALETTES, DocxListNumbering, docxHex } from './docxStyle'
import { buildDocxTable, docxSections } from './docxTable'
import {
  PNG_BASE_PPM,
  fitImageBox,
  fitImageSize,
  imageDataUrl,
  loadEmbeddableImage,
  predecodeImages,
} from './embeddedImages'
import {
  CHART_FONT_STACK,
  PDF_FONT_FAMILY,
  PDF_MONO_FAMILY,
  ensureFontsReady,
  pdfGlyphSource,
  sanitizeForFont,
} from './fonts'
import {
  closesFence,
  htmlToPlainLines,
  htmlToPlainText,
  inlineSpans,
  openingFence,
  quoteParagraphs,
  withoutClosingHashes,
} from './inlineMarkup'
import {
  BODY_FONT_SIZE,
  MIN_BOTTOM_MARGIN,
  PORTRAIT,
  type UnitMeasure,
  layoutPdfTable,
} from './pdfTables'
import { LINE_FILL, PdfTypesetter } from './pdfText'
import { NATIVE_CHART_TYPES } from './pptxCharts'
import { PPTX_ASPECT_RATIOS, PPTX_PALETTES, buildPptxDeck } from './pptxDeck'
import { SLIDE_LAYOUTS, STATUSES } from './pptxInput'
import { PPTX_TEMPLATES, SEVERITIES } from './pptxTemplates'
import { watchUnknownArguments, withoutUnsetNulls } from './schemaArguments'
import { headerText, normalizeTableRows } from './tableRows'
import { cleanToolArgs } from './toolText'
import type { InternalToolDefinition, InternalToolResult } from './types'
import { buildXlsxWorkbook } from './xlsxWorkbook'

export { fitImageBox, imageDisplaySize, imageIntrinsicSize } from './embeddedImages'

const PdfPrinter = require('pdfmake')

// Register Chart.js controllers/scales/elements/plugins once. Chart.js v4 ships
// these as separate exports so we have to opt in. `registerables` includes all
// chart types we expose (line, bar, pie, doughnut, etc.) plus axes/legend/title.
Chart.register(...registerables)

/**
 * Charts use the stack ./fonts registers (Roboto first), so labels render the
 * same on every image, including one without system fonts. Set when a chart is
 * drawn, so importing this module leaves the fonts and Chart.js as they were.
 */
function prepareChartFonts(): void {
  ensureFontsReady()
  Chart.defaults.font.family = CHART_FONT_STACK
  Chart.defaults.color = '#0f172a'
}

// Accessor to the current Host CRD, injected by main (avoids a circular import).
// Re-read on every getOutputDir() call because `currentHost` is hydrated async
// after boot — caching the path at module load would freeze it to the fallback.
type WorkspaceHostAccessor = () =>
  | { spec?: { memory?: { workspacePath?: string } } }
  | null
  | undefined
let outputDirHostAccessor: WorkspaceHostAccessor | null = null

/** Wire the Host CRD accessor so chat-mode artifacts resolve to the workspace PVC. */
export function setOutputDirHostAccessor(accessor: WorkspaceHostAccessor): void {
  outputDirHostAccessor = accessor
}

// ─── Security helpers ────────────────────────────────────────────────
//
// Boundary primitives applied at the seam between LLM-supplied data
// and the generated artifact. They guard against XSS in HTML output,
// path traversal when reading user-named files, and formula injection
// in spreadsheet cells.

/**
 * JSON.stringify with HTML-sensitive characters escaped, safe to embed
 * inside a `<script>` block. Prevents `</script>...<script>alert(1)...`
 * breakouts via attacker-controlled string content.
 */
export function safeJsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * Escape a value for use inside an HTML attribute (single OR double
 * quoted). Defends against attribute-breakout XSS like
 * `data-foo='${val}'` where `val` contains `'`.
 */
export function escapeHtmlAttr(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Resolve `p` against `outputDir` and ensure the result stays inside
 * `outputDir`. Throws on traversal attempts (`../etc/passwd`, absolute
 * paths outside the dir, symlink-style escapes). Returns the absolute
 * resolved path.
 *
 * The caller decides whether the file must already exist; this helper
 * only enforces the path-containment invariant.
 */
export function validateOutputPath(p: string, outputDir: string): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('path must be a non-empty string')
  }
  const root = path.resolve(outputDir)
  const resolved = path.resolve(root, p)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path traversal blocked: ${p}`)
  }
  return resolved
}

/**
 * Excel/CSV formula-injection guard. If a cell value is a string that
 * starts with a formula-trigger character (`=`, `+`, `-`, `@`, tab, CR),
 * prefix with a single quote so the spreadsheet renders it as text
 * instead of evaluating it. Non-string values pass through.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/
export function safeCell(v: unknown): unknown {
  if (typeof v !== 'string') return v
  return FORMULA_LEAD.test(v) ? `'${v}` : v
}

// ─── Helpers ─────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// A dashboard with charts inlines the Chart.js UMD bundle (~210 KB) so the
// HTML works offline: about 250 of them fit in the default quota.
const DEFAULT_QUOTA_MB = 50

/**
 * Recursively sum the size of all regular files under `dir`.
 * Returns 0 if the directory does not exist.
 */
export function getDirectorySize(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += getDirectorySize(full)
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size
      } catch {
        // file may have been removed between readdir and stat — ignore
      }
    }
  }
  return total
}

/**
 * Enforce the per-recipe output quota before a file is written.
 *
 * Reads the ceiling from `CLERUM_WORKFLOW_OUTPUT_QUOTA_MB` (default: 50 MB).
 * Throws if the current directory usage + `incomingBytes` would exceed the cap.
 * `replacingBytes` is the size of a file the write overwrites, which stops
 * counting once it is replaced.
 *
 * Known limitation (race condition): When the LLM issues multiple tool calls
 * concurrently (e.g., generate_pdf + generate_xlsx in the same turn), both
 * calls read the directory size before either has written its file. Both see
 * the same "current" size and both pass the quota check, even though the
 * combined output would exceed the 50 MB cap. This is a best-effort soft
 * quota; the 1Gi PVC hard cap enforced by kubelet is the primary defense.
 */
export function enforceQuota(outputDir: string, incomingBytes: number, replacingBytes = 0): void {
  const raw = process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
  const parsed = raw ? parseInt(raw, 10) : NaN
  const quotaMB = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUOTA_MB
  const quotaBytes = quotaMB * 1024 * 1024

  const current = getDirectorySize(outputDir) - replacingBytes
  const projected = current + incomingBytes
  if (projected > quotaBytes) {
    const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)
    throw new Error(
      `Output quota exceeded: the output folder holds ${mb(current)} MB and this file needs ` +
        `${mb(incomingBytes)} MB, over the ${quotaMB} MB limit. Make the file smaller, or ask ` +
        'the user to remove earlier generated files or an operator to raise ' +
        'CLERUM_WORKFLOW_OUTPUT_QUOTA_MB.'
    )
  }
}

// ─── generate_chart ──────────────────────────────────────────────────

export interface ChartTheme {
  backgroundColor: string
  textColor: string
  /** Secondary text, such as a gauge's maximum: at least 4.5:1 on the background. */
  mutedTextColor: string
  gridColor: string
  palette: string[]
  /** Semantic colors used by waterfall (positive/negative deltas) and gauge. */
  positive: string
  negative: string
}

export const CHART_THEMES: Record<string, ChartTheme> = {
  light: {
    backgroundColor: '#ffffff',
    textColor: '#0f172a',
    mutedTextColor: '#64748b',
    gridColor: '#e2e8f0',
    palette: ['#0f172a', '#22c55e', '#f59e0b', '#ef4444', '#3b82f6', '#a855f7', '#06b6d4'],
    positive: '#16a34a',
    negative: '#dc2626',
  },
  dark: {
    backgroundColor: '#0f172a',
    textColor: '#e2e8f0',
    mutedTextColor: '#94a3b8',
    gridColor: '#334155',
    palette: ['#22c55e', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899'],
    positive: '#22c55e',
    negative: '#f87171',
  },
  corporate: {
    backgroundColor: '#ffffff',
    textColor: '#1e293b',
    mutedTextColor: '#64748b',
    gridColor: '#cbd5e1',
    palette: ['#1e40af', '#0891b2', '#0d9488', '#059669', '#65a30d', '#ca8a04', '#dc2626'],
    positive: '#059669',
    negative: '#b91c1c',
  },
  warm: {
    backgroundColor: '#f7f7f5',
    textColor: '#2f2823',
    mutedTextColor: '#716961',
    gridColor: '#d6d2cc',
    palette: ['#b45309', '#2f2823', '#0d9488', '#1e40af', '#9f1239', '#65a30d', '#7c3aed'],
    positive: '#65a30d',
    negative: '#9f1239',
  },
  'warm-dark': {
    backgroundColor: '#0e0f10',
    textColor: '#f2f2ef',
    mutedTextColor: '#9b958f',
    gridColor: '#2a2c2f',
    palette: ['#ca6e1e', '#f2f2ef', '#34d399', '#60a5fa', '#fb7185', '#a3e635', '#c4b5fd'],
    positive: '#a3e635',
    negative: '#fb7185',
  },
}

/** Types whose series overlap, so their fill has to let the one below show. */
const TRANSLUCENT_FILL_TYPES = new Set(['line', 'area', 'radar'])

/** Widest a single bar may be drawn, in nominal pixels. */
const MAX_BAR_THICKNESS = 120

const DEFAULT_CHART_WIDTH = 800
const DEFAULT_CHART_HEIGHT = 400
const MAX_CHART_DIMENSION = 4000
const MIN_CHART_DIMENSION = 100

const SUPPORTED_CHART_TYPES = new Set([
  // Core Chart.js types (one-to-one mapping):
  'line',
  'bar',
  'horizontalBar',
  'pie',
  'doughnut',
  'area',
  'scatter',
  'radar',
  'polarArea',
  'bubble',
  // Extended types built by composing options on top of base types:
  'stackedBar', // bar with stacked x/y scales
  'stackedArea', // line with fill stacking
  'mixedBarLine', // bar primary + line overlay datasets (combo charts)
  'gauge', // doughnut hack: half-circle dial for a single 0..max value
  'waterfall', // bar with floating tuples to show step-by-step deltas
  'funnel', // horizontal bar sorted descending — conversion / pipeline
])

interface ChartDataset {
  label?: string
  /**
   * Numbers for category charts, {x,y[,r]} for scatter/bubble, and [from,to]
   * tuples once a waterfall has been expanded into floating bars.
   */
  data: Array<number | null> | NormalizedPoint[] | number[][]
  backgroundColor?: string | string[]
  borderColor?: string | string[]
  fill?: boolean
}

/**
 * Apply theme colors to datasets that don't specify their own. Each dataset gets
 * a different color from the palette by index. For pie/doughnut/polarArea where
 * each slice is a separate color, every slice gets its own color: a caller's
 * short list is completed from the theme, and slices past the palette get
 * shades of it.
 *
 * Palettes have 7 colors. With more than 7 datasets the palette wraps via
 * `idx % palette.length` — adjacent series can end up sharing a color. To
 * differentiate >7 series, callers should supply explicit `borderColor` /
 * `backgroundColor` per dataset instead of relying on the palette.
 */
/**
 * A mark that reaches the end of the plot has nowhere to put its value label
 * and reads as clipped, so a value axis runs 4% of its range past the data on
 * each side. Not past zero: values from 0 get an axis from 0, not from -20.
 * A bound set in the chart options stays as set.
 */
function addHeadroom(scale: Scale): void {
  const { min, max } = scale
  const room = (max - min) * 0.04
  if (!(room > 0)) return
  const set = scale.options as { min?: unknown; max?: unknown }
  if (set.max === undefined) scale.max = max <= 0 && max + room > 0 ? 0 : max + room
  if (set.min === undefined) scale.min = min >= 0 && min - room < 0 ? 0 : min - room
}

/**
 * Room past the data for the marks of a scatter or bubble chart, whose largest
 * mark reaches `radius` pixels from its value. The axis runs on past its end
 * ticks until a mark on the outermost value is drawn whole inside the plot,
 * clear of the tick labels, while the ticks stay where the data put them, so
 * an axis from 0 shows no -1. A bound set in the chart options stays as set.
 * Each axis takes its own pair of callbacks.
 */
function markRoom(radius: number): {
  afterDataLimits(scale: Scale): void
  afterBuildTicks(scale: Scale): void
} {
  let low = 0
  let high = 0
  return {
    afterDataLimits(scale) {
      low = scale.min
      high = scale.max
    },
    afterBuildTicks(scale) {
      const length = scale.isHorizontal() ? scale.width : scale.height
      // A mark wider than half the plot is not given room it cannot use.
      const r = Math.min(radius, length / 4)
      if (!(r > 0)) return
      const set = scale.options as { min?: unknown; max?: unknown }
      const first = scale.min
      const last = scale.max
      let min = first
      let max = last
      // The room a mark needs grows with the span it widens, so it is found by
      // iteration; each step changes the span by at most half the last one.
      for (let i = 0; i < 40; i++) {
        const need = (r * (max - min)) / length
        const nextMin = set.min === undefined ? Math.min(first, low - need) : first
        const nextMax = set.max === undefined ? Math.max(last, high + need) : last
        if (nextMin === min && nextMax === max) break
        min = nextMin
        max = nextMax
      }
      scale.min = min
      scale.max = max
      scale.ticks = spacedTicks(scale.ticks, (last - first) / (max - min))
    },
  }
}

/**
 * `ticks` for an axis they now span only `share` of. Chart.js spaced them for
 * the whole length, so when the room takes much of it every other one is
 * dropped, keeping the multiples of the doubled step so the values stay round.
 */
function spacedTicks<T extends { value: number }>(ticks: T[], share: number): T[] {
  if (!(share < 0.75) || ticks.length < 3) return ticks
  const step = 2 * (ticks[1].value - ticks[0].value)
  const kept = ticks.filter(t => Math.abs(t.value / step - Math.round(t.value / step)) < 1e-6)
  return kept.length >= 2 ? kept : ticks
}

/** Radius in pixels of the largest mark a scatter or bubble chart draws, its border included. */
function largestMark(chartType: string, datasets: ChartDataset[]): number {
  const size = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
  let largest = 0
  for (const ds of datasets) {
    const d = ds as unknown as Record<string, unknown>
    if (chartType === 'bubble') {
      const border = size(d.borderWidth, 1) / 2
      for (const point of ds.data as unknown[]) {
        const r = (point as { r?: unknown } | null)?.r
        largest = Math.max(largest, size(r, size(d.radius, 3)) + border)
      }
    } else {
      const border = size(d.pointBorderWidth, 1) / 2
      for (const r of [d.pointRadius ?? 3].flat()) largest = Math.max(largest, size(r, 0) + border)
    }
  }
  return largest
}

/**
 * Default radius of a series' points: `full` up to `crowd` points, and smaller
 * past that so a dense series keeps the ink of `crowd` points instead of
 * merging into one blot. Never under 1.5 px, so a lone point still shows.
 */
function pointRadius(full: number, crowd: number, points: number): number {
  return points <= crowd ? full : Math.max(1.5, full * Math.sqrt(crowd / points))
}

function applyThemePalette(
  datasets: ChartDataset[],
  theme: ChartTheme,
  chartType: string,
  warnings: string[]
): ChartDataset[] {
  const sliceTypes = new Set(['pie', 'doughnut', 'polarArea'])
  const isSliceType = sliceTypes.has(chartType)

  return datasets.map((ds, idx) => {
    const out: ChartDataset = { ...ds }
    if (isSliceType) {
      if (typeof out.backgroundColor !== 'string') {
        const requested = out.backgroundColor
        const { colors, padded, repeated } = sliceColors(
          ds.data.length,
          requested,
          theme.palette,
          theme.backgroundColor
        )
        out.backgroundColor = colors
        const where = `data.datasets[${idx}]`
        if (padded) {
          warnings.push(
            `${where}.backgroundColor had ${requested!.length} color(s) for ${ds.data.length} ` +
              'slices; the rest were taken from the theme. Send one color per slice.'
          )
        }
        if (repeated) {
          warnings.push(
            `${where} has ${ds.data.length} slices, more than there are distinct colors, so ` +
              'some colors repeat. Group the smallest slices into "Other".'
          )
        }
      }
    } else {
      const color = theme.palette[idx % theme.palette.length]
      if (!out.borderColor) out.borderColor = color
      if (!out.backgroundColor) {
        // Translucent wherever series are drawn over one another — a solid
        // radar fill hides every series behind the first.
        out.backgroundColor = TRANSLUCENT_FILL_TYPES.has(chartType) ? `${color}33` : color
      }
      if (chartType === 'area' && out.fill === undefined) {
        out.fill = true
      }
      const point = out as unknown as Record<string, unknown>
      const points = Array.isArray(ds.data) ? ds.data.length : 0
      if (chartType === 'scatter') {
        if (point.pointRadius === undefined) point.pointRadius = pointRadius(6, 100, points)
      } else if (chartType === 'line' || chartType === 'area' || chartType === 'stackedArea') {
        // A series with gaps draws no segments at all, leaving its points as
        // the only mark on the canvas.
        if (point.pointRadius === undefined) point.pointRadius = pointRadius(4, 60, points)
        if (point.pointBackgroundColor === undefined) point.pointBackgroundColor = color
      }
    }
    return out
  })
}

interface ResolvedChartType {
  chartType: ChartType
  // Loosely typed because Chart.js options that are valid only for specific
  // chart kinds (rotation/circumference/cutout for doughnut, indexAxis for
  // bar, etc.) don't satisfy the general ChartConfiguration['options'] union.
  // The cast happens once at config-merge time.
  optionsOverrides: Record<string, unknown> & {
    scales?: {
      x?: Record<string, unknown>
      y?: Record<string, unknown>
      y1?: Record<string, unknown>
    }
    plugins?: { legend?: { display?: boolean } }
    indexAxis?: 'x' | 'y'
  }
  /** When set, the caller should replace the labels array with this value. */
  labels?: string[]
  /** Gauge only: the reading as sent and the dial's ceiling, for the centre readout. */
  gaugeValue?: number
  gaugeMax?: number
  /** What the type changed about the data, for the caller. */
  notes: string[]
}

/**
 * Resolve our user-facing chart-type string to the underlying Chart.js
 * type AND compute per-type option overrides + dataset mutations.
 *
 * For composed types (gauge / waterfall / funnel / mixedBarLine / stacked*)
 * this function MUTATES `datasets` (and sometimes `labels`) in-place so
 * the caller can pass the result straight into the Chart.js config.
 */
function resolveChartType(
  raw: string,
  datasets: ChartDataset[],
  labels: string[] | undefined,
  theme: ChartTheme,
  args: Record<string, unknown>
): ResolvedChartType {
  const o: ResolvedChartType = { chartType: 'bar', optionsOverrides: {}, notes: [] }
  switch (raw) {
    case 'horizontalBar':
      o.chartType = 'bar'
      o.optionsOverrides.indexAxis = 'y'
      return o
    case 'area':
      o.chartType = 'line'
      // applyThemePalette already set fill=true for area datasets.
      return o
    case 'stackedBar':
      o.chartType = 'bar'
      o.optionsOverrides.scales = {
        x: { stacked: true },
        y: { stacked: true },
      }
      return o
    case 'stackedArea':
      o.chartType = 'line'
      o.optionsOverrides.scales = { y: { stacked: true } }
      datasets.forEach((d, i) => {
        if (d.fill === undefined) d.fill = (i === 0 ? 'origin' : '-1') as unknown as boolean
      })
      return o
    case 'mixedBarLine': {
      o.chartType = 'bar'
      // First dataset stays as bar (default for mixed); subsequent
      // datasets render as line overlays via Chart.js per-dataset `type`.
      const dual = args.dualAxis === true
      datasets.forEach((d, i) => {
        if (i > 0) {
          ;(d as any).type = 'line'
          ;(d as any).fill = false
          if (dual) (d as unknown as Record<string, unknown>).yAxisID = 'y1'
        }
      })
      if (dual) {
        o.optionsOverrides.scales = {
          y1: { position: 'right', grid: { drawOnChartArea: false } },
        }
      }
      return o
    }
    case 'bubble':
      o.chartType = 'bubble'
      return o
    case 'gauge': {
      o.chartType = 'doughnut'
      // Single-value 0..max. Take datasets[0].data[0] as the value;
      // build a 2-segment doughnut [value, max-value] and rotate it
      // 180° so the cut shows as a half-circle dial at the bottom.
      const ds = datasets[0]
      if (!ds) return o
      const values = (ds.data as unknown[]).filter((v): v is number => typeof v === 'number')
      const reading = values[0] ?? 0
      const max = Math.max(0, Number(args.gaugeMax) || 100)
      // Only the arc is bounded by the dial; the readout prints the reading.
      const arc = Math.min(Math.max(reading, 0), max)
      if (reading > max) {
        o.notes.push(
          `the gauge value ${reading} exceeds gaugeMax ${max}, so the dial is shown full; ` +
            'the readout prints the value. Raise gaugeMax to show it on the scale.'
        )
      } else if (reading < 0) {
        o.notes.push(`the gauge value ${reading} is below 0, so the dial is shown empty.`)
      }
      if (values.length > 1) {
        o.notes.push(
          `the gauge shows one value, so ${values.length - 1} more in data.datasets[0].data ` +
            `${values.length > 2 ? 'were' : 'was'} left out.`
        )
      }
      const fill = theme.palette[0]
      const remainder = theme.gridColor
      ds.data = [arc, max - arc]
      ds.backgroundColor = [fill, remainder]
      ds.borderColor = [fill, remainder]
      // Drop any extra datasets — gauge is single-value.
      datasets.length = 1
      o.gaugeValue = reading
      o.gaugeMax = max
      o.labels = ['Value', 'Remainder']
      o.optionsOverrides = {
        rotation: -90,
        circumference: 180,
        cutout: '70%',
        // A half circle is sized against the full circle's box, so without the
        // bottom padding the dial is drawn past the lower edge of the canvas.
        radius: '88%',
        layout: { padding: { top: 12, right: 16, bottom: 90, left: 16 } },
        plugins: { legend: { display: false } },
      }
      return o
    }
    case 'waterfall': {
      o.chartType = 'bar'
      const ds = datasets[0]
      if (!ds || !Array.isArray(ds.data)) return o
      const deltas = ds.data as number[]
      const floats: number[][] = []
      const colors: string[] = []
      let cumulative = 0
      for (const delta of deltas) {
        const start = cumulative
        cumulative += Number(delta) || 0
        floats.push([start, cumulative])
        colors.push((Number(delta) || 0) >= 0 ? theme.positive : theme.negative)
      }
      // Final cumulative-total bar in primary color.
      floats.push([0, cumulative])
      colors.push(theme.palette[0])
      ds.data = floats as any
      ds.backgroundColor = colors
      ds.borderColor = colors
      // Append "Total" to labels (or synthesize labels if absent).
      const newLabels = labels ? [...labels] : deltas.map((_, i) => `Step ${i + 1}`)
      newLabels.push('Total')
      o.labels = newLabels
      // Drop extra datasets — waterfall is single-series.
      datasets.length = 1
      o.optionsOverrides = { plugins: { legend: { display: false } } }
      return o
    }
    case 'funnel': {
      o.chartType = 'bar'
      const ds = datasets[0]
      if (!ds || !Array.isArray(ds.data)) return o
      // Sort descending while keeping label/data alignment.
      const lbls = labels ?? (ds.data as number[]).map((_, i) => `Stage ${i + 1}`)
      const paired = (ds.data as number[]).map((v, i) => ({
        v: Number(v) || 0,
        l: lbls[i] ?? '',
        i,
      }))
      paired.sort((a, b) => b.v - a.v)
      ds.data = paired.map(p => p.v)
      o.labels = paired.map(p => p.l)
      // Per-stage colors follow their stage through the sort.
      const follow = (colors: string | string[] | undefined) =>
        Array.isArray(colors) ? paired.map(p => colors[p.i % colors.length]) : colors
      ds.backgroundColor = follow(ds.backgroundColor)
      ds.borderColor = follow(ds.borderColor)
      // Drop extra datasets — funnel is single-series.
      datasets.length = 1
      o.optionsOverrides = {
        indexAxis: 'y',
        plugins: { legend: { display: false } },
      }
      return o
    }
    default:
      o.chartType = raw as ChartType
      return o
  }
}

// ─── Portable schema fragments ───────────────────────────────────────
//
// A tool schema does two jobs. The workflow path (stepRouter) compiles it with
// AJV and REJECTS arguments that do not match before execute() runs, so it must
// accept everything the runtime handles. And it reaches every provider
// verbatim, so it must survive each SDK's translation. Unions are therefore
// written as scalar type lists or `anyOf` branches — @google/genai turns both
// into its own schema — and never as `oneOf`, which it passes through
// untranslated for the Gemini API to reject. Every array declares `items`.

/** A table or sheet cell. Each runtime stringifies or formats what arrives. */
const CELL_SCHEMA = {
  type: ['string', 'number', 'boolean', 'null'],
  description: 'Text, a number, true/false, or null for an empty cell.',
}

/** One row of cells, left to right in header order. */
const ROW_SCHEMA = { type: 'array', items: CELL_SCHEMA }

/** A single color, or one per data point. */
function colorSchema(what: string): Record<string, unknown> {
  return {
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description: `${what}: a hex color, or an array of one per point.`,
  }
}

/**
 * One chart data point. Numbers are the norm; the rest are shapes models send
 * that normalizeChartData repairs or needs — text such as "1,200", null for a
 * gap, {x, y[, r]} or [x, y[, r]] for scatter and bubble, and {label, value}
 * records or [label, value] pairs.
 */
const CHART_POINT_SCHEMA = {
  anyOf: [
    { type: 'number' },
    { type: 'string' },
    { type: 'null' },
    { type: 'array', items: { type: ['number', 'string'] } },
    {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X value.' },
        y: { type: 'number', description: 'Y value.' },
        r: { type: 'number', description: 'Bubble radius (px).' },
        label: { type: 'string', description: 'Category.' },
        value: { type: 'number', description: 'Value.' },
      },
    },
  ],
  description: 'A number, null for a gap, or {x, y} / {x, y, r} or [x, y] for scatter / bubble.',
}

const generateChart: InternalToolDefinition = {
  name: 'clerum__generate_chart',
  description:
    'Render a chart as a PNG image, with values printed on it by default. Returns the file ' +
    'name it was saved under, such as "sales.png"; pass it as images[].path to the PDF or ' +
    'DOCX generator, as sheets[].images[].path to the XLSX generator, or as a PPTX slide ' +
    'image.path or chart.path.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'revenue.png'); .png added if missing.",
      },
      type: {
        type: 'string',
        enum: [
          'line',
          'bar',
          'horizontalBar',
          'pie',
          'doughnut',
          'area',
          'scatter',
          'radar',
          'polarArea',
          'bubble',
          'stackedBar',
          'stackedArea',
          'mixedBarLine',
          'gauge',
          'waterfall',
          'funnel',
        ],
        description:
          'area: filled line. mixedBarLine: first dataset as bars, the rest as lines. ' +
          'gauge: one value 0..gaugeMax as a half dial. waterfall: one series of deltas, ' +
          'drawn as steps plus a total bar. funnel: one series, sorted descending.',
      },
      title: {
        type: 'string',
        description: 'Title above the plot. Always set one.',
      },
      width: {
        type: 'number',
        description:
          `Width in px (default ${DEFAULT_CHART_WIDTH}, ${MIN_CHART_DIMENSION}-${MAX_CHART_DIMENSION}; ` +
          'width × height up to about 13 million). The PNG is up to 2× this.',
      },
      height: {
        type: 'number',
        description: `Height in px (default ${DEFAULT_CHART_HEIGHT}, ${MIN_CHART_DIMENSION}-${MAX_CHART_DIMENSION}).`,
      },
      theme: {
        type: 'string',
        enum: ['light', 'dark', 'corporate', 'warm', 'warm-dark'],
        description: "Color theme. Default 'light'.",
      },
      data: {
        type: 'object',
        description: 'Series to plot. Colors come from the theme unless a dataset sets them.',
        properties: {
          labels: {
            type: 'array',
            items: { type: ['string', 'number'] },
            description:
              'One per value: X-axis categories, or slice names (required) for ' +
              'pie/doughnut/polarArea. Unused by scatter/bubble.',
          },
          datasets: {
            type: 'array',
            description: 'One or more series.',
            items: {
              type: 'object',
              required: ['data'],
              properties: {
                label: {
                  type: 'string',
                  description: 'Series name, shown in the legend.',
                },
                data: {
                  type: 'array',
                  items: CHART_POINT_SCHEMA,
                  description: 'One point per label, in labels order.',
                },
                backgroundColor: colorSchema('Fill color'),
                borderColor: colorSchema('Line/border color'),
                fill: { type: 'boolean', description: 'Fill under a line series.' },
              },
            },
          },
        },
        required: ['datasets'],
      },
      yAxisLabel: { type: 'string', description: 'Y-axis title, e.g. "USD".' },
      xAxisLabel: { type: 'string', description: 'X-axis title.' },
      showValues: {
        type: 'boolean',
        description:
          'Print each value on the chart. Default on, except scatter, bubble, radar, gauge and stacked types.',
      },
      valueFormat: {
        type: 'string',
        enum: ['auto', 'plain', 'compact', 'currency', 'percent'],
        description:
          'Number style on the chart and value axis. auto: abbreviate above 10,000; compact: ' +
          'always (1.2M); currency: prefix currencySymbol; percent: append %.',
      },
      currencySymbol: {
        type: 'string',
        description: "For valueFormat 'currency'. Default '$'.",
      },
      decimals: {
        type: 'number',
        description: 'Decimal places on printed values. Default: per value.',
      },
      showLegend: {
        type: 'boolean',
        description:
          'Legend on or off. Default: on for several series, or one the titles do not name.',
      },
      dualAxis: {
        type: 'boolean',
        description: 'mixedBarLine only: put the line series on a second, right-hand axis.',
      },
      gaugeMax: {
        type: 'number',
        description: 'gauge only: dial maximum (default 100).',
      },
    },
    required: ['filename', 'type', 'data'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    let chart: Chart | undefined
    try {
      prepareChartFonts()

      const filename = outputFilename(args.filename, 'png', 'chart')
      const chartTypeRaw = String(args.type ?? 'bar')
      if (!SUPPORTED_CHART_TYPES.has(chartTypeRaw)) {
        return {
          success: false,
          error:
            `Unsupported chart type "${chartTypeRaw}". Supported types: ` +
            `${[...SUPPORTED_CHART_TYPES].join(', ')}.`,
        }
      }

      // Repair what the caller sent before anything is drawn, so an unusable
      // dataset fails with a message instead of rendering an empty plot.
      const normalized = normalizeChartData(args.data, { chartType: chartTypeRaw })
      const warnings = [...normalized.warnings]

      const width = clampDimension('width', args.width, DEFAULT_CHART_WIDTH, warnings)
      const height = clampDimension('height', args.height, DEFAULT_CHART_HEIGHT, warnings)

      // Pixel density for the requested size; the layout itself is capped below.
      const pixelRatio = chartPixelRatio(width, height)
      if (pixelRatio === undefined) {
        return {
          success: false,
          error:
            `Chart too large: ${width}x${height} is over the ` +
            `${(MAX_CANVAS_PIXELS / 1e6).toFixed(1)} megapixel limit. Reduce width or height.`,
        }
      }
      const themeName = String(args.theme ?? 'light')
      const theme = CHART_THEMES[themeName] ?? CHART_THEMES.light

      const title = args.title ? sanitizeForFont(String(args.title)) : undefined
      const yAxisLabel = args.yAxisLabel ? sanitizeForFont(String(args.yAxisLabel)) : undefined
      const xAxisLabel = args.xAxisLabel ? sanitizeForFont(String(args.xAxisLabel)) : undefined

      let labels = normalized.labels ? normalized.labels.map(l => sanitizeForFont(l)) : undefined
      const datasets: ChartDataset[] = normalized.datasets.map(ds => ({
        ...ds,
        ...(ds.label ? { label: sanitizeForFont(ds.label) } : {}),
      })) as ChartDataset[]

      const themedDatasets = applyThemePalette(datasets, theme, chartTypeRaw, warnings)
      const resolved = resolveChartType(chartTypeRaw, themedDatasets, labels, theme, args)
      const chartType = resolved.chartType
      if (resolved.labels !== undefined) labels = resolved.labels
      warnings.push(...resolved.notes)

      // Past MAX_LAYOUT_SIDE the chart is laid out smaller and drawn at a higher
      // density, so type, lines and bars keep their share of the image.
      const layoutScale = Math.max(1, Math.max(width, height) / MAX_LAYOUT_SIDE)
      const layoutWidth = Math.round(width / layoutScale)
      const layoutHeight = Math.round(height / layoutScale)

      // Type sized for the default canvas turns unreadable on a much larger
      // one, so every font size follows the canvas area.
      const fontScale = Math.min(
        2,
        Math.max(
          0.85,
          Math.sqrt((layoutWidth * layoutHeight) / (DEFAULT_CHART_WIDTH * DEFAULT_CHART_HEIGHT))
        )
      )
      const px = (base: number): number => Math.round(base * fontScale)

      const indexAxis = resolved.optionsOverrides?.indexAxis === 'y' ? 'y' : 'x'
      const decimals =
        typeof args.decimals === 'number' &&
        Number.isInteger(args.decimals) &&
        args.decimals >= 0 &&
        args.decimals <= 20
          ? args.decimals
          : undefined
      if (args.decimals !== undefined && decimals === undefined) {
        warnings.push(
          `decimals ${JSON.stringify(args.decimals)} is not a whole number from 0 to 20, so ` +
            'each value got the places it needs.'
        )
      }
      const valueOptions: ValueLabelOptions = {
        format: resolveValueFormat(args.valueFormat),
        ...(args.currencySymbol ? { currencySymbol: String(args.currencySymbol) } : {}),
        ...(decimals !== undefined ? { decimals } : {}),
        textColor: theme.textColor,
        backgroundColor: theme.backgroundColor,
        indexAxis,
        fontScale,
      }

      const cartesian =
        chartType === 'bar' ||
        chartType === 'line' ||
        chartType === 'scatter' ||
        chartType === 'bubble'
      const showAxes = cartesian && chartTypeRaw !== 'gauge'
      const radial = chartType === 'radar' || chartType === 'polarArea'

      const sliceChart =
        chartTypeRaw === 'pie' || chartTypeRaw === 'doughnut' || chartTypeRaw === 'polarArea'
      const legendEntries = sliceChart ? (labels?.length ?? 0) : themedDatasets.length
      // One series needs a legend only when its name says what the titles do not.
      const only = legendEntries === 1 && !sliceChart ? themedDatasets[0]?.label : undefined
      const namesMore =
        typeof only === 'string' &&
        only.trim() !== '' &&
        ![title, yAxisLabel, xAxisLabel].some(t =>
          t?.toLowerCase().includes(only.trim().toLowerCase())
        )
      const legendDisplay =
        args.showLegend === undefined
          ? resolved.optionsOverrides?.plugins?.legend?.display !== false &&
            (legendEntries > 1 || namesMore)
          : Boolean(args.showLegend)

      const labelValues = shouldLabelValues(chartTypeRaw, args.showValues)
      const plugins: Plugin[] = [backgroundPlugin(theme.backgroundColor)]
      if (labelValues) plugins.push(valueLabelsPlugin(valueOptions))
      if (chartTypeRaw === 'gauge') {
        plugins.push(
          gaugeCenterPlugin({
            value: resolved.gaugeValue ?? 0,
            max: resolved.gaugeMax ?? 100,
            textColor: theme.textColor,
            mutedColor: theme.mutedTextColor,
            format: valueOptions,
          })
        )
      }
      if (isVisuallyEmpty(themedDatasets)) {
        plugins.push(emptyStatePlugin('No data to display', theme.textColor))
      }

      const axisTicks = {
        color: theme.textColor,
        font: { family: CHART_FONT_STACK, size: px(12) },
      }
      // Applied to whichever axis carries the values, never to the one carrying
      // the category names. The decision to abbreviate is taken from the whole
      // tick range, so one axis never mixes "$350K" with "$50,000".
      const valueTick = {
        callback: (value: string | number, _i: number, ticks: Array<{ value: number }>) => {
          const peak = Math.max(...ticks.map(t => Math.abs(t.value)), 0)
          const scaled =
            peak >= 10_000 ? { ...valueOptions, format: 'compact' as const } : valueOptions
          const prefix =
            valueOptions.format === 'currency' ? (valueOptions.currencySymbol ?? '$') : ''
          const suffix = valueOptions.format === 'percent' ? '%' : ''
          return peak >= 10_000
            ? `${Number(value) < 0 ? '-' : ''}${prefix}${formatValue(Math.abs(Number(value)), scaled)}${suffix}`
            : formatValue(Number(value), valueOptions)
        },
      }
      const headroom = { afterDataLimits: addHeadroom }
      const marks = chartTypeRaw === 'scatter' || chartTypeRaw === 'bubble'
      const radius = marks ? largestMark(chartTypeRaw, themedDatasets) : 0

      const config: ChartConfiguration = {
        type: chartType,
        data: { labels, datasets: themedDatasets as ChartConfiguration['data']['datasets'] },
        options: {
          responsive: false,
          animation: false,
          devicePixelRatio: pixelRatio * layoutScale,
          maintainAspectRatio: false,
          // Room for value labels that sit just outside the outermost marks.
          layout: { padding: { top: 12, right: 16, bottom: 4, left: 4 } },
          // Without a cap, a chart with one or two categories draws bars as
          // wide as the plot, which reads as a block rather than a measurement.
          datasets: { bar: { maxBarThickness: MAX_BAR_THICKNESS } },
          ...resolved.optionsOverrides,
          plugins: {
            title: title
              ? {
                  display: true,
                  text: title,
                  color: theme.textColor,
                  font: { family: CHART_FONT_STACK, size: px(17), weight: 'bold' as const },
                  padding: { top: 6, bottom: 14 },
                }
              : { display: false },
            legend: {
              display: legendDisplay,
              position: 'top' as const,
              labels: {
                color: theme.textColor,
                font: { family: CHART_FONT_STACK, size: px(12) },
                usePointStyle: true,
                boxWidth: 10,
                boxHeight: 10,
              },
            },
            ...(resolved.optionsOverrides?.plugins ?? {}),
          },
          scales: showAxes
            ? {
                x: {
                  ticks: {
                    ...axisTicks,
                    autoSkip: true,
                    maxRotation: 45,
                    minRotation: 0,
                    ...(indexAxis === 'y' ? valueTick : {}),
                  },
                  grid: { color: theme.gridColor },
                  ...(marks ? markRoom(radius) : indexAxis === 'y' ? headroom : {}),
                  title: xAxisLabel
                    ? {
                        display: true,
                        text: xAxisLabel,
                        color: theme.textColor,
                        font: { family: CHART_FONT_STACK, size: px(13) },
                      }
                    : { display: false },
                  ...(resolved.optionsOverrides?.scales?.x ?? {}),
                },
                y: {
                  ticks: {
                    ...axisTicks,
                    ...(indexAxis === 'x' ? valueTick : {}),
                  },
                  grid: { color: theme.gridColor },
                  ...(marks ? markRoom(radius) : indexAxis === 'x' ? headroom : {}),
                  title: yAxisLabel
                    ? {
                        display: true,
                        text: yAxisLabel,
                        color: theme.textColor,
                        font: { family: CHART_FONT_STACK, size: px(13) },
                      }
                    : { display: false },
                  ...(resolved.optionsOverrides?.scales?.y ?? {}),
                },
                ...(resolved.optionsOverrides?.scales?.y1
                  ? {
                      y1: {
                        ticks: axisTicks,
                        ...resolved.optionsOverrides.scales.y1,
                      },
                    }
                  : {}),
              }
            : radial
              ? {
                  r: {
                    // Above the data, so slices and fills do not cover the scale.
                    ticks: { ...axisTicks, backdropColor: theme.backgroundColor, z: 1 },
                    grid: { color: theme.gridColor },
                    angleLines: { color: theme.gridColor },
                    pointLabels: {
                      color: theme.textColor,
                      font: { family: CHART_FONT_STACK, size: px(12) },
                    },
                  },
                }
              : undefined,
        },
        plugins,
      }

      // The canvas is created at the layout size and Chart.js is told the pixel
      // ratio, so it lays out in nominal units and rasterizes the backing store
      // at the higher density itself. Scaling the context by hand instead does
      // not work: Chart.js resets the transform, so the layout silently becomes
      // the full device size and every font ends up half its intended size
      // relative to the image.
      const canvas = createCanvas(layoutWidth, layoutHeight)
      const ctx = canvas.getContext('2d') as SKRSContext2D
      // Chart.js types target a browser CanvasRenderingContext2D; the Skia
      // context is API-compatible for the subset Chart.js uses.
      chart = new Chart(ctx as any, config)
      chart.update('none')

      const pngBuffer = stampPngDensity(canvas.toBuffer('image/png'), pixelRatio)

      ensureDir(outputDir)
      const target = claimOutputFile(outputDir, filename)
      enforceQuota(outputDir, pngBuffer.byteLength, replacedBytes(target))
      fs.writeFileSync(target.filePath, pngBuffer)

      const summary =
        `Chart written: ${target.filename} (${canvas.width}x${canvas.height} px, ` +
        `${chartTypeRaw}, ${themedDatasets.length} series). To embed it, pass ` +
        `images: [{ path: '${target.filename}' }] to the PDF or DOCX generator, ` +
        `sheets[].images: [{ path: '${target.filename}' }] to the XLSX generator, or ` +
        `path '${target.filename}' as a PPTX slide image or chart.`
      return artifactResult(target, 'png', { summary, warnings })
    } catch (err) {
      if (err instanceof ChartDataError) return { success: false, error: err.message }
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (chart) chart.destroy()
    }
  },
}

/** Nominal pixels are multiplied by this to keep charts sharp when scaled down. */
const CHART_PIXEL_RATIO = 2

/** Longest side a chart is laid out at, in nominal pixels. */
const MAX_LAYOUT_SIDE = 1600

/** Largest canvas drawn, in device pixels: 50 MiB of RGBA. */
const MAX_CANVAS_PIXELS = 13_107_200

/**
 * Pixel ratio for a chart of the given layout size. A large chart is drawn at a
 * lower density rather than refused, down to 1; undefined when even that would
 * exceed MAX_CANVAS_PIXELS.
 */
function chartPixelRatio(width: number, height: number): number | undefined {
  const area = width * height
  if (area > MAX_CANVAS_PIXELS) return undefined
  return Math.min(CHART_PIXEL_RATIO, Math.sqrt(MAX_CANVAS_PIXELS / area))
}

/** Types where per-point labels would collide more than they inform. */
const VALUE_LABELS_OFF_BY_DEFAULT = new Set([
  'scatter',
  'bubble',
  'radar',
  'gauge',
  'stackedArea',
  'stackedBar',
])

function shouldLabelValues(chartType: string, requested: unknown): boolean {
  if (typeof requested === 'boolean') return requested
  return !VALUE_LABELS_OFF_BY_DEFAULT.has(chartType)
}

function resolveValueFormat(raw: unknown): ValueFormat {
  const allowed: ValueFormat[] = ['auto', 'plain', 'compact', 'currency', 'percent']
  const v = String(raw ?? 'auto') as ValueFormat
  return allowed.includes(v) ? v : 'auto'
}

/** True when every plotted number is absent or zero, so nothing would be drawn. */
function isVisuallyEmpty(datasets: ChartDataset[]): boolean {
  let sawNumber = false
  for (const ds of datasets) {
    for (const point of ds.data as unknown[]) {
      const value =
        typeof point === 'number'
          ? point
          : point && typeof point === 'object' && 'y' in point
            ? (point as { y: number }).y
            : Array.isArray(point)
              ? Number(point[1]) - Number(point[0])
              : null
      if (typeof value === 'number' && Number.isFinite(value)) {
        sawNumber = true
        if (value !== 0) return false
      }
    }
  }
  return sawNumber
}

function clampDimension(
  field: 'width' | 'height',
  value: unknown,
  fallback: number,
  warnings: string[]
): number {
  if (value === undefined || value === null) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    warnings.push(`${field} ${String(value)} is not a positive number; used ${fallback}.`)
    return fallback
  }
  if (n > MAX_CHART_DIMENSION) {
    warnings.push(
      `${field} ${n} is over the ${MAX_CHART_DIMENSION} maximum; used ${MAX_CHART_DIMENSION}.`
    )
    return MAX_CHART_DIMENSION
  }
  if (n < MIN_CHART_DIMENSION) {
    warnings.push(
      `${field} ${n} is under the ${MIN_CHART_DIMENSION} minimum, too small to read; ` +
        `used ${MIN_CHART_DIMENSION}.`
    )
    return MIN_CHART_DIMENSION
  }
  return Math.floor(n)
}

// ─── generate_markdown ───────────────────────────────────────────────

/** The file text, or an error saying what content must be; never a stringified array or object. */
function markdownContent(value: unknown): string | { error: string } {
  if (value === undefined || value === null) {
    return { error: 'content is required: pass the markdown text to write.' }
  }
  const lines = Array.isArray(value) ? value : [value]
  if (!lines.every(line => typeof line === 'string')) {
    const received = Array.isArray(value)
      ? 'an array with entries that are not text'
      : `a ${typeof value}`
    return {
      error: `content must be the markdown text as a string, or an array of lines; received ${received}.`,
    }
  }
  const text = lines.join('\n')
  if (!text.trim()) return { error: 'content is empty: pass the markdown text to write.' }
  return text
}

const generateMarkdown: InternalToolDefinition = {
  name: 'clerum__generate_markdown',
  description: 'Generate a Markdown (.md) file. Provide the filename and full markdown content.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'report.md'). Extension .md added if missing.",
      },
      content: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Full markdown text, as one string or an array of lines.',
      },
    },
    required: ['filename', 'content'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    try {
      const filename = outputFilename(args.filename, 'md', 'output')
      const content = markdownContent(args.content)
      if (typeof content !== 'string') return { success: false, error: content.error }

      ensureDir(outputDir)
      const target = claimOutputFile(outputDir, filename)
      enforceQuota(outputDir, Buffer.byteLength(content, 'utf-8'), replacedBytes(target))
      fs.writeFileSync(target.filePath, content, 'utf-8')

      return artifactResult(target, 'md')
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

// ─── generate_pdf ────────────────────────────────────────────────────

interface PdfPalette {
  primary: string
  text: string
  muted: string
  border: string
  accent: string
  statusGreen: string
  statusYellow: string
  statusRed: string
  alternateRowFill: string
  surface: string
}

const PDF_PALETTES: Record<string, PdfPalette> = {
  default: {
    primary: '#0f172a',
    text: '#0f172a',
    muted: '#475569',
    border: '#cbd5e1',
    accent: '#3b82f6',
    statusGreen: '#16a34a',
    statusYellow: '#ca8a04',
    statusRed: '#dc2626',
    alternateRowFill: '#f8fafc',
    surface: '#f1f5f9',
  },
  corporate: {
    primary: '#1e3a8a',
    text: '#1e293b',
    muted: '#475569',
    border: '#cbd5e1',
    accent: '#0891b2',
    statusGreen: '#059669',
    statusYellow: '#ca8a04',
    statusRed: '#b91c1c',
    alternateRowFill: '#f1f5f9',
    surface: '#e0f2fe',
  },
  warm: {
    primary: '#b45309',
    text: '#2f2823',
    muted: '#66584c',
    border: '#d6d2cc',
    accent: '#b45309',
    statusGreen: '#15803d',
    statusYellow: '#b45309',
    statusRed: '#9f1239',
    alternateRowFill: '#fefdfb',
    surface: '#f7f7f5',
  },
  alert: {
    primary: '#9f1239',
    text: '#1f2937',
    muted: '#4b5563',
    border: '#fecaca',
    accent: '#dc2626',
    statusGreen: '#15803d',
    statusYellow: '#ca8a04',
    statusRed: '#9f1239',
    alternateRowFill: '#fef2f2',
    surface: '#fee2e2',
  },
}

/**
 * Stamp a PNG's pHYs chunk so consumers know the image is oversampled.
 *
 * Charts are rasterized above their layout size to stay sharp in print. Every
 * embedder sizes an image from its pixel count, so without this the extra
 * pixels are read as extra size and the whole chart — its type included — is
 * scaled down to fit, landing at about a third of the surrounding body text.
 * Recording the density lets `imageDisplaySize` recover the size the chart was
 * laid out for.
 */
function stampPngDensity(png: Buffer, ratio: number): Buffer {
  const ppm = Math.round(PNG_BASE_PPM * ratio)
  const data = Buffer.alloc(9)
  data.writeUInt32BE(ppm, 0)
  data.writeUInt32BE(ppm, 4)
  data.writeUInt8(1, 8) // unit: metres
  const type = Buffer.from('pHYs', 'latin1')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  type.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length)

  // IHDR is always the first chunk: 8-byte signature + 4 length + 4 type + 13
  // data + 4 CRC. The new chunk goes straight after it.
  const insertAt = 8 + 25
  if (png.length < insertAt) return png
  return Buffer.concat([png.subarray(0, insertAt), chunk, png.subarray(insertAt)])
}

let crcTable: Uint32Array | undefined

function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A4 width (595pt) less the 40pt side margins the documents use. */
const PDF_CONTENT_WIDTH = PORTRAIT.width

/** Printable width of a default Word page, in pixels at 96dpi. */
const DOCX_MAX_IMAGE_WIDTH = 560
const DOCX_MAX_IMAGE_HEIGHT = 380

/** Drawn size for a spreadsheet image, in pixels. */
const XLSX_MAX_IMAGE_WIDTH = 640
const XLSX_MAX_IMAGE_HEIGHT = 400

/** Keeps a tall image from taking a whole page on its own. */
const PDF_MAX_IMAGE_HEIGHT = 330

/** Vertical margin around an embedded image, above and below. */
const PDF_IMAGE_MARGIN = 10

/** The cover logo's box: its usual width, and a height a tall logo cannot exceed. */
const PDF_LOGO_BOX = { width: 120, height: 80 }

/**
 * Id prefix of each table's first header cell. pdfmake corrects the page
 * number it records for a block moved to the next page only on nodes with an
 * id, and the heading check reads it to see where a table really starts.
 */
const TABLE_HEADER_ID = 'pdf-table-'

/**
 * Style of the running header and footer. pdfmake lists their nodes among a
 * page's content when deciding page breaks, and this is how they are told apart.
 */
const RUNNING_STYLE = 'running'

/** Top page margin; the running header is drawn inside it. */
const PDF_TOP_MARGIN = 60

/** Footer lines that fit once the bottom margin has grown to hold them. */
const PDF_MAX_FOOTER_LINES = 6
const PDF_FOOTER_SIZE = 9

const PDF_LINE_HEIGHT = 1.3

interface PdfBranding {
  logoPath?: string
  companyName?: string
  footerText?: string
}

interface PdfImageRef {
  path: string
  width?: number
  height?: number
  alignment?: 'left' | 'center' | 'right'
}

interface PdfTableSpec {
  headers: unknown[]
  rows: unknown
  widths?: unknown
  layout?: 'striped' | 'minimal' | 'grid'
}

/** What the body parser needs from the call it serves. */
interface PdfBodyEnv {
  warnings: string[]
  /** Width of text at 1pt in the body face, for sizing table columns. */
  measure: UnitMeasure
  /** An image block for a `![alt](file)` line, or undefined when it could not be loaded. */
  image(src: string): Content | undefined
  /** Tables that need landscape pages. */
  landscape: Set<Content>
  /** Tables parsed from the body so far, for naming them in warnings. */
  tableCount: number
  /** Tables built so far, body and explicit, for giving each header a unique id. */
  tablesBuilt: number
  /** Bottom page margin, which grows with the footer. */
  bottomMargin: number
}

/**
 * Branding as it prints: HTML in the company name and footer read as text,
 * the footer keeping its lines.
 */
function printedBranding(raw: unknown): {
  logoPath?: string
  companyName?: string
  footerText?: string
} {
  const branding = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  const text = (value: unknown) =>
    value === undefined || value === null ? undefined : String(value)
  const companyName = text(branding.companyName)
  const footerText = text(branding.footerText)
  return {
    ...branding,
    ...(companyName !== undefined ? { companyName: htmlToPlainText(companyName) } : {}),
    ...(footerText !== undefined ? { footerText: htmlToPlainLines(footerText) } : {}),
  }
}

/** An image reference written in the body: `![alt](src)`. */
interface MarkdownImage {
  alt: string
  src: string
}

/**
 * Inline markup of one line as pdfmake runs: **bold**, *italic*, ~~strike~~,
 * `code`, links, the HTML tags models write, and character entities. Image
 * references are taken out of the text and handed to `onImage`.
 */
function parseInlineMarkdown(line: string, onImage: (image: MarkdownImage) => void): ContentText {
  const runs: ContentText[] = []
  for (const span of inlineSpans(line)) {
    if (span.image !== undefined) {
      onImage({ alt: span.text, src: span.image })
      continue
    }
    runs.push({
      text: span.text,
      ...(span.bold ? { bold: true } : {}),
      ...(span.italics ? { italics: true } : {}),
      ...(span.code ? { font: PDF_MONO_FAMILY } : {}),
      ...(span.link !== undefined
        ? { link: span.link, color: '#1d4ed8', decoration: 'underline' as const }
        : span.strike
          ? { decoration: 'lineThrough' as const }
          : {}),
    })
  }
  return { text: runs }
}

/** The text a parsed line prints, for measuring it. */
function plainText(parsed: ContentText): string {
  const text = parsed.text
  if (!Array.isArray(text)) return String(text ?? '')
  return text
    .map(t => (typeof t === 'string' ? t : String((t as { text?: unknown }).text ?? '')))
    .join('')
}

/** A GFM delimiter row. One column needs its outer pipes, or it is only a rule. */
function isTableSeparator(line: string): boolean {
  return (
    /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line) ||
    /^\s*\|\s*:?-+:?\s*\|\s*$/.test(line)
  )
}

/** Cells of a pipe-table row. `\|` is a literal pipe inside a cell. */
function splitTableRow(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
}

/**
 * Whether a GFM table starts at line `i`. GFM makes the outer pipes optional
 * and some models leave them out, so a header without them counts when it has
 * as many cells as the separator under it.
 */
function isPipeTableStart(lines: string[], i: number): boolean {
  const line = lines[i]
  const next = lines[i + 1]
  if (next === undefined || !line.includes('|') || !isTableSeparator(next)) return false
  return (
    line.trimStart().startsWith('|') || splitTableRow(line).length === splitTableRow(next).length
  )
}

type ColumnAlignment = 'left' | 'center' | 'right'

interface PdfTableRequest {
  headers: string[]
  rows: string[][]
  layout?: 'striped' | 'minimal' | 'grid'
  widths?: unknown
  alignments?: ColumnAlignment[]
  /** How warnings name the table, such as "tables[0]". */
  label: string
  /** How warnings name one of its rows, such as "tables[0].rows[2]". */
  rowLabel(index: number): string
}

function buildTableNode(
  request: PdfTableRequest,
  palette: PdfPalette,
  env: PdfBodyEnv,
  onImage: (image: MarkdownImage) => void
): Content {
  const { headers, alignments } = request
  const layout = request.layout ?? 'striped'
  // pdfmake needs every row to have one cell per column: short rows are
  // padded, and cells past the last header are cut and reported.
  const long = request.rows.flatMap((row, i) => (row.length > headers.length ? [i] : []))
  if (long.length > 0) {
    const first = request.rows[long[0]].length
    env.warnings.push(
      `${request.rowLabel(long[0])} has ${first} cells for ${headers.length} headers` +
        (long.length > 1 ? ` (and ${long.length - 1} more row(s) have too many)` : '') +
        ', so the cells past the last header were left out; add a header for every column.'
    )
  }
  const cells = request.rows.map(row =>
    normalizeRowLength(row, headers.length).map(cell => parseInlineMarkdown(cell ?? '', onImage))
  )
  const headerCells = headers.map(h => parseInlineMarkdown(h, onImage))
  const fit = layoutPdfTable(
    {
      headers: headerCells.map(plainText),
      rows: cells.map(row => row.map(plainText)),
      requested: request.widths,
      cellPadding: 8,
      ruleWidth: layout === 'grid' ? 0.5 : 0,
      allowLandscape: true,
      label: request.label,
      bottomMargin: env.bottomMargin,
    },
    env.measure,
    env.warnings
  )
  const align = (col: number) =>
    alignments?.[col] && alignments[col] !== 'left' ? { alignment: alignments[col] } : {}
  const node = {
    table: {
      headerRows: 1,
      // Without this a table starting near the foot of a page leaves its
      // header stranded there with every row on the next one.
      ...(fit.keepWithHeaderRows ? { keepWithHeaderRows: 1 } : {}),
      dontBreakRows: fit.dontBreakRows,
      widths: fit.widths,
      body: [
        headerCells.map((h, col) => ({
          ...h,
          ...(col === 0 ? { id: `${TABLE_HEADER_ID}${++env.tablesBuilt}` } : {}),
          bold: true,
          color: '#ffffff',
          fillColor: palette.primary,
          ...align(col),
        })),
        // pdfmake accepts a `text` array of inline runs as a cell — use that
        // so **bold** / *italic* / `code` inside cells render correctly.
        ...cells.map(row => row.map((cell, col) => ({ ...cell, ...align(col) }))),
      ],
    },
    layout: pdfTableLayout(layout, palette),
    margin: [0, 4, 0, 8],
    ...(fit.fontSize !== BODY_FONT_SIZE ? { fontSize: fit.fontSize } : {}),
  } as Content
  if (fit.landscape) env.landscape.add(node)
  return node
}

/**
 * Pad/truncate a row to a fixed number of columns. Used by table builders
 * to make ragged input deterministic.
 */
function normalizeRowLength<T>(row: T[], width: number): (T | '')[] {
  if (row.length === width) return row
  if (row.length > width) return row.slice(0, width)
  return [...row, ...Array<''>(width - row.length).fill('')]
}

function pdfTableLayout(name: 'striped' | 'minimal' | 'grid', palette: PdfPalette) {
  if (name === 'minimal') {
    return {
      hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
        i === 0 || i === 1 || i === node.table.body.length ? 0.7 : 0,
      vLineWidth: () => 0,
      hLineColor: () => palette.border,
    }
  }
  if (name === 'grid') {
    return {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => palette.border,
      vLineColor: () => palette.border,
    }
  }
  return {
    hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
      i === 0 || i === 1 || i === node.table.body.length ? 0.7 : 0,
    vLineWidth: () => 0,
    hLineColor: () => palette.border,
    fillColor: (rowIndex: number) =>
      rowIndex === 0 ? null : rowIndex % 2 === 0 ? palette.alternateRowFill : null,
  }
}

/** Read the alignments a GFM separator row declares (`:---`, `---:`, `:---:`). */
function parseColumnAlignments(separator: string): ColumnAlignment[] {
  return splitTableRow(separator).map(cell => {
    const c = cell.trim()
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/** Indent width of a list line, used to decide its nesting depth. */
function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line)
  if (!m) return 0
  // A tab counts as one level, matching how models write nested lists.
  return m[0].replace(/\t/g, '  ').length
}

const BULLET_RE = /^[-*+]\s+/
const ORDERED_RE = /^\d+[.)]\s+/

function isListLine(line: string): boolean {
  const t = line.trimStart()
  return BULLET_RE.test(t) || ORDERED_RE.test(t)
}

function stripListMarker(line: string): string {
  const t = line.trimStart()
  return t.replace(BULLET_RE, '').replace(ORDERED_RE, '')
}

/**
 * Build one list level, consuming the lines that belong to it. A line indented
 * further than the level's own indent starts a nested list attached to the item
 * above it, which is what preserves the hierarchy the author wrote.
 */
function buildList(
  lines: string[],
  start: number,
  indent: number,
  onImage: (image: MarkdownImage) => void
): { node: Content; next: number } {
  const ordered = ORDERED_RE.test(lines[start].trimStart())
  const items: Content[] = []
  let i = start

  while (i < lines.length) {
    if (lines[i].trim() === '') {
      // Blank lines between items keep the list going: models separate
      // numbered steps that way and expect the numbers to continue.
      let j = i
      while (j < lines.length && lines[j].trim() === '') j++
      const continues =
        j < lines.length &&
        isListLine(lines[j]) &&
        (indentOf(lines[j]) > indent ||
          (indentOf(lines[j]) === indent && ORDERED_RE.test(lines[j].trimStart()) === ordered))
      if (!continues) break
      i = j
      continue
    }
    if (!isListLine(lines[i]) || indentOf(lines[i]) < indent) break
    const own = indentOf(lines[i])
    if (own > indent) {
      // Deeper than this level: attach to the previous item as a sub-list.
      const sub = buildList(lines, i, own, onImage)
      const previous = items.pop()
      items.push(previous ? ([previous, sub.node] as unknown as Content) : sub.node)
      i = sub.next
      continue
    }
    const isOrdered = ORDERED_RE.test(lines[i].trimStart())
    // A different marker at the same indent starts a different list.
    if (isOrdered !== ordered) break
    items.push(parseInlineMarkdown(stripListMarker(lines[i]), onImage))
    i++
  }

  // A list that picks up after a code block or a paragraph keeps its numbers.
  const first = ordered ? parseInt(lines[start].trimStart(), 10) : 1
  const node = (
    ordered
      ? { ol: items, ...(first !== 1 ? { start: first } : {}), margin: [0, 4, 0, 6] }
      : { ul: items, margin: [0, 4, 0, 6] }
  ) as Content
  return { node, next: i }
}

/**
 * Convert a markdown body into pdfmake content nodes: a single-pass line
 * scanner for headings, fenced code, rules, GFM tables, quotes, lists, image
 * lines and paragraphs.
 */
function bodyToContent(body: string, palette: PdfPalette, env: PdfBodyEnv): Content[] {
  const out: Content[] = []
  const lines = body.split('\n')
  // A paragraph's images are placed after it; anywhere else they are left out
  // with a note rather than printing their path.
  const stray = (image: MarkdownImage) =>
    env.warnings.push(
      `The image '${image.src}' inside a table, list, heading or quote was left out; put ` +
        `![alt](${image.src}) on a line of its own to embed it.`
    )
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trimStart()

    // Fenced code block. Everything up to the closing fence is verbatim, so a
    // shell snippet or a config sample keeps its spacing instead of being
    // reflowed into paragraphs.
    const fence = openingFence(trimmed)
    if (fence) {
      const { marker, language } = fence
      const code: string[] = []
      i++
      while (i < lines.length && !closesFence(lines[i], marker)) {
        code.push(lines[i])
        i++
      }
      i++ // closing fence
      out.push(buildCodeBlock(code.join('\n'), language, palette))
      continue
    }

    // Heading levels. The deeper ones share h3's style rather than falling
    // through as literal hashes. headlineLevel marks them for the page-break
    // check that keeps a heading off the foot of a page.
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      const level = heading[1].length
      const style = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'
      const top = level === 1 ? 16 : level === 2 ? 12 : 8
      out.push({
        ...parseInlineMarkdown(withoutClosingHashes(heading[2]), stray),
        style,
        headlineLevel: 1,
        margin: [0, top, 0, level === 1 ? 6 : 4],
      } as Content)
      i++
      continue
    }

    // Horizontal rule in any of the three markdown spellings.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed.replace(/\s+/g, ''))) {
      out.push({
        canvas: [
          {
            type: 'line',
            x1: 0,
            y1: 0,
            x2: PDF_CONTENT_WIDTH,
            y2: 0,
            lineWidth: 0.5,
            lineColor: palette.border,
          },
        ],
        margin: [0, 8, 0, 8],
      })
      i++
      continue
    }

    // GFM pipe table: header line, then separator, then the rows up to the
    // first line without a pipe.
    if (isPipeTableStart(lines, i)) {
      const headers = splitTableRow(line)
      const alignments = parseColumnAlignments(lines[i + 1])
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      const label = `The body's table ${++env.tableCount}`
      out.push(
        buildTableNode(
          { headers, rows, alignments, label, rowLabel: index => `${label}, row ${index + 1}` },
          palette,
          env,
          stray
        )
      )
      continue
    }

    // Blockquote: consecutive `>` lines become one ruled, indented block.
    if (/^>\s?/.test(trimmed)) {
      const quoted: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i].trimStart())) {
        quoted.push(lines[i].trimStart().replace(/^>\s?/, ''))
        i++
      }
      out.push(buildBlockquote(quoteParagraphs(quoted), palette, stray))
      continue
    }

    // Bullet or numbered list, including anything nested under it.
    if (isListLine(line)) {
      const built = buildList(lines, i, indentOf(line), stray)
      out.push(built.node)
      i = built.next
      continue
    }

    // Blank line: small vertical breathing room.
    if (trimmed === '') {
      out.push({ text: '', margin: [0, 2, 0, 2] })
      i++
      continue
    }

    // Default: paragraph with inline markdown, then any images it references.
    const images: MarkdownImage[] = []
    const paragraph = parseInlineMarkdown(line, image => images.push(image))
    if (plainText(paragraph).trim() !== '') out.push({ ...paragraph, margin: [0, 0, 0, 4] })
    for (const image of images) {
      const block = env.image(image.src)
      if (block) out.push(block)
    }
    i++
  }
  return out
}

/** Monospaced block on a tinted ground, with the language noted when given. */
function buildCodeBlock(code: string, language: string, palette: PdfPalette): Content {
  const stack: Content[] = []
  if (language) {
    stack.push({
      text: language,
      fontSize: 8,
      color: palette.muted,
      margin: [0, 0, 0, 2],
    })
  }
  stack.push({
    text: code,
    font: PDF_MONO_FAMILY,
    fontSize: 9,
    color: palette.text,
    preserveLeadingSpaces: true,
    lineHeight: 1.25,
  } as Content)
  return {
    table: {
      // A numeric width lets pdfmake break a line with no spaces (base64,
      // minified JSON) inside the block; a '*' column is never narrower than
      // its longest word.
      widths: [PDF_CONTENT_WIDTH - 2],
      body: [[{ stack, margin: [8, 6, 8, 6] }]],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: (i: number) => (i === 0 ? 2 : 0),
      vLineColor: () => palette.border,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
      fillColor: () => palette.surface,
    },
    margin: [0, 6, 0, 8],
  } as Content
}

/** Quoted passage, set off by a rule down its left edge. */
function buildBlockquote(
  paragraphs: string[],
  palette: PdfPalette,
  onImage: (image: MarkdownImage) => void
): Content {
  return {
    table: {
      widths: [PDF_CONTENT_WIDTH - 2.5],
      body: [
        [
          {
            stack: paragraphs.map((text, n) => ({
              ...parseInlineMarkdown(text, onImage),
              margin: [0, 0, 0, n < paragraphs.length - 1 ? 4 : 0],
            })),
            italics: true,
            color: palette.muted,
            margin: [10, 4, 6, 4],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: (i: number) => (i === 0 ? 2.5 : 0),
      vLineColor: () => palette.primary,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 6, 0, 8],
  } as Content
}

function statusColorFromPalette(palette: PdfPalette, status?: string): string | undefined {
  if (!status) return undefined
  const s = status.toLowerCase()
  if (s === 'green' || s === 'ok' || s === 'pass') return palette.statusGreen
  if (s === 'yellow' || s === 'warn' || s === 'warning') return palette.statusYellow
  if (s === 'red' || s === 'critical' || s === 'fail') return palette.statusRed
  // Unknown status keyword — fall back to muted accent so the band still
  // renders (matching the documented "status indicator color" behavior)
  // instead of silently dropping the cover-page band.
  return palette.muted
}

const IMAGE_ALIGNMENTS = new Set(['left', 'center', 'right'])

/** Where images come from, for the schema: the name clerum__generate_chart reports. */
const IMAGE_FILE_DESCRIPTION =
  "File name of a PNG or JPEG (GIF, WebP and SVG are converted) in the output folder, as returned by clerum__generate_chart, e.g. 'sales.png'."

/**
 * pdfmake 0.2 calls this with the nodes that follow on the same page as its
 * second argument (the bundled typings describe 0.3's query object instead).
 * A heading with nothing after it on its page but more content on the next
 * page is moved there, so it is never left alone at the foot of a page.
 */
function keepHeadingWithNext(node: Node, followingOnPage: Node[]): boolean {
  if (
    node.headlineLevel !== 1 ||
    node.pageNumbers.length !== 1 ||
    node.pageNumbers[0] >= node.pages ||
    // Already at the top of its page: moving it would only leave a blank page.
    node.startPosition.top <= PDF_TOP_MARGIN + 20
  ) {
    return false
  }
  const following = followingOnPage.filter(next => next.style !== RUNNING_STYLE)
  const content = following.find(next => next.headlineLevel !== 1)
  if (!content) return true
  // A table whose header row did not fit is carried to the next page whole,
  // yet its cells are still listed on this one; only the header id says so.
  const headerId = tableHeaderId(content)
  if (headerId === undefined) return false
  const header = following.find(next => next.id === headerId)
  return header?.startPosition.pageNumber !== node.pageNumbers[0]
}

/**
 * pdfmake hands a pageBreakBefore callback the nodes after each node on its
 * page, which it collects by scanning the rest of the document for every node,
 * and each break the callback asks for lays the whole document out again. Past
 * these sizes the check costs more than a heading left at the foot of a page.
 */
const KEEP_WITH_NEXT_MAX_NODES = 1500
const KEEP_WITH_NEXT_MAX_MOVES = 10

/** How many nodes pdfmake lays out for `content`, counted up to `limit`. */
function countNodes(content: unknown, limit: number): number {
  let count = 0
  const visit = (node: unknown): void => {
    if (count > limit || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    count++
    const n = node as Record<string, unknown>
    for (const key of ['stack', 'ul', 'ol', 'columns']) visit(n[key])
    const table = n.table as { body?: unknown } | undefined
    if (table) visit(table.body)
  }
  visit(content)
  return count
}

/** keepHeadingWithNext for `content`, or undefined when the document is too large for it. */
function headingKeeper(
  content: Content[]
): ((node: Node, following: Node[]) => boolean) | undefined {
  if (countNodes(content, KEEP_WITH_NEXT_MAX_NODES) > KEEP_WITH_NEXT_MAX_NODES) return undefined
  let moves = 0
  return (node: Node, following: Node[]) => {
    if (moves >= KEEP_WITH_NEXT_MAX_MOVES || !keepHeadingWithNext(node, following)) return false
    moves++
    return true
  }
}

/** The id buildTableNode gave a table's header; a right-to-left table has it last. */
function tableHeaderId(node: Node): string | undefined {
  const header = (node as { table?: { body?: Array<Array<{ id?: unknown }>> } }).table?.body?.[0]
  const id = Array.isArray(header)
    ? header.find(cell => typeof cell?.id === 'string')?.id
    : undefined
  return typeof id === 'string' && id.startsWith(TABLE_HEADER_ID) ? id : undefined
}

/** Note for a PDF or DOCX written with nothing in it. */
const EMPTY_DOCUMENT_NOTE =
  'The document is empty: body has no text, and no title, table or image was given. ' +
  'Pass the text to write as body.'

/** The spacer bodyToContent leaves for a blank line. */
function isBlankLine(node: Content): boolean {
  return typeof node === 'object' && node !== null && 'text' in node && node.text === ''
}

/**
 * Put each landscape table on landscape pages and return to portrait after
 * it. A heading directly above such a table moves with it. Returns the
 * orientation the document starts in.
 */
function applyPageOrientation(
  content: Content[],
  landscape: Set<Content>
): 'portrait' | 'landscape' {
  const previous = (i: number) => {
    let k = i - 1
    while (k >= 0 && isBlankLine(content[k])) k--
    return k
  }
  let initial: 'portrait' | 'landscape' = 'portrait'
  let current: 'portrait' | 'landscape' = 'portrait'
  for (let i = 0; i < content.length; i++) {
    if (isBlankLine(content[i])) continue
    const wanted = landscape.has(content[i]) ? 'landscape' : 'portrait'
    if (wanted === current) continue
    current = wanted
    let target = i
    const above = content[previous(i)] as { headlineLevel?: number } | undefined
    if (wanted === 'landscape' && above?.headlineLevel === 1) target = previous(i)
    // A break before the first node, or after the one that already ends the
    // cover page, would leave a blank page; those carry the orientation instead.
    const before = previous(target)
    if (before < 0) {
      initial = wanted
    } else if ((content[before] as { pageBreak?: string }).pageBreak === 'after') {
      Object.assign(content[before] as object, { pageOrientation: wanted })
    } else {
      Object.assign(content[target] as object, { pageBreak: 'before', pageOrientation: wanted })
    }
  }
  return initial
}

/**
 * The footer text as the lines it will take, cut to what the bottom margin
 * can hold, with a note when anything is cut.
 */
/** More characters than a header or footer line ever holds at the running size. */
const RUNNING_LINE_CHARS = 400

/** The longest start of `chars` that fits `fits`, at least one character. */
function longestFitting(chars: string[], fits: (text: string) => boolean): number {
  let lo = 1
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(chars.slice(0, mid).join(''))) lo = mid
    else hi = mid - 1
  }
  return lo
}

function footerLines(
  text: string,
  width: number,
  measure: UnitMeasure,
  warnings: string[]
): string[] {
  // Lines break where the typesetter breaks them, or the footer outgrows its margin.
  const fits = (s: string) => measure(s, false) * PDF_FOOTER_SIZE <= width * LINE_FILL
  // Far more characters than a footer line holds, so a huge word is never measured whole.
  const tooWide = (s: string) => s.length > RUNNING_LINE_CHARS || !fits(s)
  const lines: string[] = []
  // Counting stops one line past the most the footer holds.
  const full = () => lines.length > PDF_MAX_FOOTER_LINES
  for (const source of text.split('\n')) {
    let line = ''
    for (const word of source.split(/(\s+)/)) {
      if (full()) break
      if (line.trim() && tooWide(line + word)) {
        lines.push(line.trimEnd())
        line = word.trimStart()
      } else {
        line += word
      }
      // A word wider than the line, such as a long URL, takes as many lines as it fills.
      while (!full() && tooWide(line)) {
        const head = Array.from(line.slice(0, RUNNING_LINE_CHARS))
        if (head.length <= 1) break
        const piece = head.slice(0, longestFitting(head, fits)).join('')
        lines.push(piece)
        line = line.slice(piece.length)
      }
    }
    if (full()) break
    lines.push(line.trimEnd())
  }
  if (!full()) return lines
  warnings.push(
    `branding.footerText takes more than ${PDF_MAX_FOOTER_LINES} lines, the most that fit in the ` +
      'footer, so the rest was cut. Keep it to a line or two.'
  )
  const kept = lines.slice(0, PDF_MAX_FOOTER_LINES)
  kept[kept.length - 1] = `${kept[kept.length - 1]}...`
  return kept
}

/**
 * `text` cut at a word, with an ellipsis, to one line of the running header,
 * where pdfmake drops whatever does not fit without a mark.
 */
function runningLine(text: string, width: number, measure: UnitMeasure): string {
  const fits = (s: string) => measure(s, false) * PDF_FOOTER_SIZE <= width * LINE_FILL
  if (text.length <= RUNNING_LINE_CHARS && fits(text)) return text
  // Far more than a line holds, so a huge title is never measured whole.
  const chars = Array.from(text.slice(0, RUNNING_LINE_CHARS))
  let kept = chars
    .slice(
      0,
      longestFitting(chars, s => fits(`${s.trimEnd()}…`))
    )
    .join('')
  const space = kept.lastIndexOf(' ')
  if (space > kept.length * 0.6) kept = kept.slice(0, space)
  return `${kept.trimEnd()}…`
}

const generatePdf: InternalToolDefinition = {
  name: 'clerum__generate_pdf',
  description:
    'Generate a print-quality PDF from a markdown body, with optional images, tables, a cover ' +
    'page with a status band, page numbers and a branded footer.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename, e.g. 'report.pdf'.",
      },
      title: {
        type: 'string',
        description: 'Document title, shown at the top of the first page.',
      },
      body: {
        type: 'string',
        description:
          'Markdown: # to ### headings, **bold**, *italic*, ~~strike~~, `code`, [links](url), ' +
          'fenced code, "- " and "1. " lists, GFM pipe tables, "> " quotes, "---" rules, <br>/<b>/<i>, ' +
          'and ![alt](file.png) on its own line to place an image from the output folder.',
      },
      palette: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description: "Color palette. Default 'default'.",
      },
      coverPage: {
        type: 'boolean',
        description: 'Add a cover page with the title, headline, logo and status band.',
      },
      headline: {
        type: 'string',
        description: 'One-line subtitle under the title on the cover page.',
      },
      statusColor: {
        type: 'string',
        enum: ['green', 'yellow', 'red'],
        description: 'Color of the status band on the cover page.',
      },
      images: {
        type: 'array',
        description:
          'Images (charts, logos) placed after the body and tables, in order; ' +
          'put ![alt](file.png) on a line of the body to place one there.',
        items: {
          anyOf: [
            { type: 'string', description: IMAGE_FILE_DESCRIPTION },
            {
              type: 'object',
              required: ['path'],
              properties: {
                path: { type: 'string', description: IMAGE_FILE_DESCRIPTION },
                width: {
                  type: 'number',
                  description: 'Width in points (the page is 515 wide); the height follows.',
                },
                height: {
                  type: 'number',
                  description: 'Height in points. With width too, the image fits inside both.',
                },
                alignment: {
                  type: 'string',
                  enum: ['left', 'center', 'right'],
                  description: "Default 'center'.",
                },
              },
            },
          ],
          description: 'A file name, or an object with path and size.',
        },
      },
      tables: {
        type: 'array',
        description: 'Tables placed after the body.',
        items: {
          type: 'object',
          required: ['headers', 'rows'],
          properties: {
            headers: {
              type: 'array',
              items: { type: ['string', 'number'], description: 'One column heading.' },
              description: 'Column headings, left to right.',
            },
            rows: {
              type: 'array',
              items: ROW_SCHEMA,
              description: 'Rows, each an array of cells in header order.',
            },
            widths: {
              type: 'array',
              items: { type: ['string', 'number'], description: 'One column width.' },
              description:
                "One per header: points, a percentage such as '30%', 'auto' or '*' (share the rest). " +
                'Omit to size columns by content.',
            },
            layout: {
              type: 'string',
              enum: ['striped', 'minimal', 'grid'],
              description: "Default 'striped'.",
            },
          },
        },
      },
      branding: {
        type: 'object',
        description: 'Header and footer branding.',
        properties: {
          logoPath: {
            type: 'string',
            description: `Logo drawn on the cover page (needs coverPage: true). ${IMAGE_FILE_DESCRIPTION}`,
          },
          companyName: {
            type: 'string',
            description: 'Shown in the running header.',
          },
          footerText: {
            type: 'string',
            description: `Footer on every page, up to ${PDF_MAX_FOOTER_LINES} lines.`,
          },
        },
      },
    },
    required: ['filename', 'body'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    try {
      const filename = outputFilename(args.filename, 'pdf', 'output')
      const warnings: string[] = []
      const glyphs = pdfGlyphSource()
      // Titles take no formatting, so HTML in them is read as text.
      const title = args.title ? htmlToPlainText(String(args.title)) || undefined : undefined
      const body = String(args.body ?? '')
      const paletteName = String(args.palette ?? 'default')
      const palette = PDF_PALETTES[paletteName] ?? PDF_PALETTES.default
      const branding: PdfBranding = printedBranding(args.branding)
      const imageRefs = Array.isArray(args.images) ? args.images : []
      const tables = (Array.isArray(args.tables) ? args.tables : []) as PdfTableSpec[]
      const coverPage = Boolean(args.coverPage)
      const headline = args.headline
        ? htmlToPlainText(String(args.headline)) || undefined
        : undefined
      const statusBand = statusColorFromPalette(palette, args.statusColor as string | undefined)

      // A path outside the output folder still fails the call, but says what to pass instead.
      const loadImage = (ref: unknown, label: string) => {
        try {
          return loadEmbeddableImage(ref, outputDir, warnings, label)
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          throw new Error(
            `${label}: ${reason}. Images are read from the output folder; pass the file name ` +
              "clerum__generate_chart returned, such as 'sales.png'."
          )
        }
      }

      // The footer sets the bottom margin, and with it the room images and tables have.
      const pageNumberWidth = 40
      // Measured at 100pt and scaled down: at 1pt the canvas rounds widths to hundredths.
      const measure: UnitMeasure = (text, bold) =>
        glyphs.measure(text, PDF_FONT_FAMILY, 100, bold) / 100
      const footer = branding.footerText
        ? footerLines(branding.footerText, PDF_CONTENT_WIDTH - pageNumberWidth, measure, warnings)
        : []
      const bottomMargin = Math.max(MIN_BOTTOM_MARGIN, 34 + footer.length * PDF_FOOTER_SIZE * 1.3)
      const contentHeight = PORTRAIT.height - (bottomMargin - MIN_BOTTOM_MARGIN)

      let imagesRequested = 0
      let imagesPlaced = 0
      const placeImage = (
        ref: unknown,
        label: string,
        sizing: { width?: unknown; height?: unknown; alignment?: unknown } = {}
      ): Content | undefined => {
        imagesRequested++
        const src = typeof ref === 'string' ? ref : undefined
        if (src && /^(https?:|data:)/i.test(src)) {
          warnings.push(
            `${label} is a web address or inline data, which is not downloaded; save the image to the ` +
              'output folder first (clerum__generate_chart does) and pass its file name.'
          )
          return undefined
        }
        const image = loadImage(ref, label)
        if (!image) return undefined
        const requested = {
          ...(typeof sizing.width === 'number' ? { width: sizing.width } : {}),
          ...(typeof sizing.height === 'number' ? { height: sizing.height } : {}),
        }
        const sized = requested.width !== undefined || requested.height !== undefined
        const box = fitImageSize(
          image,
          {
            width: PDF_CONTENT_WIDTH,
            // An image given a size may take the page, less its own margins.
            height: sized ? contentHeight - 2 * PDF_IMAGE_MARGIN : PDF_MAX_IMAGE_HEIGHT,
          },
          requested
        )
        imagesPlaced++
        return {
          image: imageDataUrl(image),
          width: box.width,
          height: box.height,
          alignment: IMAGE_ALIGNMENTS.has(String(sizing.alignment)) ? sizing.alignment : 'center',
          margin: [0, PDF_IMAGE_MARGIN, 0, PDF_IMAGE_MARGIN],
        } as Content
      }

      const env: PdfBodyEnv = {
        warnings,
        measure,
        image: src => placeImage(src, `The body image '${src}'`),
        landscape: new Set(),
        tableCount: 0,
        tablesBuilt: 0,
        bottomMargin,
      }

      const content: Content[] = []

      // Cover page.
      if (coverPage) {
        const coverTitle = title ?? headline ?? filename.replace(/\.pdf$/, '')
        if (!title) {
          warnings.push(
            `coverPage was set without a title, so the cover shows '${coverTitle}'; pass title to choose it.`
          )
        }
        if (statusBand) {
          content.push({
            canvas: [
              {
                type: 'rect',
                x: 0,
                y: 0,
                w: PDF_CONTENT_WIDTH,
                h: 6,
                color: statusBand,
              },
            ],
            margin: [0, 0, 0, 24],
          })
        }
        if (branding.logoPath) {
          const logo = loadImage(branding.logoPath, 'branding.logoPath')
          if (logo) {
            const box = fitImageSize(logo, PDF_LOGO_BOX, { width: PDF_LOGO_BOX.width })
            content.push({
              image: imageDataUrl(logo),
              width: box.width,
              height: box.height,
              margin: [0, 0, 0, 12],
            })
          }
        }
        content.push({
          text: coverTitle,
          style: 'cover',
          color: palette.primary,
          margin: [0, 80, 0, 12],
        })
        if (headline && title) {
          content.push({
            text: headline,
            style: 'lead',
            color: palette.muted,
            margin: [0, 0, 0, 20],
          })
        }
        content.push({
          text: new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }),
          color: palette.muted,
          fontSize: 11,
          margin: [0, 0, 0, 0],
          pageBreak: 'after',
        })
      } else {
        if (title) {
          content.push({
            text: title,
            style: 'docTitle',
            color: palette.primary,
            margin: [0, 0, 0, 12],
          })
        }
        const coverOnly = [
          headline ? 'headline' : '',
          args.statusColor ? 'statusColor' : '',
          branding.logoPath ? 'branding.logoPath' : '',
        ].filter(Boolean)
        if (coverOnly.length > 0) {
          const many = coverOnly.length > 1
          warnings.push(
            `${coverOnly.join(', ')} ${many ? 'are' : 'is'} only drawn on the cover page, so ` +
              `${many ? 'they were' : 'it was'} left out; pass coverPage: true to show ${many ? 'them' : 'it'}.`
          )
        }
      }

      // Body.
      content.push(...bodyToContent(body, palette, env))

      // Tables (after body).
      tables.forEach((t, index) => {
        const label = `tables[${index}]`
        if (!t || !Array.isArray(t.headers) || t.headers.length === 0) {
          warnings.push(`${label} has no headers and was left out; pass headers: ['Column', ...].`)
          return
        }
        const rows = normalizeTableRows(t.rows, t.headers, label, warnings).map(row =>
          row.map(cell => (cell === null || cell === undefined ? '' : String(cell)))
        )
        content.push(
          buildTableNode(
            {
              headers: t.headers.map(headerText),
              rows,
              layout: t.layout,
              widths: t.widths,
              label,
              rowLabel: row => `${label}.rows[${row}]`,
            },
            palette,
            env,
            image =>
              warnings.push(
                `${label} names the image '${image.src}' in a cell, which a table cannot hold; pass it in images instead.`
              )
          )
        )
      })

      // Images (charts, logos) at the end of the body.
      imageRefs.forEach((ref, index) => {
        const sizing = ref && typeof ref === 'object' ? (ref as PdfImageRef) : {}
        const block = placeImage(ref, `images[${index}]`, sizing)
        if (block) content.push(block)
      })

      if (imagesRequested > 0 && imagesPlaced === 0 && content.every(isBlankLine)) {
        return {
          success: false,
          error: `No PDF was written: none of the images could be embedded. ${warnings.join(' ')}`,
        }
      }
      if (content.every(isBlankLine)) warnings.push(EMPTY_DOCUMENT_NOTE)

      const pageOrientation = applyPageOrientation(content, env.landscape)

      const styles: Record<string, Record<string, unknown>> = {
        cover: { fontSize: 36, bold: true },
        lead: { fontSize: 16, italics: true },
        docTitle: { fontSize: 22, bold: true },
        h1: { fontSize: 18, bold: true, color: palette.primary },
        h2: { fontSize: 14, bold: true, color: palette.primary },
        h3: { fontSize: 12, bold: true, color: palette.muted },
        [RUNNING_STYLE]: { fontSize: PDF_FOOTER_SIZE, color: palette.muted },
      }
      const typesetter = new PdfTypesetter(glyphs, styles)
      const base = {
        width: PDF_CONTENT_WIDTH,
        font: PDF_FONT_FAMILY,
        fontSize: BODY_FONT_SIZE,
        bold: false,
        lineHeight: PDF_LINE_HEIGHT,
      }
      typesetter.typeset(content, base)

      // The running header and footer are laid out on every page, so their text
      // is typeset once here and copied into each page's nodes.
      const running = (text: string | undefined, width: number): ContentText => {
        const node: ContentText = { text: text ?? '', style: RUNNING_STYLE }
        typesetter.typeset(node, { ...base, width })
        return node
      }
      // The title is printed whole on the first page; the running header takes one line of it.
      const half = PDF_CONTENT_WIDTH / 2
      const company = branding.companyName && runningLine(branding.companyName, half, measure)
      if (company && company !== branding.companyName) {
        warnings.push(
          'branding.companyName is longer than the page header and was shortened there.'
        )
      }
      const companyNode = running(company || undefined, half)
      const headerTitleNode = running(title && runningLine(title, half, measure), half)
      const footerNode = running(footer.join('\n'), PDF_CONTENT_WIDTH - pageNumberWidth)
      typesetter.settleShaping()
      const copy = (node: ContentText): ContentText => JSON.parse(JSON.stringify(node))

      const docDef: TDocumentDefinitions = {
        info: {
          title: title ?? 'Report',
          ...(branding.companyName ? { creator: branding.companyName } : {}),
        },
        pageSize: 'A4',
        pageOrientation,
        pageMargins: [40, PDF_TOP_MARGIN, 40, bottomMargin],
        defaultStyle: {
          font: PDF_FONT_FAMILY,
          fontSize: BODY_FONT_SIZE,
          color: palette.text,
          lineHeight: PDF_LINE_HEIGHT,
        },
        styles,
        pageBreakBefore: headingKeeper(
          content
        ) as unknown as TDocumentDefinitions['pageBreakBefore'],
        header: (currentPage: number) =>
          currentPage === 1 && coverPage
            ? null
            : {
                columns: [copy(companyNode), { ...copy(headerTitleNode), alignment: 'right' }],
                style: RUNNING_STYLE,
                margin: [40, 24, 40, 0],
              },
        footer: (currentPage: number, pageCount: number) => ({
          columns: [
            copy(footerNode),
            {
              text: `${currentPage} / ${pageCount}`,
              style: RUNNING_STYLE,
              alignment: 'right',
              width: pageNumberWidth,
            },
          ],
          style: RUNNING_STYLE,
          margin: [40, 0, 40, 24],
        }),
        content,
      }

      const printer = new PdfPrinter(glyphs.descriptors(typesetter.families))
      const pdfDoc = printer.createPdfKitDocument(docDef)

      const pdfBuffer: Buffer = await new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        pdfDoc.on('data', (c: Buffer) => chunks.push(c))
        pdfDoc.on('end', () => resolve(Buffer.concat(chunks)))
        pdfDoc.on('error', reject)
        pdfDoc.end()
      })

      ensureDir(outputDir)
      const target = claimOutputFile(outputDir, filename)
      enforceQuota(outputDir, pdfBuffer.byteLength, replacedBytes(target))
      fs.writeFileSync(target.filePath, pdfBuffer)

      return artifactResult(target, 'pdf', { warnings: [...warnings, ...typesetter.warnings()] })
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

// ─── generate_docx ───────────────────────────────────────────────────

/** Largest logo drawn above the title, in pixels. */
const DOCX_LOGO_BOX = { width: 160, height: 60 }

/** Footer lines kept, as in the PDF. */
const DOCX_MAX_FOOTER_LINES = 6

const DOCX_IMAGE_FILE_DESCRIPTION =
  "File name in the output folder, as returned by clerum__generate_chart (e.g. 'sales.png'). " +
  'PNG, JPEG, GIF, WebP or SVG.'

interface DocxBranding {
  companyName?: string
  logoPath?: string
  footerText?: string
}

interface DocxImageArg {
  width?: number
  height?: number
  alignment?: string
}

interface DocxTableArg {
  headers?: unknown
  rows?: unknown
  layout?: unknown
}

const generateDocx: InternalToolDefinition = {
  name: 'clerum__generate_docx',
  description:
    'Generate a styled Word (.docx) file from a markdown body, with optional tables, images, ' +
    'a palette and a branded header and footer with page numbers. The result lists anything ' +
    'left out.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'report.docx'); .docx added if missing.",
      },
      title: {
        type: 'string',
        description: 'Title at the top, also in the running header.',
      },
      body: {
        type: 'string',
        description:
          'Markdown: # to ###### headings, **bold**, *italic*, `code`, [links](https://...), ' +
          '"- " and "1. " lists (indent to nest), GFM pipe tables, ``` code blocks, > quotes, ' +
          '--- rules, <br>. ![alt](chart.png) on its own line embeds an image from the output folder.',
      },
      palette: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description: "Color palette. Default 'default'.",
      },
      headline: {
        type: 'string',
        description: 'One-line subtitle under the title.',
      },
      images: {
        type: 'array',
        description: 'Images added after the body and tables, in order.',
        items: {
          anyOf: [
            { type: 'string', description: DOCX_IMAGE_FILE_DESCRIPTION },
            {
              type: 'object',
              required: ['path'],
              properties: {
                path: { type: 'string', description: 'Same as the string form.' },
                width: {
                  type: 'number',
                  description: 'Width in px; proportions are kept and the image fits the page.',
                },
                height: { type: 'number', description: 'Height in px; as for width.' },
                alignment: {
                  type: 'string',
                  enum: ['left', 'center', 'right'],
                  description: "Default 'left'.",
                },
              },
            },
          ],
          description: 'An image file name, or {path, width, height, alignment}.',
        },
      },
      tables: {
        type: 'array',
        description: 'Tables added after the body.',
        items: {
          type: 'object',
          required: ['headers', 'rows'],
          properties: {
            headers: {
              type: 'array',
              items: {
                type: ['string', 'number'],
                description: 'Heading text or number.',
              },
              description: 'Column headings, left to right.',
            },
            rows: {
              type: 'array',
              items: ROW_SCHEMA,
              description: 'Rows of cells in header order. Cells take inline markdown and <br>.',
            },
            layout: {
              type: 'string',
              enum: ['striped', 'minimal', 'grid'],
              description:
                "striped: alternating fills; minimal: a rule under the header; grid: all borders. Default 'striped'.",
            },
          },
        },
      },
      branding: {
        type: 'object',
        description: 'Branding for the header, footer and first page.',
        properties: {
          companyName: { type: 'string', description: 'Left side of the running header.' },
          logoPath: {
            type: 'string',
            description: 'Logo above the title; an image file name as in images.',
          },
          footerText: {
            type: 'string',
            description: 'Text at the left of every footer; \\n starts a new line (up to 6).',
          },
        },
      },
    },
    required: ['filename', 'body'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    try {
      const filename = outputFilename(args.filename, 'docx', 'output')
      const title = args.title ? htmlToPlainText(String(args.title)) : undefined
      const headline = args.headline ? htmlToPlainText(String(args.headline)) : undefined
      const body = String(args.body ?? '')
      const palette = DOCX_PALETTES[String(args.palette ?? 'default')] ?? DOCX_PALETTES.default
      const branding: DocxBranding = printedBranding(args.branding)
      const images: unknown[] = Array.isArray(args.images) ? args.images : []
      const tables: unknown[] = Array.isArray(args.tables) ? args.tables : []
      const warnings: string[] = []
      const numbering = new DocxListNumbering()
      const imageBox = { width: DOCX_MAX_IMAGE_WIDTH, height: DOCX_MAX_IMAGE_HEIGHT }
      let embedded = 0
      let imageLeftOut = false
      const embed = (
        ref: unknown,
        label: string,
        box: { width: number; height: number },
        placement: DocxImagePlacement
      ): Paragraph | undefined => {
        const paragraph = docxImageParagraph(ref, outputDir, box, placement, warnings, label)
        if (paragraph) embedded++
        else imageLeftOut = true
        return paragraph
      }

      const children: (Paragraph | DocxTable)[] = []

      if (branding.logoPath) {
        const logo = embed(branding.logoPath, 'branding.logoPath', DOCX_LOGO_BOX, {
          spacing: { after: 160 },
        })
        if (logo) children.push(logo)
      }
      if (title) {
        children.push(
          new Paragraph({
            ...docxDirection(title),
            heading: HeadingLevel.TITLE,
            spacing: { after: 120 },
            children: textRuns(
              title,
              { bold: true, color: docxHex(palette.primary), size: 48 },
              eastAsianScript(title)
            ),
          })
        )
      }
      if (headline) {
        children.push(
          new Paragraph({
            ...docxDirection(headline),
            spacing: { after: 240 },
            children: textRuns(
              headline,
              { italics: true, color: docxHex(palette.muted), size: 26 },
              eastAsianScript(headline)
            ),
          })
        )
      }

      children.push(
        ...bodyToDocxChildren(body, {
          palette,
          numbering,
          warnings,
          image: (file, alt) =>
            embed(file, 'body', imageBox, {
              altText: alt,
              spacing: { before: 120, after: 120 },
            }),
        })
      )

      let tablesWritten = 0
      const tableTexts: unknown[] = []
      tables.forEach((table, i) => {
        const spec = (table && typeof table === 'object' ? table : {}) as DocxTableArg
        const headers = Array.isArray(spec.headers) ? spec.headers : []
        if (headers.length === 0) {
          warnings.push(
            `tables[${i}] has no headers and was left out; give it a headers array of column names.`
          )
          return
        }
        const rows = normalizeTableRows(spec.rows, headers, `tables[${i}]`, warnings)
        tableTexts.push(...headers)
        for (const row of rows) tableTexts.push(...row)
        const layout = spec.layout === 'minimal' || spec.layout === 'grid' ? spec.layout : 'striped'
        children.push(buildDocxTable(headers, rows, palette, layout, warnings, `tables[${i}]`))
        children.push(new Paragraph({ children: [new TextRun({ text: '' })] }))
        tablesWritten++
      })

      images.forEach((img, i) => {
        const spec = (img && typeof img === 'object' ? img : {}) as DocxImageArg
        const paragraph = embed(img, `images[${i}]`, imageBox, {
          width: spec.width,
          height: spec.height,
          alignment: spec.alignment,
          spacing: { before: 160, after: 160 },
        })
        if (paragraph) children.push(paragraph)
      })

      if (embedded === 0 && !title && !headline && tablesWritten === 0 && !bodyHasText(body)) {
        if (warnings.length > 0) {
          const hint = imageLeftOut
            ? ' Pass images as file names in the output folder, such as those clerum__generate_chart returns.'
            : ''
          return {
            success: false,
            error: `Nothing could be written to ${filename}. ${[...new Set(warnings)].join(' ')}${hint}`,
          }
        }
        warnings.push(EMPTY_DOCUMENT_NOTE)
      }

      // The page number follows the first footer line; the docx lib writes it as
      // a field Word fills in on open. The other lines are run from a leading
      // newline and lose its empty run, so each starts on a line of its own.
      const footerMuted = { color: docxHex(palette.muted), size: 18 }
      const footerLines = (branding.footerText ?? '').replace(/\r\n?/g, '\n').split('\n')
      if (footerLines.length > DOCX_MAX_FOOTER_LINES) {
        warnings.push(
          `branding.footerText takes ${footerLines.length} lines, but only ` +
            `${DOCX_MAX_FOOTER_LINES} fit in the footer, so the rest was cut. Keep it to a line or two.`
        )
        footerLines.length = DOCX_MAX_FOOTER_LINES
        footerLines[DOCX_MAX_FOOTER_LINES - 1] += '...'
      }
      const [firstFooterLine, ...moreFooterLines] = footerLines
      const footer = new DocxFooter({
        children: [
          new Paragraph({
            alignment: AlignmentType.LEFT,
            children: [
              ...textRuns(firstFooterLine, footerMuted, eastAsianScript(firstFooterLine)),
              new TextRun({ text: '\t\t', ...footerMuted }),
              new TextRun({ children: ['Page ', PageNumber.CURRENT], ...footerMuted }),
              new TextRun({ children: [' / ', PageNumber.TOTAL_PAGES], ...footerMuted }),
              ...(moreFooterLines.length > 0
                ? textRuns(
                    `\n${moreFooterLines.join('\n')}`,
                    footerMuted,
                    eastAsianScript(moreFooterLines.join(' '))
                  ).slice(1)
                : []),
            ],
          }),
        ],
      })

      // Header with company name + title.
      const headerMuted = { color: docxHex(palette.muted), size: 18 }
      const companyName = branding.companyName ?? ''
      const header = new DocxHeader({
        children: [
          new Paragraph({
            alignment: AlignmentType.LEFT,
            children: [
              ...textRuns(companyName, headerMuted, eastAsianScript(companyName)),
              new TextRun({ text: '\t\t', ...headerMuted }),
              ...textRuns(title ?? '', headerMuted, eastAsianScript(title ?? '')),
            ],
          }),
        ],
      })

      // Runs of Han characters alone name no East Asian face and take this one.
      const eastAsia = documentEastAsianScript(
        [title, headline, body, branding.companyName, branding.footerText, ...tableTexts]
          .filter((text): text is string => typeof text === 'string')
          .join('\n')
      )
      const doc = new DocxDocument({
        creator: branding.companyName ?? '',
        title: title ?? 'Report',
        description: headline,
        styles: {
          default: {
            document: {
              run: {
                font: {
                  ascii: DOCX_LATIN_FONT,
                  hAnsi: DOCX_LATIN_FONT,
                  cs: DOCX_COMPLEX_FONT,
                  ...(eastAsia ? { eastAsia: eastAsia.font } : {}),
                },
                ...(eastAsia ? { language: { eastAsia: eastAsia.lang } } : {}),
                size: 22,
                color: docxHex(palette.text),
              },
              paragraph: { spacing: { line: 320, after: 80 } },
            },
          },
        },
        numbering: { config: numbering.config() },
        sections: docxSections(children).map(section => ({
          properties: section.landscape
            ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } }
            : {},
          headers: { default: header },
          footers: { default: footer },
          children: section.children,
        })),
      })

      const buffer = await Packer.toBuffer(doc)
      ensureDir(outputDir)
      const target = claimOutputFile(outputDir, filename)
      enforceQuota(outputDir, buffer.byteLength, replacedBytes(target))
      fs.writeFileSync(target.filePath, buffer)

      return artifactResult(target, 'docx', { warnings: [...new Set(warnings)] })
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

// ─── generate_xlsx ───────────────────────────────────────────────────

const XLSX_CELL_SCHEMA = {
  type: ['string', 'number', 'boolean', 'null'],
  description:
    'A number, text, true/false, or null for empty. Text like "1,234.50", "$1,200", "45%" ' +
    'or an ISO date or datetime ("2026-09-22") is stored as a number or date; leading-zero codes and ' +
    'numbers over 15 digits stay text.',
}

const XLSX_IMAGE_PATH_DESCRIPTION =
  "File name in the output folder, as returned by clerum__generate_chart (e.g. 'sales.png')."

const XLSX_COLOR = 'hex such as "#1e3a8a" or a basic color name such as "green"'

const generateXlsx: InternalToolDefinition = {
  name: 'clerum__generate_xlsx',
  description:
    'Generate a styled Excel (.xlsx) workbook: per sheet, rows plus an optional title row, ' +
    'column formats, conditional formatting and images such as charts. Formulas are not ' +
    'supported: text starting with "=" stays text.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'data.xlsx'); .xlsx added if missing.",
      },
      palette: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description: "Color palette. Default 'default'.",
      },
      branding: {
        type: 'object',
        description: 'Workbook-level branding.',
        properties: {
          companyName: { type: 'string', description: 'Author/company in workbook properties.' },
          logoPath: {
            type: 'string',
            description:
              'Logo at the top of the first sheet; an image file name as in sheets[].images.',
          },
        },
      },
      sheets: {
        type: 'array',
        description: 'Worksheets, in tab order.',
        items: {
          type: 'object',
          required: ['name', 'rows'],
          properties: {
            name: {
              type: 'string',
              description: 'Tab name: up to 31 characters, none of \\ / ? * : [ ].',
            },
            headers: {
              type: 'array',
              description: 'Header row, when it is not the first row of rows.',
              items: { type: ['string', 'number'], description: 'Column header.' },
            },
            rows: {
              type: 'array',
              description:
                'Rows of cells; the first is the header row unless headers is given. [] for an images-only sheet.',
              items: {
                type: 'array',
                description: 'One row, left to right.',
                items: XLSX_CELL_SCHEMA,
              },
            },
            titleRow: {
              type: 'object',
              description: 'Merged title row above the header.',
              properties: {
                text: { type: 'string', description: 'Title text.' },
                fillColor: { type: 'string', description: `Background: ${XLSX_COLOR}.` },
                fontColor: { type: 'string', description: `Text color: ${XLSX_COLOR}.` },
              },
              required: ['text'],
            },
            columnFormats: {
              type: 'object',
              description:
                "Format per column, keyed by header text, letter ('B') or 0-based index: " +
                'currencyUsd, currencyUsdInt, currency:EUR (any ISO code), percent (0.45 = 45%), ' +
                'percentPoints (45 = 45%), integer, decimal, plain (no separators: years, IDs), ' +
                "date, datetime, text (as sent), or an Excel code like '#,##0.0'. Others are inferred.",
            },
            conditionalFormatting: {
              type: 'array',
              description: "Style a column's cells that match a rule.",
              items: {
                type: 'object',
                required: ['column', 'rules'],
                properties: {
                  column: {
                    type: ['string', 'number'],
                    description: "Header text, letter ('B') or 0-based index.",
                  },
                  rules: {
                    type: 'array',
                    description:
                      "Tested in order; the first match styles the cell. '45%' compares as 45, '$1,200' as 1200.",
                    items: {
                      type: 'object',
                      properties: {
                        equals: {
                          type: ['string', 'number', 'boolean'],
                          description: 'Cell equals this (text ignores case and outer spaces).',
                        },
                        notEquals: {
                          type: ['string', 'number', 'boolean'],
                          description: 'Cell differs from this, compared as for equals.',
                        },
                        greaterThan: {
                          type: 'number',
                          description: 'Cell is a number above this.',
                        },
                        lessThan: {
                          type: 'number',
                          description: 'Cell is a number below this.',
                        },
                        between: {
                          type: 'array',
                          items: { type: 'number' },
                          minItems: 2,
                          maxItems: 2,
                          description: 'Inclusive [min, max].',
                        },
                        contains: {
                          type: 'string',
                          description: 'Cell text contains this, ignoring case.',
                        },
                        regex: {
                          type: 'string',
                          maxLength: 256,
                          description:
                            'Regex tested on the cell text. Invalid patterns and nested unbounded quantifiers are skipped with a warning.',
                        },
                        fillColor: {
                          type: 'string',
                          description: `Background: ${XLSX_COLOR}.`,
                        },
                        fontColor: {
                          type: 'string',
                          description: `Text color: ${XLSX_COLOR}.`,
                        },
                        bold: {
                          type: 'boolean',
                          description: 'Bold the text.',
                        },
                      },
                    },
                  },
                },
              },
            },
            freezeHeader: {
              type: 'boolean',
              description: 'Freeze the header row. Default true.',
            },
            autoFilter: {
              type: 'boolean',
              description: 'Filter buttons on the header. Default true.',
            },
            images: {
              type: 'array',
              description:
                'Images such as charts; without anchor or range they stack below the data.',
              items: {
                anyOf: [
                  { type: 'string', description: XLSX_IMAGE_PATH_DESCRIPTION },
                  {
                    type: 'object',
                    required: ['path'],
                    properties: {
                      path: { type: 'string', description: 'Same as the string form.' },
                      anchor: { type: 'string', description: "Top-left cell, e.g. 'F2'." },
                      range: { type: 'string', description: "Cells to fill, e.g. 'F2:M20'." },
                      width: {
                        type: 'number',
                        description: 'Width in px; proportions are kept. Omit for automatic.',
                      },
                      height: { type: 'number', description: 'Height in px; as for width.' },
                    },
                  },
                ],
                description: 'An image file name, or {path, anchor | range, width, height}.',
              },
            },
          },
        },
      },
    },
    required: ['filename', 'sheets'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    try {
      const filename = outputFilename(args.filename, 'xlsx', 'output')
      const warnings: string[] = []
      const built = await buildXlsxWorkbook(
        args,
        outputDir,
        { width: XLSX_MAX_IMAGE_WIDTH, height: XLSX_MAX_IMAGE_HEIGHT },
        warnings
      )
      if (!built.ok) return { success: false, error: built.error }
      // The workbook is already in memory, so a quota breach leaves no partial file.
      ensureDir(outputDir)
      const target = claimOutputFile(outputDir, filename)
      enforceQuota(outputDir, built.buffer.byteLength, replacedBytes(target))
      fs.writeFileSync(target.filePath, built.buffer)
      return artifactResult(target, 'xlsx', {
        summary: `File generated: ${target.filename} (xlsx): ${built.summary}.`,
        warnings,
      })
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

// ════════════════════════════════════════════════════════════════════
// ─── DASHBOARD GENERATION (clerum__generate_dashboard) ──────────────
// ════════════════════════════════════════════════════════════════════
//
// Self-contained HTML dashboard renderer. Produces a single .html file
// with inlined CSS, plus the Chart.js bundle when the page has charts;
// works offline and prints cleanly.
//
// Templates (4 fixed presets):
//   - executive-brief   general-purpose daily/weekly executive report
//   - operations-pulse  engineering / SRE / oncall view
//   - financial-review  finance with hero chart + dense tables
//   - technical-report  long-form engineering writeup with code blocks
//
// Themes: default | corporate | warm | alert (light + dark variants)

// ─── CSS builder ────────────────────────────────────────────────────

function dashboardColorVars(c: DashboardThemeColors): string {
  return `
  --bg: ${c.bg};
  --surface: ${c.surface};
  --surface-muted: ${c.surfaceMuted};
  --text: ${c.text};
  --text-muted: ${c.textMuted};
  --text-soft: ${c.textSoft};
  --border: ${c.border};
  --primary: ${c.primary};
  --primary-hover: ${c.primaryHover};
  --accent: ${c.accent};
  --success: ${c.success};
  --warning: ${c.warning};
  --danger: ${c.danger};
  --success-bg: ${c.successBg};
  --warning-bg: ${c.warningBg};
  --danger-bg: ${c.dangerBg};
  --neutral-bg: ${c.neutralBg};
  ${c.chart.map((color, i) => `--chart-${i + 1}: ${color};`).join('\n  ')}`.trim()
}

/**
 * The page's styles. With no `mode` the page follows the viewer's color
 * scheme; a mode given is kept whatever the viewer's scheme. Print is light.
 */
function buildDashboardCss(theme: DashboardTheme, mode?: 'light' | 'dark'): string {
  const lightVars = dashboardColorVars(theme.light)
  const darkVars = dashboardColorVars(theme.dark)
  const baseVars = mode === 'dark' ? darkVars : lightVars
  const oppositeVars = mode === 'dark' ? lightVars : darkVars
  const oppositeKey = mode === 'dark' ? 'light' : 'dark'
  const viewerScheme =
    mode === undefined
      ? `
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    ${darkVars}
  }
}
`
      : ''

  return `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }

:root {
  ${baseVars}
  --font: ${theme.fontFamily};
  --radius-sm: 6px;
  --radius: 10px;
  --radius-lg: 14px;
  --shadow: 0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.04);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04);
}

[data-theme="${oppositeKey}"] {
  ${oppositeVars}
}
${viewerScheme}
body {
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.55;
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: var(--surface-muted);
  padding: 0.1em 0.3em;
  border-radius: 4px;
  color: var(--text);
}
strong, b { color: var(--text); font-weight: 600; }
em, i { font-style: italic; }

/* ─── Layout ──────────────────────────────────────────────────────── */

.dashboard {
  max-width: 1180px;
  margin: 0 auto;
  padding: 32px 24px 64px;
}

.hero {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 32px;
  margin-bottom: 28px;
  background: var(--surface);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  position: relative;
  overflow: hidden;
}
.hero::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 6px;
  background: var(--primary);
}
.hero[data-status="green"]::before  { background: var(--success); }
.hero[data-status="yellow"]::before { background: var(--warning); }
.hero[data-status="red"]::before    { background: var(--danger); }

.hero__eyebrow {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-soft);
}
.hero__title, .hero__headline, .kpi-card__label, .kpi-card__value, .kpi-card__delta,
.chart-card__title, .health-card__name, .health-card__metric, .timeline-item__title {
  overflow-wrap: anywhere;
}
.kpi-card, .chart-card, .health-card, .timeline-item__body { min-width: 0; }
.hero__title {
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
  margin: 0;
}
.hero__headline {
  font-size: 18px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.4;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  align-self: flex-start;
}
.status-badge[data-status="green"]   { background: var(--success-bg); color: var(--success); }
.status-badge[data-status="yellow"]  { background: var(--warning-bg); color: var(--warning); }
.status-badge[data-status="red"]     { background: var(--danger-bg);  color: var(--danger); }
.status-badge[data-status="neutral"] { background: var(--neutral-bg); color: var(--text-muted); }
.status-badge::before {
  content: '';
  width: 8px; height: 8px;
  border-radius: 50%;
  background: currentColor;
}

/* ─── Section ─────────────────────────────────────────────────────── */

.section {
  margin-bottom: 28px;
}
.section > :last-child { margin-bottom: 0; }
.section__title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin: 0 0 12px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}
.section__subtitle {
  font-size: 13px;
  color: var(--text-soft);
  font-weight: 400;
}

/* ─── KPI grid ────────────────────────────────────────────────────── */

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  margin-bottom: 28px;
}

.kpi-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: transform 0.12s ease;
}
.kpi-card:hover { transform: translateY(-2px); }

.kpi-card__label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-soft);
  margin: 0;
}
.kpi-card__value {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
  margin: 0;
  line-height: 1.1;
}
.kpi-card__delta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 600;
  margin: 0;
}
.kpi-card__delta[data-sentiment="good"]    { color: var(--success); }
.kpi-card__delta[data-sentiment="bad"]     { color: var(--danger); }
.kpi-card__delta[data-sentiment="neutral"] { color: var(--text-muted); }
.kpi-card__delta::before {
  font-size: 11px;
}
.kpi-card__delta[data-direction="up"]::before   { content: '▲'; }
.kpi-card__delta[data-direction="down"]::before { content: '▼'; }
.kpi-card__delta[data-direction="neutral"]::before { content: '·'; }

.kpi-card__sparkline-wrap {
  position: relative;
  margin-top: 8px;
  height: 36px;
  max-height: 36px;
  width: 100%;
  overflow: hidden;
  contain: size layout;
}
.kpi-card__sparkline {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 100% !important;
}

/* ─── Chart cards ─────────────────────────────────────────────────── */

.chart-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 16px;
  margin-bottom: 28px;
}

.chart-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  box-shadow: var(--shadow);
}
.chart-card__table {
  overflow-x: auto;
}
.chart-card__table .data-table {
  font-size: 13px;
}
.chart-card__note {
  margin: 0;
  padding: 24px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
}

.chart-card__caption {
  margin: 8px 0 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.chart-card__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 12px;
}
.chart-card__container {
  position: relative;
  height: 280px;
  max-height: 280px;
  width: 100%;
  overflow: hidden;
  contain: size layout;
}
.chart-card__container > canvas {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 100% !important;
}

/* ─── Data tables ─────────────────────────────────────────────────── */

.data-table-wrap {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow-x: auto;
  box-shadow: var(--shadow);
  margin-bottom: 28px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.data-table thead th {
  background: var(--primary);
  color: white;
  font-weight: 600;
  text-align: left;
  padding: 12px 16px;
  letter-spacing: 0.02em;
}
.data-table tbody td {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  color: var(--text);
  vertical-align: top;
}
.data-table tbody tr:nth-child(even) td {
  background: var(--surface-muted);
}
.severity-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.severity-critical, .severity-p0 { background: var(--danger-bg); color: var(--danger); }
.severity-high, .severity-p1     { background: var(--warning-bg); color: var(--warning); }
.severity-med                    { background: var(--neutral-bg); color: var(--text-muted); }
.severity-low, .severity-p2      { background: var(--success-bg); color: var(--success); }
.severity-info                   { background: var(--neutral-bg); color: var(--text-soft); }

/* ─── Callouts / risks / narrative ───────────────────────────────── */

.callout {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 4px solid var(--accent);
  border-radius: var(--radius);
  padding: 16px 20px;
  margin: 0 0 16px;
}
.callout[data-tone="warning"] { border-left-color: var(--warning); }
.callout[data-tone="danger"]  { border-left-color: var(--danger); }
.callout[data-tone="success"] { border-left-color: var(--success); }
.kpi-grid > .callout, .health-grid > .callout { margin: 0; }
.timeline-item > .callout { margin: 0 0 0 12px; }

.bullets {
  margin: 0;
  padding: 0 0 0 20px;
  color: var(--text);
}
.bullets li {
  margin-bottom: 8px;
  line-height: 1.55;
}
.bullets li::marker {
  color: var(--accent);
}

.narrative {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px 24px;
  font-size: 15px;
  line-height: 1.65;
  color: var(--text);
  box-shadow: var(--shadow);
}
.narrative p { margin: 0 0 12px; }
.narrative p:last-child { margin-bottom: 0; }

/* ─── Service health grid (operations-pulse) ─────────────────────── */

.health-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 28px;
}

.health-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 4px solid var(--text-muted);
  border-radius: var(--radius);
  padding: 14px 16px;
  box-shadow: var(--shadow);
}
.health-card[data-status="healthy"]     { border-left-color: var(--success); }
.health-card[data-status="degraded"]    { border-left-color: var(--warning); }
.health-card[data-status="down"]        { border-left-color: var(--danger); }
.health-card[data-status="maintenance"] { border-left-color: var(--text-muted); }

.health-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.health-card__dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
}
.health-card[data-status="healthy"]     .health-card__dot { background: var(--success); }
.health-card[data-status="degraded"]    .health-card__dot { background: var(--warning); }
.health-card[data-status="down"]        .health-card__dot { background: var(--danger); }
.health-card[data-status="maintenance"] .health-card__dot { background: var(--text-soft); }

.health-card__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}
.health-card__status {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin: 0 0 6px;
}
.health-card__metric {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  margin: 0;
  font-variant-numeric: tabular-nums;
}

/* ─── Incidents timeline (operations-pulse) ───────────────────────── */

.timeline {
  list-style: none;
  margin: 0 0 28px;
  padding: 0;
  position: relative;
}
.timeline::before {
  content: '';
  position: absolute;
  left: 88px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  background: var(--border);
}

.timeline-item {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 16px;
  padding: 12px 0;
  position: relative;
}
.timeline-item__time {
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
  padding-top: 4px;
}
.timeline-item::before {
  content: '';
  position: absolute;
  left: 84px;
  top: 18px;
  width: 10px; height: 10px;
  border-radius: 50%;
  background: var(--text-muted);
  border: 2px solid var(--surface);
  z-index: 1;
}
.timeline-item[data-severity="critical"]::before { background: var(--danger); }
.timeline-item[data-severity="high"]::before     { background: var(--warning); }
.timeline-item[data-severity="med"]::before      { background: var(--accent); }
.timeline-item[data-severity="low"]::before      { background: var(--success); }
.timeline-item[data-severity="info"]::before     { background: var(--text-soft); }

.timeline-item__body {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 16px;
  box-shadow: var(--shadow);
  margin-left: 12px;
}
.timeline-item__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.timeline-item__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
  flex: 1;
}
.timeline-item__open,
.timeline-item__resolved {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
}
.timeline-item__open      { background: var(--warning-bg); color: var(--warning); }
.timeline-item__resolved  { background: var(--success-bg); color: var(--success); }
.timeline-item__desc {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-muted);
}

/* ─── Code block (technical-report) ───────────────────────────────── */

.code-block {
  background: var(--surface-muted);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin: 0 0 16px;
  overflow: hidden;
}
.code-block__lang {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--surface);
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.code-block pre {
  margin: 0;
  padding: 14px 16px;
  overflow-x: auto;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
  background: transparent;
}
.code-block pre code {
  background: transparent;
  padding: 0;
  font-size: inherit;
  border-radius: 0;
}

/* ─── Wide / stacked chart layout (financial-review hero chart) ──── */

.chart-stack {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
  margin-bottom: 28px;
}
.chart-card--wide {
  /* spans full available width even inside a grid row */
}
.chart-card__container--tall {
  height: 360px;
  max-height: 360px;
}

/* ─── KPI accent overrides ────────────────────────────────────────── */

.kpi-card[data-accent="success"] { border-top: 3px solid var(--success); }
.kpi-card[data-accent="warning"] { border-top: 3px solid var(--warning); }
.kpi-card[data-accent="danger"]  { border-top: 3px solid var(--danger); }
.kpi-card[data-accent="neutral"] { border-top: 3px solid var(--text-soft); }

/* ─── Divider / spacer (custom template) ──────────────────────────── */

.dashboard-divider {
  border: none;
  border-top: 1px solid var(--border);
  margin: 28px 0;
}
.dashboard-spacer { display: block; }
.dashboard-spacer--sm { height: 12px; }
.dashboard-spacer--md { height: 28px; }
.dashboard-spacer--lg { height: 56px; }

/* ─── Footer ──────────────────────────────────────────────────────── */

.dash-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24px 0 0;
  border-top: 1px solid var(--border);
  margin-top: 40px;
  font-size: 12px;
  color: var(--text-soft);
}
.dash-footer__brand {
  font-weight: 600;
  color: var(--text-muted);
}

/* ─── Print ───────────────────────────────────────────────────────── */

@media print {
  :root, :root:not([data-theme]), [data-theme] {
    ${lightVars}
  }
  body { background: white; }
  .dashboard { max-width: 100%; padding: 0; }
  .kpi-card, .chart-card, .data-table-wrap, .narrative, .callout {
    box-shadow: none;
    break-inside: avoid;
  }
  .hero { box-shadow: none; }
  .section__title { break-after: avoid; }
  .data-table-wrap { overflow: visible; }
  .data-table { font-size: 11px; }
  .data-table thead th, .data-table tbody td { padding: 6px 8px; }
  .data-table--wide { font-size: 9px; }
  .data-table--wide thead th, .data-table--wide tbody td { padding: 4px; overflow-wrap: anywhere; }
}

/* ─── Responsive ──────────────────────────────────────────────────── */

@media (max-width: 640px) {
  .dashboard { padding: 16px 12px 40px; }
  .hero { padding: 24px; }
  .hero__title { font-size: 24px; }
  .hero__headline { font-size: 16px; }
  .kpi-card__value { font-size: 22px; }
  .chart-card__container { height: 220px; }
}
`.trim()
}

// ─── Render helpers (shared across templates) ──────────────────────
//
// The schema cannot say which fields each template or block type needs, so
// every helper reads its input defensively. A part that cannot be read throws
// an error naming the field; the caller replaces that part with a notice and
// reports it, and the rest still renders.

interface DashboardBranding {
  companyName?: string
  footerText?: string
}

/** State gathered while one dashboard renders. */
interface DashRender {
  charts: DashboardCharts
  warnings: string[]
  sparklines: number
  drawSparklines: boolean
  skippedSparklines: number
  /** Parts that rendered, to tell a partial page from an empty one. */
  rendered: number
  /** Why each part that could not be shown failed. */
  failures: string[]
}

function renderInlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([\s\S]+?)\*\*(?!\*)/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

function isDashRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describeDashValue(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return `a string (${JSON.stringify(value.slice(0, 40))})`
  return typeof value === 'object' ? 'an object' : `a ${typeof value} (${String(value)})`
}

function dashRecord(value: unknown, where: string, shape: string): Record<string, unknown> {
  if (!isDashRecord(value)) {
    throw new Error(`${where} must be ${shape}; received ${describeDashValue(value)}.`)
  }
  return value
}

function dashList(value: unknown, where: string, shape: string): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be an array of ${shape}; received ${describeDashValue(value)}.`)
  }
  return value
}

/** Text of a scalar; anything else reads as empty. */
function dashText(value: unknown): string {
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
function dashPart(ctx: DashRender, where: string, counts: boolean, render: () => string): string {
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

const HERO_STATUSES = ['green', 'yellow', 'red', 'neutral'] as const

function renderHero(o: Record<string, unknown>): string {
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

function renderKpis(items: unknown, where: string, ctx: DashRender, title?: string): string {
  const kpis = dashList(items, where, 'KPI objects {label, value}')
  if (kpis.length === 0) return ''
  const cards = dashItems(
    ctx,
    kpis,
    where,
    (item, at) => {
      const kpi = dashRecord(item, at, 'a KPI object {label, value}')
      // A year is not grouped: 2026, not 2,026.
      const year = typeof kpi.value === 'number' && YEAR_LABEL.test(dashText(kpi.label))
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

function renderChartCards(charts: unknown, where: string, ctx: DashRender, title?: string): string {
  const list = dashList(charts, where, 'chart objects {type, labels, datasets}')
  if (list.length === 0) return ''
  const cards = list.map((chart, i) => ctx.charts.card(chart, `${where}[${i}]`)).join('\n')
  return titledSection(title, `<section class="chart-grid">${cards}</section>`)
}

const BADGE_COLUMN_TYPES = new Set(['severity', 'priority', 'status'])

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
  return map[v] ?? ''
}

function renderTableHtml(t: unknown, where: string, ctx: DashRender, title?: string): string {
  const table = dashRecord(t, where, 'a table object {headers, rows}')
  const headers = table.headers
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new Error(`${where}.headers must be a non-empty array of column names.`)
  }
  const colTypes = isDashRecord(table.columnTypes) ? table.columnTypes : {}
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
          const colType = colTypes[c] ?? colTypes[headerNames[c]]
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
    if (row.slice(width).some(cell => dashText(cell).trim() !== '')) {
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

const SECTION_TYPES = ['narrative', 'bullets', 'callout', 'code'] as const
const CALLOUT_TONES = ['info', 'success', 'warning', 'danger'] as const

function renderSectionHtml(s: unknown, where: string): string {
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
  const key = text.toLowerCase()
  return Object.hasOwn(words, key) ? words[key] : undefined
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

function renderServiceHealthGrid(
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

function renderIncidentsTimeline(
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

function renderDashboardFooter(meta: unknown, branding: DashboardBranding): string {
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

interface DashWrapperOptions {
  title: string
  cssSource?: string
  chartJsSource?: string
  chartInit?: string
  body: string
}

function htmlWrapper(o: DashWrapperOptions): string {
  const styleBlock = o.cssSource ? `<style>${o.cssSource}</style>` : ''
  const scripts = o.chartInit
    ? `<script>${o.chartJsSource ?? ''}</script>\n<script>${o.chartInit}</script>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)}</title>
${styleBlock}
</head>
<body>
<main class="dashboard">
${o.body}
</main>
${scripts}
</body>
</html>`
}

// ─── Chart.js bundle loader (cached) ────────────────────────────────

let cachedChartJsBundle: string | undefined

/**
 * The Chart.js UMD bundle. chart.js exports only ".", "./auto" and
 * "./helpers", so resolving "chart.js/dist/chart.umd.js" throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED; the entry point resolves, and the bundle sits
 * beside it in dist/.
 */
export function loadChartJsBundle(): string {
  if (cachedChartJsBundle) return cachedChartJsBundle
  const bundle = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js')
  cachedChartJsBundle = fs.readFileSync(bundle, 'utf-8')
  return cachedChartJsBundle
}

// ─── Templates ──────────────────────────────────────────────────────

type DashboardTemplateName =
  | 'executive-brief'
  | 'operations-pulse'
  | 'financial-review'
  | 'technical-report'
  | 'custom'

type DashData = Record<string, unknown>

function heroOf(data: DashData, eyebrowFallback?: unknown): string {
  return renderHero({ ...data, eyebrow: data.eyebrow ?? eyebrowFallback })
}

function tablesOf(data: DashData, ctx: DashRender): string {
  return dashPart(ctx, 'data.tables', false, () =>
    dashList(data.tables, 'data.tables', 'table objects {headers, rows}')
      .map((t, i) => {
        const where = `data.tables[${i}]`
        return dashPart(ctx, where, true, () => renderTableHtml(t, where, ctx))
      })
      .join('\n')
  )
}

function sectionsOf(data: DashData, ctx: DashRender): string {
  return dashPart(ctx, 'data.sections', false, () =>
    dashList(data.sections, 'data.sections', 'section objects {type, content}')
      .map((s, i) => {
        const where = `data.sections[${i}]`
        return dashPart(ctx, where, true, () => renderSectionHtml(s, where))
      })
      .join('\n')
  )
}

function kpisOf(data: DashData, ctx: DashRender): string {
  return dashPart(ctx, 'data.kpis', false, () => renderKpis(data.kpis, 'data.kpis', ctx))
}

function chartsOf(data: DashData, ctx: DashRender, title: string | undefined): string {
  return dashPart(ctx, 'data.charts', false, () =>
    renderChartCards(data.charts, 'data.charts', ctx, title)
  )
}

const DASHBOARD_TEMPLATES: Record<
  DashboardTemplateName,
  (data: DashData, ctx: DashRender) => string[]
> = {
  'executive-brief': (data, ctx) => [
    heroOf(data),
    kpisOf(data, ctx),
    chartsOf(data, ctx, 'Visual Trends'),
    tablesOf(data, ctx),
    sectionsOf(data, ctx),
  ],
  'operations-pulse': (data, ctx) => [
    heroOf(data),
    dashPart(ctx, 'data.services', false, () =>
      renderServiceHealthGrid(data.services, 'data.services', ctx, 'Service Health')
    ),
    kpisOf(data, ctx),
    dashPart(ctx, 'data.incidents', false, () =>
      renderIncidentsTimeline(data.incidents, 'data.incidents', ctx, 'Incident Timeline')
    ),
    chartsOf(data, ctx, 'Performance Trends'),
    tablesOf(data, ctx),
    sectionsOf(data, ctx),
  ],
  'financial-review': (data, ctx) => {
    const hasHero = data.heroChart !== undefined && data.heroChart !== null
    return [
      heroOf(data, data.period),
      kpisOf(data, ctx),
      hasHero
        ? dashPart(
            ctx,
            'data.heroChart',
            false,
            () =>
              `<section class="chart-stack">${ctx.charts.card(data.heroChart, 'data.heroChart', { tall: true })}</section>`
          )
        : '',
      chartsOf(data, ctx, hasHero ? 'Breakdowns' : 'Visual Trends'),
      tablesOf(data, ctx),
      sectionsOf(data, ctx),
    ]
  },
  'technical-report': (data, ctx) => [
    heroOf(data),
    kpisOf(data, ctx),
    sectionsOf(data, ctx),
    tablesOf(data, ctx),
    chartsOf(data, ctx, 'Charts'),
  ],
  custom: (data, ctx) => {
    const blocks = dashList(data.blocks, 'data.blocks', 'block objects')
    if (blocks.length === 0) {
      throw new Error(
        "template 'custom' needs data.blocks: a non-empty array of blocks such as " +
          '{"type": "kpis", "items": [{"label": "Revenue", "value": "$1.2M"}]}.'
      )
    }
    return blocks.map((b, idx) => renderBlock(b, `data.blocks[${idx}]`, ctx))
  },
}

// ─── Custom template (composable blocks) ────────────────────────────

const BLOCK_TYPES = [
  'hero',
  'kpis',
  'chart',
  'charts-grid',
  'table',
  'narrative',
  'bullets',
  'code',
  'callout',
  'incidents',
  'service-health',
  'divider',
  'spacer',
] as const

/** Blocks that are content of their own; charts and card groups count their entries. */
const COUNTED_BLOCKS = new Set(['table', 'narrative', 'bullets', 'code', 'callout'])

function isEmptyList(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0)
}

/** The list field of each list block, and the other name models give it. */
const BLOCK_LISTS: Record<string, { field: 'items' | 'services'; alias: string; noun: string }> = {
  kpis: { field: 'items', alias: 'kpis', noun: 'cards' },
  'charts-grid': { field: 'items', alias: 'charts', noun: 'charts' },
  incidents: { field: 'items', alias: 'incidents', noun: 'incidents' },
  'service-health': { field: 'services', alias: 'items', noun: 'services' },
}

/** Whether `block` gives its list under the other name only. */
function listUnderAlias(block: Record<string, unknown>): boolean {
  const list = BLOCK_LISTS[String(block.type)]
  return !!list && isEmptyList(block[list.field]) && !isEmptyList(block[list.alias])
}

/**
 * The entries of a list block, from its field or from the other name models
 * give it. A block with no entries throws, so it is reported rather than left
 * off the page.
 */
function blockList(
  block: Record<string, unknown>,
  where: string,
  ctx: DashRender
): { value: unknown; at: string } {
  const { field, alias, noun } = BLOCK_LISTS[String(block.type)]
  if (listUnderAlias(block)) {
    ctx.warnings.push(`${where}: the list was read from ${alias}; name it ${field}.`)
    return { value: block[alias], at: `${where}.${alias}` }
  }
  if (isEmptyList(block[field])) {
    throw new Error(
      `${where}.${field} is missing or empty; a '${String(block.type)}' block lists its ${noun} in ${field}.`
    )
  }
  return { value: block[field], at: `${where}.${field}` }
}

function renderBlock(b: unknown, where: string, ctx: DashRender): string {
  const type = isDashRecord(b) ? b.type : undefined
  return dashPart(ctx, where, COUNTED_BLOCKS.has(String(type)), () => {
    const block = dashRecord(b, where, 'a block object with a type')
    const title = dashText(block.title) || undefined
    switch (block.type) {
      case 'hero':
        return renderHero(block)
      case 'kpis': {
        const list = blockList(block, where, ctx)
        return renderKpis(list.value, list.at, ctx, title)
      }
      case 'chart':
        if (!isDashRecord(block.spec)) {
          throw new Error(
            `${where} is a 'chart' block and needs spec: {type, labels, datasets}; ` +
              `received ${describeDashValue(block.spec)}.`
          )
        }
        return `<section class="chart-grid">${ctx.charts.card(block.spec, `${where}.spec`, { title })}</section>`
      case 'charts-grid': {
        const list = blockList(block, where, ctx)
        return renderChartCards(list.value, list.at, ctx, title)
      }
      case 'table':
        return renderTableHtml(block.spec, `${where}.spec`, ctx, title)
      case 'narrative':
      case 'code':
      case 'callout':
        return renderSectionHtml({ ...block, title }, where)
      case 'bullets':
        return renderSectionHtml(
          { type: 'bullets', title, content: block.items ?? block.content },
          block.items === undefined ? where : `${where}.items`
        )
      case 'incidents': {
        const list = blockList(block, where, ctx)
        return renderIncidentsTimeline(list.value, list.at, ctx, title)
      }
      case 'service-health': {
        const list = blockList(block, where, ctx)
        return renderServiceHealthGrid(list.value, list.at, ctx, title)
      }
      case 'divider':
        return '<hr class="dashboard-divider"/>'
      case 'spacer':
        return `<div class="dashboard-spacer dashboard-spacer--${oneOf(block.size, ['sm', 'md', 'lg'] as const, 'md')}"></div>`
      default:
        throw new Error(
          `${where}.type ${block.type === undefined ? 'is missing' : `"${dashText(block.type)}" is not a block type`}; ` +
            `use one of: ${BLOCK_TYPES.join(', ')}.`
        )
    }
  })
}

// ─── Public entry point ─────────────────────────────────────────────

interface DashboardRenderOptions {
  template: DashboardTemplateName
  data: DashData
  theme: ThemeName
  /** Kept whatever the viewer's color scheme; when absent the page follows it. */
  defaultThemeMode?: 'light' | 'dark'
  branding: DashboardBranding
  inlineChartJs: boolean
}

function renderDashboard(opts: DashboardRenderOptions): { html: string; ctx: DashRender } {
  const theme = DASHBOARD_THEMES[opts.theme] ?? DASHBOARD_THEMES.default
  const warnings: string[] = []
  const failures: string[] = []
  const ctx: DashRender = {
    charts: new DashboardCharts(opts.inlineChartJs, { warnings, failures }),
    warnings,
    sparklines: 0,
    drawSparklines: opts.inlineChartJs,
    skippedSparklines: 0,
    rendered: 0,
    failures,
  }
  const parts = (DASHBOARD_TEMPLATES[opts.template] ?? DASHBOARD_TEMPLATES['executive-brief'])(
    opts.data,
    ctx
  )
  const body = [...parts, renderDashboardFooter(opts.data.meta, opts.branding)].join('\n')
  const needsCharts = ctx.charts.specs.length > 0 || ctx.sparklines > 0
  const html = htmlWrapper({
    title: dashText(opts.data.title),
    cssSource: buildDashboardCss(theme, opts.defaultThemeMode),
    chartJsSource: needsCharts ? loadChartJsBundle() : undefined,
    chartInit: needsCharts ? dashboardScript(safeJsonForScript(ctx.charts.specs)) : undefined,
    body,
  })
  return { html, ctx }
}

/** Fields each template reads beyond the shared ones, to flag data another template would need. */
const TEMPLATE_ONLY_FIELDS: Record<string, DashboardTemplateName[]> = {
  services: ['operations-pulse'],
  incidents: ['operations-pulse'],
  heroChart: ['financial-review'],
  period: ['financial-review'],
  blocks: ['custom'],
}
const FIXED_TEMPLATE_FIELDS = [
  'eyebrow',
  'headline',
  'status',
  'statusLabel',
  'kpis',
  'charts',
  'tables',
  'sections',
]

/** Data the chosen template does not show, which the model would otherwise believe is on the page. */
function ignoredDashboardFields(template: DashboardTemplateName, data: DashData): string[] {
  const ignored = Object.entries(TEMPLATE_ONLY_FIELDS)
    .filter(([field, templates]) => data[field] !== undefined && !templates.includes(template))
    .map(([field, templates]) => `data.${field} is only shown by template '${templates[0]}'`)
  if (template === 'custom') {
    for (const field of FIXED_TEMPLATE_FIELDS) {
      if (data[field] !== undefined) {
        ignored.push(`data.${field} is not read by template 'custom' (put it in a block)`)
      }
    }
  }
  return ignored.map(line => `${line}; it was left out.`)
}

// ─── generate_dashboard tool definition ─────────────────────────────

const DASHBOARD_TEMPLATE_NAMES = [
  'executive-brief',
  'operations-pulse',
  'financial-review',
  'technical-report',
  'custom',
] as const

const DELTA_DIRECTION_SCHEMA = {
  type: 'string',
  enum: ['up', 'down', 'neutral'],
  description: 'Arrow direction.',
}

const DASH_KPI_SCHEMA = {
  type: 'object',
  required: ['label', 'value'],
  properties: {
    label: { type: 'string', description: 'What it measures.' },
    value: { type: ['string', 'number'], description: 'Number or formatted text, e.g. "$1.2M".' },
    delta: { type: ['string', 'number'], description: 'Change, e.g. "+12%" or -0.3.' },
    deltaDirection: DELTA_DIRECTION_SCHEMA,
    deltaSentiment: {
      type: 'string',
      enum: ['good', 'bad', 'neutral'],
      description:
        'Delta color: good green, bad red. Default follows the arrow (up good); churn falling ' +
        'is down + good.',
    },
    sparkline: {
      type: 'array',
      items: { type: ['number', 'string', 'null'] },
      description: 'Trend, oldest first, 2+ numbers.',
    },
    accent: {
      type: 'string',
      enum: ['success', 'warning', 'danger', 'neutral'],
      description: 'Top bar color.',
    },
  },
}

const XYR_PROPERTIES = {
  x: { type: 'number', description: 'X.' },
  y: { type: 'number', description: 'Y.' },
  r: { type: 'number', description: 'Bubble radius (px).' },
}

/** One chart value: a number, text such as "1,200", null for a gap, or an object. */
function dashPoint(objectProperties: Record<string, unknown>): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'number' },
      { type: 'string' },
      { type: 'null' },
      { type: 'object', properties: objectProperties },
    ],
  }
}

/** normalizeChartData also reads {label, value} records. */
const DASH_POINT_SCHEMA = dashPoint({
  ...XYR_PROPERTIES,
  label: { type: 'string', description: 'Category.' },
  value: { type: 'number', description: 'Value.' },
})

function dashColor(what: string): Record<string, unknown> {
  return {
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description: `${what}: hex, or one per point.`,
  }
}

const DASH_CHART_SCHEMA = {
  type: 'object',
  required: ['type', 'datasets'],
  properties: {
    type: {
      type: 'string',
      enum: [...DASHBOARD_CHART_TYPES],
      description:
        'As in clerum__generate_chart. area: filled line; stacked*: stacked series; ' +
        'mixedBarLine: 1st series bars, rest lines; gauge: 1st value on a 0-gaugeMax dial; ' +
        'waterfall: steps, then the total; funnel: one series, descending; scatter, bubble: ' +
        '{x, y[, r]} points.',
    },
    title: { type: 'string', description: 'Heading.' },
    labels: {
      type: 'array',
      items: { type: ['string', 'number'] },
      description: 'X categories or slice names, one per value.',
    },
    datasets: {
      type: 'array',
      description: 'Series.',
      items: {
        type: 'object',
        required: ['data'],
        properties: {
          label: { type: 'string', description: 'Legend name.' },
          data: {
            type: 'array',
            items: DASH_POINT_SCHEMA,
            description: 'One value per label; null for a gap.',
          },
          backgroundColor: dashColor('Fill'),
          borderColor: dashColor('Line'),
          fill: { type: 'boolean', description: 'Fill under a line.' },
        },
      },
    },
    yAxisLabel: { type: 'string', description: 'Y-axis title.' },
    xAxisLabel: { type: 'string', description: 'X-axis title.' },
    gaugeMax: { type: ['number', 'string'], description: 'Gauge dial end (default 100).' },
  },
}

const CHART_POINTER = 'As data.charts[].'

/**
 * The data.charts[] fields that carry a contract (type enum, required series,
 * value types), for the places that repeat that shape and point to it for the
 * rest: every model request carries the schema.
 */
const CHART_COPY_PROPERTIES = {
  type: { type: 'string', enum: [...DASHBOARD_CHART_TYPES], description: CHART_POINTER },
  title: { type: 'string', description: 'Heading.' },
  labels: { type: 'array', items: { type: ['string', 'number'] }, description: CHART_POINTER },
  datasets: {
    type: 'array',
    description: CHART_POINTER,
    items: {
      type: 'object',
      required: ['data'],
      properties: {
        label: { type: 'string', description: 'Legend name.' },
        data: { type: 'array', items: dashPoint(XYR_PROPERTIES), description: CHART_POINTER },
      },
    },
  },
  gaugeMax: { type: ['number', 'string'], description: CHART_POINTER },
}

const DASH_TABLE_SCHEMA = {
  type: 'object',
  required: ['headers', 'rows'],
  properties: {
    title: { type: 'string', description: 'Heading.' },
    headers: {
      type: 'array',
      items: { type: ['string', 'number'] },
      description: 'Column headings.',
    },
    rows: { type: 'array', items: ROW_SCHEMA, description: 'Rows, cells in header order.' },
    columnTypes: {
      type: 'object',
      // Gemini rejects an object schema with no properties, so the map declares
      // one example key. additionalProperties, which Gemini's SDK drops, keeps
      // the other keys valid and marks the object as a map.
      properties: {
        '0': {
          type: 'string',
          enum: ['plain', 'severity', 'priority', 'status'],
          description: 'Column 0.',
        },
      },
      additionalProperties: { type: 'string', enum: ['plain', 'severity', 'priority', 'status'] },
      description:
        'Badge columns: header or 0-based index to a type, e.g. {"Status": "severity"}. ' +
        'Values such as critical, high, medium, low, info, p0-p2, healthy, degraded, down ' +
        'then show as colored badges.',
    },
  },
}

const DASH_SERVICE_SCHEMA = {
  type: 'object',
  required: ['name', 'status'],
  properties: {
    name: { type: 'string', description: 'Name.' },
    status: {
      type: 'string',
      description: 'Card color: healthy, degraded, down or maintenance.',
    },
    metric: { type: ['string', 'number'], description: 'e.g. "142 ms".' },
    delta: { type: ['string', 'number'], description: 'e.g. "+0.2pp".' },
    deltaDirection: DELTA_DIRECTION_SCHEMA,
  },
}

const DASH_INCIDENT_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    time: { type: 'string', description: 'Start, e.g. "10:42".' },
    title: { type: 'string', description: 'What happened.' },
    severity: { type: 'string', description: 'critical, high, medium, low or info (default).' },
    description: { type: 'string', description: 'Detail.' },
    resolvedAt: { type: 'string', description: 'When resolved; unset shows it open.' },
  },
}

const DASH_SECTION_CONTENT_SCHEMA = {
  anyOf: [{ type: ['string', 'number'] }, { type: 'array', items: { type: ['string', 'number'] } }],
  description: 'A paragraph, or an array of paragraphs or bullets. Inline markdown.',
}

const HERO_ONLY = 'hero: as in data.'

const generateDashboardTool: InternalToolDefinition = {
  name: 'clerum__generate_dashboard',
  description:
    'Generate a standalone HTML dashboard: one .html file, CSS and Chart.js inlined, that ' +
    'works offline, follows light/dark mode and prints cleanly. Templates: executive-brief ' +
    '(general), operations-pulse (+services, incidents), financial-review (+heroChart, ' +
    'period), technical-report (sections first), custom (data.blocks[] only). The result ' +
    'lists anything not shown, to fix and regenerate.',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Output name; .html added if missing.' },
      template: {
        type: 'string',
        enum: [...DASHBOARD_TEMPLATE_NAMES],
        description: 'Default executive-brief.',
      },
      theme: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description: 'default slate, corporate navy, warm amber, alert rose.',
      },
      defaultThemeMode: {
        type: 'string',
        enum: ['light', 'dark'],
        description: "Omit to follow the viewer's color scheme; set to force it.",
      },
      inlineChartJs: {
        type: 'boolean',
        description:
          'Default true (adds ~210 KB when charts are used). false: charts become value tables, ' +
          'no sparklines.',
      },
      branding: {
        type: 'object',
        description: 'Footer.',
        properties: {
          companyName: { type: 'string', description: 'Left side.' },
          footerText: { type: 'string', description: 'Beside the date.' },
        },
      },
      data: {
        type: 'object',
        description:
          'Page content. A field that names a template shows only in it; custom reads only ' +
          'title, blocks and meta.',
        required: ['title'],
        properties: {
          eyebrow: { type: 'string', description: 'Label above the title.' },
          title: { type: 'string', description: 'Heading.' },
          headline: { type: 'string', description: 'Summary under the title.' },
          status: {
            type: 'string',
            enum: [...HERO_STATUSES],
            description: 'Badge beside the title.',
          },
          statusLabel: { type: 'string', description: 'Badge text, e.g. "On track".' },
          period: {
            type: 'string',
            description: 'financial-review: e.g. "Q3 2026", above the title if no eyebrow.',
          },
          kpis: { type: 'array', description: 'Figure cards.', items: DASH_KPI_SCHEMA },
          charts: { type: 'array', description: 'Chart cards.', items: DASH_CHART_SCHEMA },
          heroChart: {
            type: 'object',
            required: ['type', 'datasets'],
            description: `financial-review: one wide chart above charts. ${CHART_POINTER}`,
            properties: CHART_COPY_PROPERTIES,
          },
          services: {
            type: 'array',
            description: 'operations-pulse: status cards.',
            items: DASH_SERVICE_SCHEMA,
          },
          incidents: {
            type: 'array',
            description: 'operations-pulse: timeline, in order.',
            items: DASH_INCIDENT_SCHEMA,
          },
          tables: { type: 'array', description: 'Tables.', items: DASH_TABLE_SCHEMA },
          sections: {
            type: 'array',
            description: 'Prose after the tables.',
            items: {
              type: 'object',
              required: ['type', 'content'],
              properties: {
                title: { type: 'string', description: 'Heading.' },
                type: {
                  type: 'string',
                  enum: [...SECTION_TYPES],
                  description: 'Paragraphs, list, tinted box or monospaced block.',
                },
                content: DASH_SECTION_CONTENT_SCHEMA,
                tone: { type: 'string', enum: [...CALLOUT_TONES], description: 'callout color.' },
                language: { type: 'string', description: 'code language label.' },
              },
            },
          },
          blocks: {
            type: 'array',
            description: 'custom: blocks in page order; each field names the types that read it.',
            items: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { type: 'string', enum: [...BLOCK_TYPES], description: 'Block type.' },
                title: { type: 'string', description: 'Heading (hero: page title).' },
                eyebrow: { type: 'string', description: HERO_ONLY },
                headline: { type: 'string', description: HERO_ONLY },
                status: { type: 'string', enum: [...HERO_STATUSES], description: HERO_ONLY },
                statusLabel: { type: 'string', description: HERO_ONLY },
                items: {
                  type: 'array',
                  items: {
                    anyOf: [
                      { type: ['string', 'number'] },
                      {
                        type: 'object',
                        properties: {
                          label: { type: ['string', 'number'], description: 'KPI label.' },
                          value: { type: ['string', 'number'], description: 'KPI value.' },
                          delta: { type: ['string', 'number'], description: 'KPI delta.' },
                          deltaDirection: DELTA_DIRECTION_SCHEMA,
                          deltaSentiment: {
                            ...DASH_KPI_SCHEMA.properties.deltaSentiment,
                            description: 'As data.kpis[].',
                          },
                          accent: {
                            ...DASH_KPI_SCHEMA.properties.accent,
                            description: 'KPI accent.',
                          },
                          ...CHART_COPY_PROPERTIES,
                          time: { type: 'string', description: 'Incident time.' },
                          severity: DASH_INCIDENT_SCHEMA.properties.severity,
                          resolvedAt: { type: 'string', description: 'As data.incidents[].' },
                          title: { type: 'string', description: 'Chart or incident title.' },
                        },
                      },
                    ],
                  },
                  description:
                    'bullets: strings. kpis, charts-grid, incidents: objects as in ' +
                    'data.kpis[], charts[], incidents[].',
                },
                services: {
                  type: 'array',
                  description: 'service-health: as in data.services[].',
                  items: {
                    type: 'object',
                    required: ['name', 'status'],
                    properties: {
                      name: { type: 'string', description: 'Name.' },
                      status: DASH_SERVICE_SCHEMA.properties.status,
                      deltaDirection: DELTA_DIRECTION_SCHEMA,
                    },
                  },
                },
                spec: {
                  type: 'object',
                  properties: {
                    ...CHART_COPY_PROPERTIES,
                    headers: DASH_TABLE_SCHEMA.properties.headers,
                    rows: {
                      type: 'array',
                      items: {
                        anyOf: [
                          { type: 'array', items: { type: CELL_SCHEMA.type } },
                          {
                            type: 'object',
                            // As columnTypes: one example key, the rest by additionalProperties.
                            properties: { '0': { type: CELL_SCHEMA.type, description: 'Cell.' } },
                            additionalProperties: { type: CELL_SCHEMA.type },
                          },
                        ],
                      },
                      description: 'As data.tables[], or {header: cell}.',
                    },
                  },
                  description: 'chart: as data.charts[]; table: as data.tables[].',
                },
                content: {
                  ...DASH_SECTION_CONTENT_SCHEMA,
                  description: 'narrative, code, callout: as data.sections[].content.',
                },
                language: { type: 'string', description: 'code: label.' },
                tone: { type: 'string', enum: [...CALLOUT_TONES], description: 'callout: color.' },
                size: { type: 'string', enum: ['sm', 'md', 'lg'], description: 'spacer: height.' },
              },
            },
          },
          meta: {
            type: 'object',
            description: 'Footer provenance.',
            properties: {
              date: { type: ['string', 'number'], description: 'Default: today.' },
              author: { type: 'string', description: 'Author.' },
              runId: { type: 'string', description: 'Run ID.' },
            },
          },
        },
      },
    },
    required: ['filename', 'data'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    try {
      const filename = outputFilename(args.filename, 'html', 'dashboard')
      const data = args.data
      if (!isDashRecord(data) || !dashText(data.title).trim()) {
        return {
          success: false,
          error:
            'data.title is required: pass data as an object with the dashboard heading, ' +
            'e.g. {"title": "Weekly review", "kpis": [...]}.',
        }
      }
      const template = oneOf(args.template, DASHBOARD_TEMPLATE_NAMES, 'executive-brief')
      const inlineChartJs = args.inlineChartJs !== false
      const { html, ctx } = renderDashboard({
        template,
        data,
        theme: oneOf(args.theme, ['default', 'corporate', 'warm', 'alert'] as const, 'default'),
        defaultThemeMode:
          args.defaultThemeMode === 'light' || args.defaultThemeMode === 'dark'
            ? args.defaultThemeMode
            : undefined,
        inlineChartJs,
        branding: isDashRecord(args.branding) ? args.branding : {},
      })

      const produced = ctx.rendered + ctx.charts.drawn
      if (produced === 0 && ctx.failures.length > 0) {
        return {
          success: false,
          error: `Nothing on the dashboard could be shown, so no file was written. ${ctx.failures.join(' ')}`,
        }
      }
      const warnings = [
        ...ctx.failures.map(f => `${f} A notice shows in its place.`),
        ...ignoredDashboardFields(template, data),
        ...ctx.warnings,
      ]
      if (produced === 0) {
        warnings.push(
          'The dashboard only shows its title: pass kpis, charts, tables or sections ' +
            "(blocks for template 'custom')."
        )
      }
      if (!inlineChartJs && (ctx.charts.drawn > 0 || ctx.skippedSparklines > 0)) {
        warnings.push(
          'inlineChartJs is false, so charts are shown as tables of their values and ' +
            'sparklines are left out.'
        )
      }

      ensureDir(outputDir)
      const target = claimOutputFile(outputDir, filename)
      enforceQuota(outputDir, Buffer.byteLength(html, 'utf-8'), replacedBytes(target))
      fs.writeFileSync(target.filePath, html, 'utf-8')

      return artifactResult(target, 'html', { warnings })
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

// ════════════════════════════════════════════════════════════════════
// ─── PPTX GENERATION (clerum__generate_pptx) ────────────────────────
// ════════════════════════════════════════════════════════════════════
//
// The deck is built by pptxDeck.ts from arguments read by pptxInput.ts and,
// for the preset decks, pptxTemplates.ts. The workflow path validates against
// this schema before the tool runs.

// Each shape is described in full once, under slides[]. The template fields in
// `data` repeat its structure with short descriptions that point back there:
// the schema goes out with every request and JSON Schema $ref is not portable.

const PPTX_IMAGE_PATH_DESCRIPTION =
  "Image file name in the output folder, as clerum__generate_chart returns it (e.g. 'sales.png'). " +
  'PNG, JPEG, GIF, WebP or SVG.'

const PPTX_PATH_SHORT = 'File name, as clerum__generate_chart returns it.'

/** An array of short texts, or one string read as one item per line. */
function pptxTextList(description: string): Record<string, unknown> {
  return {
    anyOf: [{ type: 'array', items: { type: ['string', 'number'] } }, { type: 'string' }],
    description,
  }
}

function pptxImage(
  description: string,
  about: { path: string; caption: string; width: string; height: string }
): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'string' },
      {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: about.path },
          caption: { type: 'string', description: about.caption },
          width: { type: 'number', description: about.width },
          height: { type: 'number', description: about.height },
        },
      },
    ],
    description,
  }
}

function pptxKpis(
  description: string,
  about: { label: string; value: string; delta: string; deltaDirection: string }
): Record<string, unknown> {
  return {
    type: 'array',
    description,
    items: {
      type: 'object',
      required: ['label', 'value'],
      properties: {
        label: { type: 'string', description: about.label },
        value: { type: ['string', 'number'], description: about.value },
        delta: { type: ['string', 'number'], description: about.delta },
        deltaDirection: {
          type: 'string',
          enum: ['up', 'down', 'neutral'],
          description: about.deltaDirection,
        },
      },
    },
  }
}

function pptxTable(description: string, headers: string, rows: string): Record<string, unknown> {
  return {
    type: 'object',
    required: ['headers', 'rows'],
    description,
    properties: {
      headers: { type: 'array', items: { type: ['string', 'number'] }, description: headers },
      rows: {
        type: 'array',
        items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
        description: rows,
      },
    },
  }
}

/** A chart value; text such as "1,200" and {label, value} records are read too. */
const PPTX_CHART_POINT_SCHEMA = {
  anyOf: [
    { type: 'number' },
    { type: 'string' },
    { type: 'null' },
    {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Category.' },
        value: { type: 'number', description: 'Value.' },
      },
    },
  ],
}

function pptxChartSeries(about: {
  labels: string
  datasets: string
  label: string
  data: string
}): Record<string, Record<string, unknown>> {
  return {
    labels: { type: 'array', items: { type: ['string', 'number'] }, description: about.labels },
    datasets: {
      type: 'array',
      description: about.datasets,
      items: {
        type: 'object',
        required: ['data'],
        properties: {
          label: { type: 'string', description: about.label },
          data: { type: 'array', items: PPTX_CHART_POINT_SCHEMA, description: about.data },
        },
      },
    },
  }
}

const PPTX_SERIES_SHORT = {
  labels: 'Categories.',
  datasets: 'Series.',
  label: 'Name.',
  data: 'Values.',
}

const PPTX_CHART_SCHEMA = {
  type: 'object',
  description:
    'A native, editable chart { type, labels, datasets }, or { path } for a chart image.',
  properties: {
    path: {
      type: 'string',
      description:
        "Chart image file name, as clerum__generate_chart returns it (e.g. 'sales.png'), for " +
        'types the native list lacks. Native data given too is drawn if the file cannot be used.',
    },
    type: {
      type: 'string',
      enum: [...NATIVE_CHART_TYPES],
      description: 'Native chart type. Only for native charts: with path, leave it out.',
    },
    title: { type: 'string', description: 'Heading, unless it repeats the slide title.' },
    ...pptxChartSeries({
      labels: 'Category labels, one per value.',
      datasets: 'Series; a pie or doughnut draws only the first.',
      label: 'Legend name.',
      data: 'One value per label; null leaves a gap.',
    }),
    data: {
      type: 'object',
      description: 'Or labels and datasets nested here, as clerum__generate_chart takes them.',
      properties: pptxChartSeries(PPTX_SERIES_SHORT),
    },
    caption: { type: 'string', description: 'Note under the chart.' },
  },
}

/**
 * A template chart: slides[].chart without its nested `data` form. The runtime
 * still reads that form; readNativeChart checks its labels and series names,
 * and the chart normalizer its datasets and values.
 */
function pptxTemplateChart(description: string): Record<string, unknown> {
  return {
    type: 'object',
    description: `${description} As slides[].chart.`,
    properties: {
      path: { type: 'string', description: PPTX_PATH_SHORT },
      type: { type: 'string', enum: [...NATIVE_CHART_TYPES], description: 'Chart type.' },
      title: { type: 'string', description: 'Slide title.' },
      ...pptxChartSeries(PPTX_SERIES_SHORT),
      caption: { type: 'string', description: 'Note.' },
    },
  }
}

function pptxColumn(description: string): Record<string, unknown> {
  return {
    type: 'object',
    required: ['type'],
    description,
    properties: {
      type: {
        type: 'string',
        enum: ['bullets', 'narrative', 'image'],
        description: 'Which field below it uses.',
      },
      bullets: pptxTextList("For type 'bullets'."),
      text: { type: 'string', description: "For type 'narrative'." },
      image: pptxImage("For type 'image'; as slides[].image.", {
        path: PPTX_PATH_SHORT,
        caption: 'Note.',
        width: 'Inches.',
        height: 'Inches.',
      }),
    },
  }
}

/** The fields of every template's `data`; each description names the templates that read it. */
const PPTX_TEMPLATE_DATA_PROPERTIES: Record<string, Record<string, unknown>> = {
  title: {
    type: ['string', 'number'],
    description: 'executive-brief, quarterly-review, incident-review: cover title.',
  },
  subtitle: { type: ['string', 'number'], description: 'executive-brief: line under the title.' },
  status: {
    type: 'string',
    enum: [...STATUSES],
    description: 'executive-brief, quarterly-review: cover band color.',
  },
  kpis: pptxKpis('executive-brief, quarterly-review: cards, as slides[].kpis.', {
    label: 'Label.',
    value: 'Figure.',
    delta: 'Change.',
    deltaDirection: 'Delta color.',
  }),
  charts: {
    type: 'array',
    items: pptxTemplateChart('One chart.'),
    description: 'executive-brief: one slide per chart.',
  },
  takeaways: pptxTextList('executive-brief: Key Takeaways slide.'),
  nextSteps: pptxTextList('executive-brief: Next Steps slide.'),
  period: { type: ['string', 'number'], description: 'quarterly-review: period, e.g. "Q3 2026".' },
  highlights: pptxTextList('quarterly-review: highlights.'),
  revenueChart: pptxTemplateChart('quarterly-review: revenue trend.'),
  breakdownChart: pptxTemplateChart('quarterly-review: revenue breakdown.'),
  metricsTable: pptxTable('quarterly-review: metrics, as slides[].table.', 'Headings.', 'Rows.'),
  outlook: pptxTextList('quarterly-review: next-period priorities.'),
  severity: {
    type: 'string',
    enum: [...SEVERITIES],
    description: 'incident-review: colors the cover.',
  },
  date: { type: ['string', 'number'], description: 'incident-review: when it happened.' },
  summary: { type: ['string', 'number'], description: 'incident-review: what happened, briefly.' },
  timelineTable: pptxTable(
    'incident-review: timeline, as slides[].table.',
    'e.g. ["Time", "Event"].',
    'Rows.'
  ),
  impact: pptxTextList('incident-review: who and what was affected.'),
  rootCause: { type: ['string', 'number'], description: 'incident-review: root cause.' },
  remediation: pptxTextList('incident-review: fixes made or planned.'),
  lessons: pptxTextList('incident-review: lessons learned.'),
  company: { type: ['string', 'number'], description: 'pitch-deck: company name.' },
  tagline: { type: ['string', 'number'], description: 'pitch-deck: one line under the name.' },
  problem: { type: ['string', 'number'], description: 'pitch-deck: the problem, briefly.' },
  solution: { type: ['string', 'number'], description: 'pitch-deck: the solution, briefly.' },
  marketSize: {
    type: 'object',
    required: ['value'],
    description: 'pitch-deck: addressable market.',
    properties: {
      value: { type: ['string', 'number'], description: 'e.g. "$12B".' },
      description: { type: 'string', description: 'Scope and source.' },
    },
  },
  tractionChart: pptxTemplateChart('pitch-deck: traction.'),
  team: {
    type: 'array',
    description: 'pitch-deck: one card per person.',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name.' },
        role: { type: 'string', description: 'e.g. "CEO".' },
      },
    },
  },
  ask: {
    type: 'object',
    required: ['amount'],
    description: 'pitch-deck: the raise.',
    properties: {
      amount: { type: ['string', 'number'], description: 'e.g. "$5M".' },
      useOfFunds: pptxTextList('Use of funds.'),
    },
  },
}

const generatePptxTool: InternalToolDefinition = {
  name: 'clerum__generate_pptx',
  description:
    'Generate a styled PowerPoint (.pptx) deck: set `template` and fill `data`, or pass ' +
    '`slides[]`, each with a `layout`. A list of texts may also be one string, one item per ' +
    'line. Lists, tables and KPI cards that do not fit continue on further slides and long ' +
    'text is set smaller; the result says when.',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: "e.g. 'deck.pptx'; .pptx is added if missing." },
      title: { type: 'string', description: 'File metadata; not shown on a slide.' },
      subject: { type: 'string', description: 'File metadata.' },
      author: { type: 'string', description: 'File metadata.' },
      template: {
        type: 'string',
        enum: [...PPTX_TEMPLATES, 'custom'],
        description:
          'Preset deck from `data`. Required: executive-brief title; quarterly-review title, ' +
          'period; incident-review title, severity, summary; pitch-deck company, tagline, ' +
          "problem, solution. 'custom' (default): use `slides[]`.",
      },
      data: {
        type: 'object',
        description: 'Fields for `template`.',
        properties: PPTX_TEMPLATE_DATA_PROPERTIES,
      },
      palette: {
        type: 'string',
        enum: Object.keys(PPTX_PALETTES),
        description: "Default 'default'.",
      },
      aspectRatio: {
        type: 'string',
        enum: Object.keys(PPTX_ASPECT_RATIOS),
        description: "Default 'wide' (13.33×7.5 in).",
      },
      branding: {
        type: 'object',
        description: 'Footer on every slide but the cover; logo on the cover.',
        properties: {
          companyName: { type: 'string', description: 'Footer, left.' },
          logoPath: {
            type: 'string',
            description:
              'Logo image file name in the output folder; formats as slides[].image.path.',
          },
          footerText: { type: 'string', description: 'Footer, after the company name.' },
        },
      },
      slides: {
        type: 'array',
        minItems: 1,
        description: 'The slides, in order.',
        items: {
          type: 'object',
          required: ['layout'],
          properties: {
            layout: {
              type: 'string',
              enum: [...SLIDE_LAYOUTS],
              description:
                'Needs: cover, section a title; title-bullets bullets; title-chart chart; ' +
                'title-table table; kpis kpis; two-column columns; image image; quote quote.',
            },
            title: { type: 'string', description: 'Heading.' },
            eyebrow: { type: 'string', description: 'Section: label above the title.' },
            subtitle: { type: 'string', description: 'Cover, section: line under the title.' },
            status: {
              type: 'string',
              enum: [...STATUSES],
              description: 'Cover: color of the top band.',
            },
            bullets: pptxTextList('Bullet points.'),
            table: pptxTable('A table.', 'Column headings.', 'Rows of cells, in header order.'),
            kpis: pptxKpis('Figures as cards, up to 8 per slide.', {
              label: 'What it measures.',
              value: 'A number, or formatted text, e.g. "$1.2M".',
              delta: 'Change, e.g. "+12%".',
              deltaDirection: 'Delta color: up good, down bad, neutral grey.',
            }),
            chart: PPTX_CHART_SCHEMA,
            image: pptxImage('A file name, or { path, caption, width, height }.', {
              path: PPTX_IMAGE_PATH_DESCRIPTION,
              caption: 'Note under it.',
              width:
                'Inches. With width or height the other keeps the proportions; with both the ' +
                'image fits inside that box; with neither it fills the space, up to twice its size.',
              height: 'Inches; see width.',
            }),
            quote: {
              type: 'object',
              description: 'Pull quote.',
              required: ['text'],
              properties: {
                text: { type: 'string', description: 'The words.' },
                attribution: { type: 'string', description: 'Who said it.' },
              },
            },
            columns: {
              type: 'object',
              description: 'Two columns.',
              required: ['left', 'right'],
              properties: {
                left: pptxColumn('Left column.'),
                right: pptxColumn('Right column.'),
              },
            },
            notes: { type: 'string', description: 'Speaker notes.' },
          },
        },
      },
    },
    required: ['filename'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    try {
      const filename = outputFilename(args.filename, 'pptx', 'deck')
      const warnings: string[] = []
      const { buffer, slides } = await buildPptxDeck(args, outputDir, warnings)
      // Buffer first, quota check, then write — atomic, no partial files.
      ensureDir(outputDir)
      const target = claimOutputFile(outputDir, filename)
      enforceQuota(outputDir, buffer.byteLength, replacedBytes(target))
      fs.writeFileSync(target.filePath, buffer)
      return artifactResult(target, 'pptx', {
        summary: `File generated: ${target.filename} (pptx), ${slides} slide${slides === 1 ? '' : 's'}.`,
        warnings,
      })
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

// ─── Registry ────────────────────────────────────────────────────────

// ─── clerum__list_workflows ───────────────────────────────────────────

const listWorkflowTool = new WorkflowListTool()

const listWorkflows: InternalToolDefinition = {
  name: 'clerum__list_workflows',
  description: listWorkflowTool.description(),
  parameters: listWorkflowTool.parametersSchema(),
  execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
    const result = await listWorkflowTool.execute(args)
    if (result.is_error) {
      return { success: false, error: result.content }
    }
    return { success: true, content: result.content }
  },
}

const readWorkflowTool = new WorkflowStatusTool()

const readWorkflow: InternalToolDefinition = {
  name: 'clerum__read_workflow',
  description: readWorkflowTool.description(),
  parameters: readWorkflowTool.parametersSchema(),
  execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
    const result = await readWorkflowTool.execute(args)
    if (result.is_error) {
      return { success: false, error: result.content }
    }
    return { success: true, content: result.content }
  },
}

const triggerWorkflowTool = new WorkflowTriggerTool()

const triggerWorkflow: InternalToolDefinition = {
  name: 'clerum__trigger_workflow',
  description: triggerWorkflowTool.description(),
  parameters: triggerWorkflowTool.parametersSchema(),
  execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
    const result = await triggerWorkflowTool.execute(args)
    if (result.is_error) {
      return { success: false, error: result.content }
    }
    return { success: true, content: result.content }
  },
}

/**
 * A generator that runs on cleaned arguments (cleanToolArgs, unset nulls
 * dropped, named images decoded) and reports the arguments it did not read.
 */
function prepared(tool: InternalToolDefinition): InternalToolDefinition {
  return {
    ...tool,
    execute: async (args, outputDir) => {
      let clean: Record<string, unknown>
      try {
        clean = withoutUnsetNulls(tool.parameters, cleanToolArgs(args ?? {})) as Record<
          string,
          unknown
        >
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
      await predecodeImages(clean, outputDir)
      const unknown = watchUnknownArguments(tool.parameters, clean)
      const result = await tool.execute(clean, outputDir)
      const ignored = unknown.ignored()
      if (!result.success || ignored.length === 0) return result
      const listed = ignored.slice(0, 10).map(name => `'${name}'`)
      if (ignored.length > 10) listed.push(`and ${ignored.length - 10} more`)
      const note = `Ignored arguments this tool does not read: ${listed.join(', ')}.`
      const content = result.content ?? ''
      return {
        ...result,
        content: /\nNotes: /.test(content) ? `${content} ${note}` : `${content}\nNotes: ${note}`,
      }
    },
  }
}

/** All internal tools available to workflow steps. */
export const INTERNAL_TOOLS: InternalToolDefinition[] = [
  ...[
    generateMarkdown,
    generatePdf,
    generateDocx,
    generateXlsx,
    generatePptxTool,
    generateChart,
    generateDashboardTool,
  ].map(prepared),
  listWorkflows,
  readWorkflow,
  triggerWorkflow,
  ...CONTEXT_FILES_TOOLS,
]

/** Prefix used for all internal tools. */
export const INTERNAL_TOOL_PREFIX = 'clerum__'

/** Internal tools whose only purpose is reading a mounted SharedFileSystem. */
const CONTEXT_FILES_TOOL_NAMES = new Set(CONTEXT_FILES_TOOLS.map(t => t.name))

/**
 * The internal tools to actually expose to an agent at runtime.
 *
 * The context-files tools (`clerum__context_files_*`) are only useful when a
 * SharedFileSystem is actually mounted into the pod — i.e. a 1st-party Host whose
 * Context references an SFS, for which HCC injects the RO PVC volume(s) and sets
 * `CLERUM_CONTEXT_FILES_MOUNTS`. They are omitted otherwise so the agent never
 * sees dead tools:
 *   - 3rd-party recipe (workflow) runtimes NEVER mount an SFS — the PVC lives in
 *     the `mcp-host` namespace, recipe pods run in `sandbox-recipes`, and PVCs are
 *     namespace-scoped, so a recipe pod cannot mount it even in principle.
 *   - a 1st-party Host whose Context references no SFS has nothing to browse.
 *
 * Gate on the presence of mounts, re-read on each call. The env is fixed per pod;
 * a mount change rolls the pod (new `CLERUM_CONTEXT_FILES_MOUNTS`) → re-evaluation.
 */
export function resolveInternalTools(
  env: NodeJS.ProcessEnv = process.env
): InternalToolDefinition[] {
  if (loadContextFilesMounts(env).length > 0) return INTERNAL_TOOLS
  return INTERNAL_TOOLS.filter(t => !CONTEXT_FILES_TOOL_NAMES.has(t.name))
}

/**
 * Resolve the directory for generated artifacts. Re-evaluated on every call.
 *
 * Resolution order:
 *   1. `CLERUM_OUTPUT_DIR` — explicit override (dev / tests / ad-hoc).
 *   2. Workflow mode (`CLERUM_WORKFLOW_ENABLED=true`) → `/output` (per-run PVC).
 *   3. Chat mode → `${workspacePath}/outputs`, where workspacePath comes from the
 *      Host CRD (via the injected accessor), else mirrors `config.memory.workspacePath`
 *      (`CLERUM_MEMORY_WORKSPACE_PATH`, dev-aware default). Reusing the durable
 *      workspace PVC (instead of the old `/tmp/clerum-output` emptyDir) is what
 *      keeps Download links working after a Host pod restart (D.2b).
 */
export function getOutputDir(): string {
  if (process.env.CLERUM_OUTPUT_DIR) return process.env.CLERUM_OUTPUT_DIR
  if (process.env.CLERUM_WORKFLOW_ENABLED === 'true') return '/output'
  // Mirror config.memory.workspacePath — the var that actually backs the
  // workspace PVC (where state.db / spillover also live), NOT CLERUM_WORKSPACE_PATH
  // (the native-tool sandbox root, config.ts:515). CRD accessor wins in prod; the
  // env/dev default only applies when running without a Host CRD.
  const workspacePath =
    outputDirHostAccessor?.()?.spec?.memory?.workspacePath ||
    process.env.CLERUM_MEMORY_WORKSPACE_PATH ||
    (config.devMode ? './workspace' : '/workspace')
  return path.join(workspacePath, 'outputs')
}
