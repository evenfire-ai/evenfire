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
import { Chart, type ChartConfiguration, type ChartType, registerables } from 'chart.js'
import {
  AlignmentType,
  BorderStyle,
  Document as DocxDocument,
  Footer as DocxFooter,
  Header as DocxHeader,
  Table as DocxTable,
  TableCell as DocxTableCell,
  TableRow as DocxTableRow,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  TextRun,
  WidthType,
} from 'docx'
import ExcelJS from 'exceljs'
import * as fs from 'fs'
import * as path from 'path'
import type {
  Content,
  ContentTable,
  ContentText,
  TDocumentDefinitions,
  TFontDictionary,
} from 'pdfmake/interfaces'
import safeRegex from 'safe-regex'
import { config } from '../config'
import { WorkflowListTool, WorkflowStatusTool } from '../core/tools/workflowReadTools'
import { WorkflowTriggerTool } from '../core/tools/workflowTriggerTool'
import { CONTEXT_FILES_TOOLS, loadContextFilesMounts } from './contextFiles'
import type { ArtifactMetadata, InternalToolDefinition, InternalToolResult } from './types'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PdfPrinter = require('pdfmake')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PptxGenJS = require('pptxgenjs')

// Register Chart.js controllers/scales/elements/plugins once. Chart.js v4 ships
// these as separate exports so we have to opt in. `registerables` includes all
// chart types we expose (line, bar, pie, doughnut, etc.) plus axes/legend/title.
Chart.register(...registerables)

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

// Each generated dashboard inlines the Chart.js UMD bundle (~210 KB) so
// the HTML works offline. That's well under the 50 MB per-recipe quota
// (≈250 dashboards before hitting the cap) and not worth de-duplicating
// for the typical 1–10 dashboards a workflow produces. To skip the inline
// bundle, pass `inlineChartJs: false` on `clerum__generate_dashboard`.
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
 *
 * Known limitation (race condition): When the LLM issues multiple tool calls
 * concurrently (e.g., generate_pdf + generate_xlsx in the same turn), both
 * calls read the directory size before either has written its file. Both see
 * the same "current" size and both pass the quota check, even though the
 * combined output would exceed the 50 MB cap. This is a best-effort soft
 * quota; the 1Gi PVC hard cap enforced by kubelet is the primary defense.
 */
export function enforceQuota(outputDir: string, incomingBytes: number): void {
  const raw = process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
  const parsed = raw ? parseInt(raw, 10) : NaN
  const quotaMB = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUOTA_MB
  const quotaBytes = quotaMB * 1024 * 1024

  const current = getDirectorySize(outputDir)
  const projected = current + incomingBytes
  if (projected > quotaBytes) {
    throw new Error(
      `Output quota exceeded: ${projected} / ${quotaBytes} bytes ` +
        `(current=${current}, incoming=${incomingBytes}, quotaMB=${quotaMB})`
    )
  }
}

function buildArtifact(filePath: string, format: ArtifactMetadata['format']): ArtifactMetadata {
  const stats = fs.statSync(filePath)
  return {
    name: path.basename(filePath),
    format,
    path: filePath,
    sizeBytes: stats.size,
    createdAt: new Date().toISOString(),
  }
}

function sanitizeFilename(name: string): string {
  // Strip path components, then replace unsafe chars
  const basename = path.basename(name)
  return basename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, 200)
}

/**
 * Ensure the filename ends with exactly the requested extension, in lower
 * case, without producing duplicates like `report.pdf.pdf` when the caller
 * already provided one. Strips any existing extension (case-insensitive)
 * before appending. Pass-through-safe for filenames without extension.
 */
function ensureExtension(name: string, ext: string): string {
  const normExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  // Already ends with the desired extension (case-insensitive)? leave it.
  if (name.toLowerCase().endsWith(normExt)) return name
  // Strip an existing trailing extension if any (e.g. .PDF, .htm, .pdf.pdf)
  const stripped = name.replace(/\.[a-zA-Z0-9]{1,8}$/, '')
  return `${stripped}${normExt}`
}

// ─── generate_chart ──────────────────────────────────────────────────

interface ChartTheme {
  backgroundColor: string
  textColor: string
  gridColor: string
  palette: string[]
  /** Semantic colors used by waterfall (positive/negative deltas) and gauge. */
  positive: string
  negative: string
}

const CHART_THEMES: Record<string, ChartTheme> = {
  light: {
    backgroundColor: '#ffffff',
    textColor: '#0f172a',
    gridColor: '#e2e8f0',
    palette: ['#0f172a', '#22c55e', '#f59e0b', '#ef4444', '#3b82f6', '#a855f7', '#06b6d4'],
    positive: '#16a34a',
    negative: '#dc2626',
  },
  dark: {
    backgroundColor: '#0f172a',
    textColor: '#e2e8f0',
    gridColor: '#334155',
    palette: ['#22c55e', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899'],
    positive: '#22c55e',
    negative: '#f87171',
  },
  corporate: {
    backgroundColor: '#ffffff',
    textColor: '#1e293b',
    gridColor: '#cbd5e1',
    palette: ['#1e40af', '#0891b2', '#0d9488', '#059669', '#65a30d', '#ca8a04', '#dc2626'],
    positive: '#059669',
    negative: '#b91c1c',
  },
  warm: {
    backgroundColor: '#f7f7f5',
    textColor: '#2f2823',
    gridColor: '#d6d2cc',
    palette: ['#b45309', '#2f2823', '#0d9488', '#1e40af', '#9f1239', '#65a30d', '#7c3aed'],
    positive: '#65a30d',
    negative: '#9f1239',
  },
  'warm-dark': {
    backgroundColor: '#0e0f10',
    textColor: '#f2f2ef',
    gridColor: '#2a2c2f',
    palette: ['#ca6e1e', '#f2f2ef', '#34d399', '#60a5fa', '#fb7185', '#a3e635', '#c4b5fd'],
    positive: '#a3e635',
    negative: '#fb7185',
  },
}

const DEFAULT_CHART_WIDTH = 800
const DEFAULT_CHART_HEIGHT = 400
const MAX_CHART_DIMENSION = 4000

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
  data: number[]
  backgroundColor?: string | string[]
  borderColor?: string | string[]
  fill?: boolean
}

/**
 * Apply theme colors to datasets that don't specify their own. Each dataset gets
 * a different color from the palette by index. For pie/doughnut/polarArea where
 * each slice is a separate color, the palette is applied across data points
 * within a single dataset.
 *
 * Palettes have 7 colors. With more than 7 datasets the palette wraps via
 * `idx % palette.length` — adjacent series can end up sharing a color. To
 * differentiate >7 series, callers should supply explicit `borderColor` /
 * `backgroundColor` per dataset instead of relying on the palette.
 */
function applyThemePalette(
  datasets: ChartDataset[],
  theme: ChartTheme,
  chartType: string
): ChartDataset[] {
  const sliceTypes = new Set(['pie', 'doughnut', 'polarArea'])
  const isSliceType = sliceTypes.has(chartType)

  return datasets.map((ds, idx) => {
    const out: ChartDataset = { ...ds }
    if (isSliceType) {
      if (!out.backgroundColor) {
        out.backgroundColor = ds.data.map((_, i) => theme.palette[i % theme.palette.length])
      }
    } else {
      const color = theme.palette[idx % theme.palette.length]
      if (!out.borderColor) out.borderColor = color
      if (!out.backgroundColor) {
        // For line/area, semi-transparent fill; for bar, solid.
        out.backgroundColor = chartType === 'line' || chartType === 'area' ? `${color}33` : color
      }
      if (chartType === 'area' && out.fill === undefined) {
        out.fill = true
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
    scales?: { x?: Record<string, unknown>; y?: Record<string, unknown> }
    plugins?: { legend?: { display?: boolean } }
    indexAxis?: 'x' | 'y'
  }
  /** When set, the caller should replace the labels array with this value. */
  labels?: string[]
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
  const o: ResolvedChartType = { chartType: 'bar', optionsOverrides: {} }
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
    case 'mixedBarLine':
      o.chartType = 'bar'
      // First dataset stays as bar (default for mixed); subsequent
      // datasets render as line overlays via Chart.js per-dataset `type`.
      datasets.forEach((d, i) => {
        if (i > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(d as any).type = 'line'
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(d as any).fill = false
        }
      })
      return o
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
      const rawValue = Array.isArray(ds.data) ? Number(ds.data[0]) : 0
      const max = Math.max(0, Number(args.gaugeMax) || 100)
      const value = Math.min(Math.max(rawValue || 0, 0), max)
      const fill = theme.palette[0]
      const remainder = theme.gridColor
      ds.data = [value, max - value]
      ds.backgroundColor = [fill, remainder]
      ds.borderColor = [fill, remainder]
      // Drop any extra datasets — gauge is single-value.
      datasets.length = 1
      o.labels = ['Value', 'Remainder']
      o.optionsOverrides = {
        rotation: -90,
        circumference: 180,
        cutout: '70%',
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      const paired = (ds.data as number[]).map((v, i) => ({ v: Number(v) || 0, l: lbls[i] ?? '' }))
      paired.sort((a, b) => b.v - a.v)
      ds.data = paired.map(p => p.v)
      o.labels = paired.map(p => p.l)
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

const generateChart: InternalToolDefinition = {
  name: 'clerum__generate_chart',
  description:
    'Render a chart as a PNG image, suitable for embedding in PDFs, DOCX, XLSX, PPTX, or HTML dashboards. ' +
    'Core types: line, bar, horizontalBar, pie, doughnut, area, scatter, radar, polarArea, bubble. ' +
    'Extended types: stackedBar, stackedArea, mixedBarLine (bar+line combo), ' +
    'gauge (half-circle dial 0..max), waterfall (step-by-step deltas), funnel (sorted pipeline). ' +
    "Returns the file path under the output dir; use it as 'images' input for other generators.",
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'revenue-7d.png'). Extension .png added if missing.",
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
          'Chart type. "area"=line with fill. "stackedBar"/"stackedArea"=stacked variants. ' +
          '"mixedBarLine"=first dataset rendered as bar, rest as line overlay (financial / KPI vs target). ' +
          '"gauge"=single value 0..gaugeMax shown as a half-circle dial. ' +
          '"waterfall"=array of deltas rendered as floating step bars + a final total bar. ' +
          '"funnel"=horizontal bar sorted descending (great for conversion / pipeline visuals).',
      },
      title: {
        type: 'string',
        description: 'Optional chart title rendered above the plot.',
      },
      width: {
        type: 'number',
        description: `Pixel width (default ${DEFAULT_CHART_WIDTH}, max ${MAX_CHART_DIMENSION}).`,
      },
      height: {
        type: 'number',
        description: `Pixel height (default ${DEFAULT_CHART_HEIGHT}, max ${MAX_CHART_DIMENSION}).`,
      },
      theme: {
        type: 'string',
        enum: ['light', 'dark', 'corporate', 'warm', 'warm-dark'],
        description:
          "Color theme. 'warm' / 'warm-dark' are a warm amber accent palette (amber on off-white / near-black). Default 'light'.",
      },
      data: {
        type: 'object',
        description:
          'Chart.js-compatible data object: { labels: string[], datasets: [{label, data}] }. ' +
          'Colors are auto-assigned from the theme palette unless you specify backgroundColor / borderColor.',
        properties: {
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'X-axis labels (or slice labels for pie/doughnut).',
          },
          datasets: {
            type: 'array',
            description: 'One or more datasets, each with a label and a numeric data array.',
            items: {
              type: 'object',
              required: ['data'],
              properties: {
                label: { type: 'string' },
                data: {
                  type: 'array',
                  description:
                    'Either an array of numbers (most types) or an array of {x,y,r} objects (bubble).',
                  items: {
                    oneOf: [
                      { type: 'number' },
                      {
                        type: 'object',
                        required: ['x', 'y', 'r'],
                        properties: {
                          x: { type: 'number' },
                          y: { type: 'number' },
                          r: { type: 'number' },
                        },
                      },
                    ],
                  },
                },
                backgroundColor: { type: ['string', 'array'] },
                borderColor: { type: ['string', 'array'] },
                fill: { type: 'boolean' },
              },
            },
          },
        },
        required: ['datasets'],
      },
      yAxisLabel: { type: 'string', description: 'Optional Y-axis title.' },
      xAxisLabel: { type: 'string', description: 'Optional X-axis title.' },
      gaugeMax: {
        type: 'number',
        description: "Only used by type='gauge'. Maximum value of the dial (default 100).",
      },
    },
    required: ['filename', 'type', 'data'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    let chart: Chart | undefined
    try {
      const rawName = String(args.filename ?? 'chart.png')
      const filename = sanitizeFilename(ensureExtension(rawName, 'png'))
      const chartTypeRaw = String(args.type ?? 'bar')
      if (!SUPPORTED_CHART_TYPES.has(chartTypeRaw)) {
        return { success: false, error: `Unsupported chart type: ${chartTypeRaw}` }
      }

      const width = clampDimension(args.width, DEFAULT_CHART_WIDTH)
      const height = clampDimension(args.height, DEFAULT_CHART_HEIGHT)

      // Pre-allocation guard: a 4000×4000 RGBA canvas allocates ~64 MB
      // before enforceQuota even sees the file size. Reject canvases
      // whose RGBA buffer alone would exceed the recipe quota.
      const canvasBytes = width * height * 4
      enforceQuota(outputDir, canvasBytes)

      const themeName = String(args.theme ?? 'light')
      const theme = CHART_THEMES[themeName] ?? CHART_THEMES.light

      const data = args.data as { labels?: unknown; datasets?: ChartDataset[] } | undefined
      if (!data || !Array.isArray(data.datasets) || data.datasets.length === 0) {
        return { success: false, error: 'data.datasets must be a non-empty array' }
      }

      // Map our exposed types to Chart.js's internal type names AND collect
      // any per-type option overrides (stacked scales, indexAxis, gauge
      // rotation, etc.). The composition is in resolveChartType — the
      // execute body just merges the result into the final config.
      let labels = Array.isArray(data.labels) ? [...(data.labels as string[])] : undefined
      const themedDatasets = applyThemePalette(data.datasets, theme, chartTypeRaw)
      const resolved = resolveChartType(chartTypeRaw, themedDatasets, labels, theme, args)
      const chartType = resolved.chartType
      // Mutations to themedDatasets / labels are returned via resolved.
      if (resolved.labels !== undefined) labels = resolved.labels

      const showAxes =
        (chartType === 'bar' ||
          chartType === 'line' ||
          chartType === 'scatter' ||
          chartType === 'bubble') &&
        chartTypeRaw !== 'gauge'
      const yAxisLabel = args.yAxisLabel ? String(args.yAxisLabel) : undefined
      const xAxisLabel = args.xAxisLabel ? String(args.xAxisLabel) : undefined

      const config: ChartConfiguration = {
        type: chartType,
        data: { labels, datasets: themedDatasets as ChartConfiguration['data']['datasets'] },
        options: {
          responsive: false,
          animation: false,
          devicePixelRatio: 2,
          maintainAspectRatio: false,
          ...resolved.optionsOverrides,
          plugins: {
            title: args.title
              ? {
                  display: true,
                  text: String(args.title),
                  color: theme.textColor,
                  font: { size: 16, weight: 'bold' as const },
                  padding: { top: 8, bottom: 16 },
                }
              : { display: false },
            legend: {
              display: resolved.optionsOverrides?.plugins?.legend?.display !== false,
              labels: { color: theme.textColor },
            },
            ...(resolved.optionsOverrides?.plugins ?? {}),
          },
          scales: showAxes
            ? {
                x: {
                  ticks: { color: theme.textColor },
                  grid: { color: theme.gridColor },
                  title: xAxisLabel
                    ? { display: true, text: xAxisLabel, color: theme.textColor }
                    : { display: false },
                  ...(resolved.optionsOverrides?.scales?.x ?? {}),
                },
                y: {
                  ticks: { color: theme.textColor },
                  grid: { color: theme.gridColor },
                  title: yAxisLabel
                    ? { display: true, text: yAxisLabel, color: theme.textColor }
                    : { display: false },
                  ...(resolved.optionsOverrides?.scales?.y ?? {}),
                },
              }
            : undefined,
        },
        plugins: [
          {
            id: 'themeBackground',
            beforeDraw: ch => {
              const ctx = ch.ctx
              ctx.save()
              ctx.globalCompositeOperation = 'destination-over'
              ctx.fillStyle = theme.backgroundColor
              ctx.fillRect(0, 0, ch.width, ch.height)
              ctx.restore()
            },
          },
        ],
      }

      const canvas = createCanvas(width, height)
      const ctx = canvas.getContext('2d') as SKRSContext2D
      // Chart.js types target a browser CanvasRenderingContext2D; the Skia
      // context is API-compatible for the subset Chart.js uses.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chart = new Chart(ctx as any, config)
      chart.update('none')

      const pngBuffer = canvas.toBuffer('image/png')

      ensureDir(outputDir)
      enforceQuota(outputDir, pngBuffer.byteLength)
      const filePath = path.join(outputDir, filename)
      fs.writeFileSync(filePath, pngBuffer)

      return { success: true, artifact: buildArtifact(filePath, 'png') }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (chart) chart.destroy()
    }
  },
}

function clampDimension(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.max(Math.floor(n), 1), MAX_CHART_DIMENSION)
}

// ─── generate_markdown ───────────────────────────────────────────────

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
        type: 'string',
        description: 'Full markdown content to write.',
      },
    },
    required: ['filename', 'content'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    try {
      const rawName = String(args.filename ?? 'output.md')
      const filename = sanitizeFilename(ensureExtension(rawName, 'md'))
      const content = String(args.content ?? '')

      ensureDir(outputDir)
      enforceQuota(outputDir, Buffer.byteLength(content, 'utf-8'))
      const filePath = path.join(outputDir, filename)
      fs.writeFileSync(filePath, content, 'utf-8')

      return { success: true, artifact: buildArtifact(filePath, 'md') }
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

const PDF_FONTS: TFontDictionary = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
}

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
  headers: string[]
  rows: (string | number | null)[][]
  widths?: (string | number)[]
  layout?: 'striped' | 'minimal' | 'grid'
}

/**
 * Parse a small subset of GitHub-flavored markdown (one line at a time) into
 * pdfmake content nodes. Recognized: # H1 / ## H2 / ### H3, **bold**, *italic*,
 * `code`, - bullets, GFM pipe tables, blank line spacing. Anything else falls
 * through as plain text. Keeps the dep footprint zero — no full markdown lib.
 */
function parseInlineMarkdown(line: string): ContentText {
  // Bold first (non-greedy `[\s\S]+?` so it can include single asterisks
  // for nested italic like `**bold *italic***`); then italic with negative
  // lookbehind/lookahead to avoid eating one of a `**` pair; then inline
  // code. Order matters: bold runs first so its match wins on `**...**`.
  type Span = { text: string; bold?: boolean; italics?: boolean; mono?: boolean }
  const spans: Span[] = []
  let remaining = line
  const inlineRe = /(\*\*[\s\S]+?\*\*|(?<!\*)\*(?!\*)[^*]+\*(?!\*)|`[^`]+`)/
  while (remaining.length > 0) {
    const m = inlineRe.exec(remaining)
    if (!m) {
      spans.push({ text: remaining })
      break
    }
    if (m.index > 0) spans.push({ text: remaining.slice(0, m.index) })
    const token = m[0]
    if (token.startsWith('**')) {
      spans.push({ text: token.slice(2, -2), bold: true })
    } else if (token.startsWith('`')) {
      spans.push({ text: token.slice(1, -1), mono: true })
    } else {
      spans.push({ text: token.slice(1, -1), italics: true })
    }
    remaining = remaining.slice(m.index + token.length)
  }
  return {
    text: spans.map(s => ({
      text: s.text,
      ...(s.bold ? { bold: true } : {}),
      ...(s.italics ? { italics: true } : {}),
      ...(s.mono ? { font: 'Helvetica' } : {}),
    })),
  }
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split('|').map(c => c.trim())
}

function buildTableNode(
  headers: string[],
  rows: string[][],
  palette: PdfPalette,
  layout: 'striped' | 'minimal' | 'grid' = 'striped',
  widths?: (string | number)[]
): ContentTable {
  // Normalize each row to exactly headers.length cells. Ragged input from
  // the LLM (missing trailing cells, extra cells past header count) would
  // otherwise produce a misaligned table that pdfmake renders silently
  // wrong. Pad short rows with '' and truncate over-long rows.
  const normalizedRows = rows.map(row => normalizeRowLength(row, headers.length))
  return {
    table: {
      headerRows: 1,
      widths: widths ?? headers.map(() => '*'),
      body: [
        headers.map(h => ({ text: h, bold: true, color: '#ffffff', fillColor: palette.primary })),
        ...normalizedRows.map(row =>
          row.map(cell => {
            const parsed = parseInlineMarkdown(cell ?? '')
            // pdfmake accepts a `text` array of inline runs as a cell — use that
            // so **bold** / *italic* / `code` inside cells render correctly.
            return parsed
          })
        ),
      ],
    },
    layout: pdfTableLayout(layout, palette),
    margin: [0, 4, 0, 8],
  }
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

/**
 * Convert a markdown body string into pdfmake content nodes. Single-pass
 * line scanner that detects H1/H2/H3, GFM tables, bullets, and blank lines.
 */
function bodyToContent(body: string, palette: PdfPalette): Content[] {
  const out: Content[] = []
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trimStart()

    // Heading levels
    if (trimmed.startsWith('### ')) {
      out.push({
        text: trimmed.slice(4),
        style: 'h3',
        margin: [0, 8, 0, 4],
      })
      i++
      continue
    }
    if (trimmed.startsWith('## ')) {
      out.push({
        text: trimmed.slice(3),
        style: 'h2',
        margin: [0, 12, 0, 4],
      })
      i++
      continue
    }
    if (trimmed.startsWith('# ')) {
      out.push({
        text: trimmed.slice(2),
        style: 'h1',
        margin: [0, 16, 0, 6],
      })
      i++
      continue
    }

    // Horizontal rule
    if (/^---+$/.test(trimmed)) {
      out.push({
        canvas: [
          { type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: palette.border },
        ],
        margin: [0, 8, 0, 8],
      })
      i++
      continue
    }

    // GFM pipe table: header line, then separator, then >=1 data rows.
    if (trimmed.startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      out.push(buildTableNode(headers, rows, palette, 'striped'))
      continue
    }

    // Bullet list block
    if (trimmed.startsWith('- ')) {
      const items: ContentText[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('- ')) {
        items.push(parseInlineMarkdown(lines[i].trimStart().slice(2)))
        i++
      }
      out.push({ ul: items, margin: [0, 4, 0, 6] })
      continue
    }

    // Blank line: small vertical breathing room.
    if (trimmed === '') {
      out.push({ text: '', margin: [0, 2, 0, 2] })
      i++
      continue
    }

    // Default: paragraph with inline markdown.
    out.push({ ...parseInlineMarkdown(line), margin: [0, 0, 0, 4] })
    i++
  }
  return out
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

const generatePdf: InternalToolDefinition = {
  name: 'clerum__generate_pdf',
  description:
    'Generate a print-quality PDF. Body accepts a subset of markdown: # / ## / ### headings, ' +
    '**bold**, *italic*, `code`, GFM pipe tables, "- " bullets, "---" horizontal rules. ' +
    'Optional: images (charts, logos), explicit tables, cover page with status badge, ' +
    'page numbers + branded footer. Choose palette: default | corporate | warm | alert.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'report.pdf'). Extension .pdf added if missing.",
      },
      title: {
        type: 'string',
        description: 'Document title displayed at the top of the first page.',
      },
      body: {
        type: 'string',
        description:
          'Markdown-flavored body. Headings (#, ##, ###), **bold**, *italic*, `code`, ' +
          '"- " bullets, GFM pipe tables, "---" horizontal rules.',
      },
      palette: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description: "Color palette. Default 'default'.",
      },
      coverPage: {
        type: 'boolean',
        description:
          'When true, render a cover page with the title, optional headline, and a status badge.',
      },
      headline: {
        type: 'string',
        description: 'Optional one-line subtitle shown on the cover page beneath the title.',
      },
      statusColor: {
        type: 'string',
        enum: ['green', 'yellow', 'red'],
        description: 'Status indicator color rendered as a band on the cover page.',
      },
      images: {
        type: 'array',
        description: 'Images (charts, logos) to embed at the end of the body.',
        items: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'Absolute path to a PNG/JPG file.' },
            width: { type: 'number' },
            height: { type: 'number' },
            alignment: { type: 'string', enum: ['left', 'center', 'right'] },
          },
        },
      },
      tables: {
        type: 'array',
        description: 'Explicit tables (rendered after the body).',
        items: {
          type: 'object',
          required: ['headers', 'rows'],
          properties: {
            headers: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array' } },
            widths: { type: 'array' },
            layout: { type: 'string', enum: ['striped', 'minimal', 'grid'] },
          },
        },
      },
      branding: {
        type: 'object',
        description: 'Optional branding shown in header/footer.',
        properties: {
          logoPath: { type: 'string' },
          companyName: { type: 'string' },
          footerText: { type: 'string' },
        },
      },
    },
    required: ['filename', 'body'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    try {
      const rawName = String(args.filename ?? 'output.pdf')
      const filename = sanitizeFilename(ensureExtension(rawName, 'pdf'))
      const title = args.title ? String(args.title) : undefined
      const body = String(args.body ?? '')
      const paletteName = String(args.palette ?? 'default')
      const palette = PDF_PALETTES[paletteName] ?? PDF_PALETTES.default
      const branding = (args.branding ?? {}) as PdfBranding
      const images = (args.images ?? []) as PdfImageRef[]
      const tables = (args.tables ?? []) as PdfTableSpec[]
      const coverPage = Boolean(args.coverPage)
      const headline = args.headline ? String(args.headline) : undefined
      const statusBand = statusColorFromPalette(palette, args.statusColor as string | undefined)

      const content: Content[] = []

      // Cover page.
      if (coverPage && title) {
        if (statusBand) {
          content.push({
            canvas: [
              {
                type: 'rect',
                x: 0,
                y: 0,
                w: 515,
                h: 6,
                color: statusBand,
              },
            ],
            margin: [0, 0, 0, 24],
          })
        }
        if (branding.logoPath) {
          const safeLogoPath = validateOutputPath(branding.logoPath, outputDir)
          if (fs.existsSync(safeLogoPath)) {
            content.push({
              image: safeLogoPath,
              width: 120,
              margin: [0, 0, 0, 12],
            })
          }
        }
        content.push({
          text: title,
          style: 'cover',
          color: palette.primary,
          margin: [0, 80, 0, 12],
        })
        if (headline) {
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
      } else if (title) {
        content.push({
          text: title,
          style: 'docTitle',
          color: palette.primary,
          margin: [0, 0, 0, 12],
        })
      }

      // Body.
      content.push(...bodyToContent(body, palette))

      // Tables (after body).
      for (const t of tables) {
        if (!t || !Array.isArray(t.headers) || !Array.isArray(t.rows)) continue
        const stringRows = t.rows.map(r => r.map(c => (c == null ? '' : String(c))))
        content.push(buildTableNode(t.headers, stringRows, palette, t.layout ?? 'striped'))
      }

      // Images (charts, logos) at the end of the body.
      for (const img of images) {
        if (!img.path) continue
        const safeImgPath = validateOutputPath(img.path, outputDir)
        if (!fs.existsSync(safeImgPath)) continue
        content.push({
          image: safeImgPath,
          ...(img.width ? { width: img.width } : { fit: [515, 320] }),
          ...(img.height ? { height: img.height } : {}),
          alignment: img.alignment ?? 'center',
          margin: [0, 8, 0, 8],
        } as Content)
      }

      const docDef: TDocumentDefinitions = {
        info: {
          title: title ?? 'Report',
          ...(branding.companyName ? { creator: branding.companyName } : {}),
        },
        pageSize: 'A4',
        pageMargins: [40, 60, 40, 60],
        defaultStyle: { font: 'Helvetica', fontSize: 11, color: palette.text, lineHeight: 1.3 },
        styles: {
          cover: { fontSize: 36, bold: true },
          lead: { fontSize: 16, italics: true },
          docTitle: { fontSize: 22, bold: true },
          h1: { fontSize: 18, bold: true, color: palette.primary },
          h2: { fontSize: 14, bold: true, color: palette.primary },
          h3: { fontSize: 12, bold: true, color: palette.muted },
        },
        header: (currentPage: number) =>
          currentPage === 1 && coverPage
            ? null
            : {
                columns: [
                  branding.companyName
                    ? { text: branding.companyName, color: palette.muted, fontSize: 9 }
                    : { text: '' },
                  title
                    ? { text: title, color: palette.muted, fontSize: 9, alignment: 'right' }
                    : { text: '' },
                ],
                margin: [40, 24, 40, 0],
              },
        footer: (currentPage: number, pageCount: number) => ({
          columns: [
            {
              text: branding.footerText ?? '',
              color: palette.muted,
              fontSize: 9,
            },
            {
              text: `${currentPage} / ${pageCount}`,
              color: palette.muted,
              fontSize: 9,
              alignment: 'right',
            },
          ],
          margin: [40, 0, 40, 24],
        }),
        content,
      }

      const printer = new PdfPrinter(PDF_FONTS)
      const pdfDoc = printer.createPdfKitDocument(docDef)

      const pdfBuffer: Buffer = await new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        pdfDoc.on('data', (c: Buffer) => chunks.push(c))
        pdfDoc.on('end', () => resolve(Buffer.concat(chunks)))
        pdfDoc.on('error', reject)
        pdfDoc.end()
      })

      ensureDir(outputDir)
      enforceQuota(outputDir, pdfBuffer.byteLength)
      const filePath = path.join(outputDir, filename)
      fs.writeFileSync(filePath, pdfBuffer)

      return { success: true, artifact: buildArtifact(filePath, 'pdf') }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

// ─── generate_docx ───────────────────────────────────────────────────

interface DocxPalette {
  // All colors stored canonical: '#xxxxxx' lowercase (matching PDF_PALETTES).
  // The docx library expects bare uppercase hex without '#'; use docxHex() at
  // usage sites to convert.
  primary: string
  primaryDark: string
  text: string
  muted: string
  border: string
  zebra: string
  surface: string
}

const DOCX_PALETTES: Record<string, DocxPalette> = {
  default: {
    primary: '#0f172a',
    primaryDark: '#020617',
    text: '#0f172a',
    muted: '#475569',
    border: '#cbd5e1',
    zebra: '#f8fafc',
    surface: '#f1f5f9',
  },
  corporate: {
    primary: '#1e3a8a',
    primaryDark: '#1e293b',
    text: '#1e293b',
    muted: '#475569',
    border: '#cbd5e1',
    zebra: '#f1f5f9',
    surface: '#e0f2fe',
  },
  warm: {
    primary: '#b45309',
    primaryDark: '#78350f',
    text: '#2f2823',
    muted: '#66584c',
    border: '#d6d2cc',
    zebra: '#fefdfb',
    surface: '#f7f7f5',
  },
  alert: {
    primary: '#9f1239',
    primaryDark: '#4c0519',
    text: '#1f2937',
    muted: '#4b5563',
    border: '#fecaca',
    zebra: '#fef2f2',
    surface: '#fee2e2',
  },
}

/**
 * Convert a canonical '#xxxxxx' hex (as stored in DOCX_PALETTES) to the
 * bare uppercase 6-char form that the docx library expects for color/fill
 * properties. Pass-through-safe for already-bare hex strings.
 */
function docxHex(c: string): string {
  return c.startsWith('#') ? c.slice(1).toUpperCase() : c.toUpperCase()
}

interface DocxBranding {
  companyName?: string
  logoPath?: string
  footerText?: string
}

interface DocxImageRef {
  path: string
  width?: number
  height?: number
  alignment?: 'left' | 'center' | 'right'
}

interface DocxTableSpec {
  headers: string[]
  rows: (string | number | null)[][]
  layout?: 'striped' | 'minimal' | 'grid'
}

/**
 * Parse inline markdown in a single line into docx TextRun objects.
 * Supports **bold**, *italic*, `code`. Falls through as plain text otherwise.
 */
function parseInlineMarkdownToRuns(text: string, baseColor?: string): TextRun[] {
  // Same logic as parseInlineMarkdown above: non-greedy bold so nested
  // single asterisks (italic) don't break `**bold *italic***`.
  const runs: TextRun[] = []
  let remaining = text
  const inlineRe = /(\*\*[\s\S]+?\*\*|(?<!\*)\*(?!\*)[^*]+\*(?!\*)|`[^`]+`)/

  while (remaining.length > 0) {
    const m = inlineRe.exec(remaining)
    if (!m) {
      if (remaining.length > 0) {
        runs.push(new TextRun({ text: remaining, color: baseColor, size: 22 }))
      }
      break
    }
    if (m.index > 0) {
      runs.push(new TextRun({ text: remaining.slice(0, m.index), color: baseColor, size: 22 }))
    }
    const token = m[0]
    if (token.startsWith('**')) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true, color: baseColor, size: 22 }))
    } else if (token.startsWith('`')) {
      runs.push(
        new TextRun({
          text: token.slice(1, -1),
          font: 'Consolas',
          color: baseColor,
          size: 20,
        })
      )
    } else {
      runs.push(
        new TextRun({ text: token.slice(1, -1), italics: true, color: baseColor, size: 22 })
      )
    }
    remaining = remaining.slice(m.index + token.length)
  }
  return runs.length > 0 ? runs : [new TextRun({ text: '', color: baseColor })]
}

function buildDocxTable(
  headers: string[],
  rows: string[][],
  palette: DocxPalette,
  layout: 'striped' | 'minimal' | 'grid' = 'striped'
): DocxTable {
  // Pad/truncate each row to headers.length so ragged input doesn't
  // produce a misaligned table that Word renders silently wrong.
  const normalizedRows = rows.map(row => normalizeRowLength(row, headers.length))
  const headerRow = new DocxTableRow({
    tableHeader: true,
    children: headers.map(
      h =>
        new DocxTableCell({
          shading: { type: ShadingType.CLEAR, fill: docxHex(palette.primary), color: 'auto' },
          children: [
            new Paragraph({
              children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 22 })],
            }),
          ],
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
        })
    ),
  })

  const bodyRows = normalizedRows.map(
    (row, rIdx) =>
      new DocxTableRow({
        children: row.map(cell => {
          const stripeFill =
            layout === 'striped' && rIdx % 2 === 1 ? docxHex(palette.zebra) : undefined
          return new DocxTableCell({
            ...(stripeFill
              ? { shading: { type: ShadingType.CLEAR, fill: stripeFill, color: 'auto' } }
              : {}),
            children: [
              new Paragraph({
                children: parseInlineMarkdownToRuns(cell ?? '', docxHex(palette.text)),
              }),
            ],
            margins: { top: 60, bottom: 60, left: 120, right: 120 },
          })
        }),
      })
  )

  const cellBorder = (
    style: (typeof BorderStyle)[keyof typeof BorderStyle],
    color: string,
    size: number
  ) => ({ style, color, size })
  const noBorder = cellBorder(BorderStyle.NONE, 'auto', 0)
  const lightBorder = cellBorder(BorderStyle.SINGLE, docxHex(palette.border), 4)

  let borders
  if (layout === 'minimal') {
    borders = {
      top: lightBorder,
      bottom: lightBorder,
      left: noBorder,
      right: noBorder,
      insideHorizontal: noBorder,
      insideVertical: noBorder,
    }
  } else if (layout === 'grid') {
    borders = {
      top: lightBorder,
      bottom: lightBorder,
      left: lightBorder,
      right: lightBorder,
      insideHorizontal: lightBorder,
      insideVertical: lightBorder,
    }
  } else {
    // striped
    borders = {
      top: cellBorder(BorderStyle.SINGLE, docxHex(palette.primaryDark), 6),
      bottom: cellBorder(BorderStyle.SINGLE, docxHex(palette.primaryDark), 6),
      left: noBorder,
      right: noBorder,
      insideHorizontal: cellBorder(BorderStyle.SINGLE, docxHex(palette.border), 2),
      insideVertical: noBorder,
    }
  }

  return new DocxTable({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
    borders,
  })
}

function isTableSeparatorLine(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)
}

function splitTableRowDocx(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split('|').map(c => c.trim())
}

/**
 * Convert markdown body into docx Paragraph + Table objects, applying palette
 * colors to headings. Mirrors the GFM subset supported by the PDF tool.
 */
function bodyToDocxChildren(body: string, palette: DocxPalette): (Paragraph | DocxTable)[] {
  const out: (Paragraph | DocxTable)[] = []
  const lines = body.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trimStart()

    // ### H3
    if (trimmed.startsWith('### ')) {
      out.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 80 },
          children: [
            new TextRun({
              text: trimmed.slice(4),
              bold: true,
              color: docxHex(palette.muted),
              size: 24,
            }),
          ],
        })
      )
      i++
      continue
    }
    // ## H2
    if (trimmed.startsWith('## ')) {
      out.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 280, after: 120 },
          children: [
            new TextRun({
              text: trimmed.slice(3),
              bold: true,
              color: docxHex(palette.primary),
              size: 28,
            }),
          ],
        })
      )
      i++
      continue
    }
    // # H1
    if (trimmed.startsWith('# ')) {
      out.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 360, after: 160 },
          children: [
            new TextRun({
              text: trimmed.slice(2),
              bold: true,
              color: docxHex(palette.primary),
              size: 36,
            }),
          ],
        })
      )
      i++
      continue
    }

    // GFM table
    if (trimmed.startsWith('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      const headers = splitTableRowDocx(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        rows.push(splitTableRowDocx(lines[i]))
        i++
      }
      out.push(buildDocxTable(headers, rows, palette, 'striped'))
      // Trailing empty paragraph for spacing.
      out.push(new Paragraph({ children: [new TextRun({ text: '' })], spacing: { before: 60 } }))
      continue
    }

    // Bullet list
    if (trimmed.startsWith('- ')) {
      while (i < lines.length && lines[i].trimStart().startsWith('- ')) {
        out.push(
          new Paragraph({
            numbering: { reference: 'doc-bullets', level: 0 },
            children: parseInlineMarkdownToRuns(
              lines[i].trimStart().slice(2),
              docxHex(palette.text)
            ),
          })
        )
        i++
      }
      continue
    }

    // Horizontal rule (visual separator paragraph with bottom border)
    if (/^---+$/.test(trimmed)) {
      out.push(
        new Paragraph({
          spacing: { before: 120, after: 120 },
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              color: docxHex(palette.border),
              size: 6,
              space: 1,
            },
          },
          children: [new TextRun({ text: '' })],
        })
      )
      i++
      continue
    }

    // Blank line
    if (trimmed === '') {
      out.push(new Paragraph({ children: [new TextRun({ text: '' })] }))
      i++
      continue
    }

    // Default paragraph with inline markdown
    out.push(
      new Paragraph({
        spacing: { after: 80 },
        children: parseInlineMarkdownToRuns(line, docxHex(palette.text)),
      })
    )
    i++
  }

  return out
}

const generateDocx: InternalToolDefinition = {
  name: 'clerum__generate_docx',
  description:
    'Generate a styled Word (.docx) file. Body accepts a subset of markdown: # / ## / ### headings, ' +
    '**bold**, *italic*, `code`, GFM pipe tables, "- " bullets, "---" horizontal rules. ' +
    'Optional: explicit tables, images (charts/logos), branded header/footer with page numbers, ' +
    'palette: default | corporate | warm | alert.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'report.docx'). Extension .docx added if missing.",
      },
      title: {
        type: 'string',
        description: 'Document title rendered at the top with palette color.',
      },
      body: {
        type: 'string',
        description:
          'Markdown-flavored body. Headings (#, ##, ###), **bold**, *italic*, `code`, ' +
          '"- " bullets, GFM pipe tables, "---" horizontal rules.',
      },
      palette: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description: "Color palette. Default 'default'.",
      },
      headline: {
        type: 'string',
        description: 'Optional one-line subtitle shown beneath the title.',
      },
      images: {
        type: 'array',
        description: 'Images (charts, logos) to embed at the end of the body.',
        items: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'Absolute path to a PNG/JPG file.' },
            width: { type: 'number', description: 'Width in pixels. Default 480.' },
            height: { type: 'number', description: 'Height in pixels. Default 270.' },
            alignment: { type: 'string', enum: ['left', 'center', 'right'] },
          },
        },
      },
      tables: {
        type: 'array',
        description: 'Explicit tables (rendered after the body).',
        items: {
          type: 'object',
          required: ['headers', 'rows'],
          properties: {
            headers: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array' } },
            layout: { type: 'string', enum: ['striped', 'minimal', 'grid'] },
          },
        },
      },
      branding: {
        type: 'object',
        description: 'Optional branding shown in header/footer.',
        properties: {
          companyName: { type: 'string' },
          logoPath: { type: 'string' },
          footerText: { type: 'string' },
        },
      },
    },
    required: ['filename', 'body'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    try {
      const rawName = String(args.filename ?? 'output.docx')
      const filename = sanitizeFilename(ensureExtension(rawName, 'docx'))
      const title = args.title ? String(args.title) : undefined
      const headline = args.headline ? String(args.headline) : undefined
      const body = String(args.body ?? '')
      const paletteName = String(args.palette ?? 'default')
      const palette = DOCX_PALETTES[paletteName] ?? DOCX_PALETTES.default
      const branding = (args.branding ?? {}) as DocxBranding
      const images = (args.images ?? []) as DocxImageRef[]
      const tables = (args.tables ?? []) as DocxTableSpec[]

      const children: (Paragraph | DocxTable)[] = []

      // Title block (top of doc, palette-colored).
      if (title) {
        if (branding.logoPath) {
          const safeLogoPath = validateOutputPath(branding.logoPath, outputDir)
          if (fs.existsSync(safeLogoPath)) {
            const logoBytes = fs.readFileSync(safeLogoPath)
            const ext = (path.extname(safeLogoPath).slice(1) || 'png').toLowerCase()
            const supported: Record<string, 'png' | 'jpg' | 'gif'> = {
              png: 'png',
              jpg: 'jpg',
              jpeg: 'jpg',
              gif: 'gif',
            }
            const docxExt = supported[ext] ?? 'png'
            children.push(
              new Paragraph({
                spacing: { after: 160 },
                children: [
                  new ImageRun({
                    data: logoBytes,
                    transformation: { width: 100, height: 30 },
                    type: docxExt,
                  } as never),
                ],
              })
            )
          }
        }
        children.push(
          new Paragraph({
            heading: HeadingLevel.TITLE,
            spacing: { after: 120 },
            children: [
              new TextRun({ text: title, bold: true, color: docxHex(palette.primary), size: 48 }),
            ],
          })
        )
        if (headline) {
          children.push(
            new Paragraph({
              spacing: { after: 240 },
              children: [
                new TextRun({
                  text: headline,
                  italics: true,
                  color: docxHex(palette.muted),
                  size: 26,
                }),
              ],
            })
          )
        }
      }

      // Body.
      children.push(...bodyToDocxChildren(body, palette))

      // Explicit tables (after body).
      for (const t of tables) {
        if (!t || !Array.isArray(t.headers) || !Array.isArray(t.rows)) continue
        const stringRows = t.rows.map(r => r.map(c => (c == null ? '' : String(c))))
        children.push(buildDocxTable(t.headers, stringRows, palette, t.layout ?? 'striped'))
        children.push(new Paragraph({ children: [new TextRun({ text: '' })] }))
      }

      // Images at the end.
      for (const img of images) {
        if (!img.path) continue
        const safeImgPath = validateOutputPath(img.path, outputDir)
        if (!fs.existsSync(safeImgPath)) continue
        const imgBytes = fs.readFileSync(safeImgPath)
        const ext = (path.extname(safeImgPath).slice(1) || 'png').toLowerCase()
        const supported: Record<string, 'png' | 'jpg' | 'gif'> = {
          png: 'png',
          jpg: 'jpg',
          jpeg: 'jpg',
          gif: 'gif',
        }
        const docxExt = supported[ext] ?? 'png'
        const width = img.width ?? 480
        const height = img.height ?? 270
        const align =
          img.alignment === 'center'
            ? AlignmentType.CENTER
            : img.alignment === 'right'
              ? AlignmentType.RIGHT
              : AlignmentType.LEFT
        children.push(
          new Paragraph({
            alignment: align,
            spacing: { before: 160, after: 160 },
            children: [
              new ImageRun({
                data: imgBytes,
                transformation: { width, height },
                type: docxExt,
              } as never),
            ],
          })
        )
      }
      // Footer with branding + page numbers. Mixed `children:` (literal
      // label + PageNumber field) is the only API the docx lib exposes
      // for inline page-number runs — buffer assembles fine; Word
      // resolves the field on open.
      const footerMutedColor = docxHex(palette.muted)
      const footer = new DocxFooter({
        children: [
          new Paragraph({
            alignment: AlignmentType.LEFT,
            children: [
              new TextRun({
                text: branding.footerText ?? '',
                color: footerMutedColor,
                size: 18,
              }),
              new TextRun({ text: '\t\t', color: footerMutedColor, size: 18 }),
              new TextRun({
                children: ['Page ', PageNumber.CURRENT],
                color: footerMutedColor,
                size: 18,
              }),
              new TextRun({
                children: [' / ', PageNumber.TOTAL_PAGES],
                color: footerMutedColor,
                size: 18,
              }),
            ],
          }),
        ],
      })

      // Header with company name + title.
      const headerMutedColor = docxHex(palette.muted)
      const header = new DocxHeader({
        children: [
          new Paragraph({
            alignment: AlignmentType.LEFT,
            children: [
              new TextRun({
                text: branding.companyName ?? '',
                color: headerMutedColor,
                size: 18,
              }),
              new TextRun({ text: '\t\t', color: headerMutedColor, size: 18 }),
              new TextRun({
                text: title ?? '',
                color: headerMutedColor,
                size: 18,
              }),
            ],
          }),
        ],
      })

      const doc = new DocxDocument({
        creator: branding.companyName ?? '',
        title: title ?? 'Report',
        description: headline,
        styles: {
          default: {
            document: {
              run: { font: 'Calibri', size: 22, color: docxHex(palette.text) },
              paragraph: { spacing: { line: 320, after: 80 } },
            },
          },
        },
        numbering: {
          config: [
            {
              reference: 'doc-bullets',
              levels: [
                {
                  level: 0,
                  format: LevelFormat.BULLET,
                  text: '•',
                  alignment: AlignmentType.LEFT,
                  style: {
                    paragraph: { indent: { left: 360, hanging: 240 } },
                  },
                },
              ],
            },
          ],
        },
        sections: [
          {
            headers: { default: header },
            footers: { default: footer },
            children,
          },
        ],
      })

      const buffer = await Packer.toBuffer(doc)
      ensureDir(outputDir)
      enforceQuota(outputDir, buffer.byteLength)
      const filePath = path.join(outputDir, filename)
      fs.writeFileSync(filePath, buffer)

      return { success: true, artifact: buildArtifact(filePath, 'docx') }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

// ─── generate_xlsx ───────────────────────────────────────────────────

interface XlsxPalette {
  // ARGB hex (no leading '#'), 8 chars: AA RR GG BB
  primary: string
  primaryDark: string
  text: string
  muted: string
  zebra: string
  border: string
  statusGreen: string
  statusYellow: string
  statusRed: string
}

/**
 * Convert '#xxxxxx' / '#xxxxxxxx' (or bare equivalent) to the 8-char ARGB
 * form that ExcelJS expects. Throws on non-hex input so a typo surfaces
 * instead of silently rendering as black.
 */
function hexToArgb(hex: string): string {
  const clean = String(hex ?? '').replace('#', '')
  if (!/^[0-9a-fA-F]+$/.test(clean) || (clean.length !== 6 && clean.length !== 8)) {
    throw new Error(`Invalid hex color: "${hex}" (expected #xxxxxx or #xxxxxxxx)`)
  }
  if (clean.length === 6) return `FF${clean.toUpperCase()}`
  return clean.toUpperCase()
}

const XLSX_PALETTES: Record<string, XlsxPalette> = {
  default: {
    primary: hexToArgb('#0f172a'),
    primaryDark: hexToArgb('#020617'),
    text: hexToArgb('#0f172a'),
    muted: hexToArgb('#475569'),
    zebra: hexToArgb('#f8fafc'),
    border: hexToArgb('#cbd5e1'),
    statusGreen: hexToArgb('#dcfce7'),
    statusYellow: hexToArgb('#fef9c3'),
    statusRed: hexToArgb('#fee2e2'),
  },
  corporate: {
    primary: hexToArgb('#1e3a8a'),
    primaryDark: hexToArgb('#1e293b'),
    text: hexToArgb('#1e293b'),
    muted: hexToArgb('#475569'),
    zebra: hexToArgb('#f1f5f9'),
    border: hexToArgb('#cbd5e1'),
    statusGreen: hexToArgb('#dcfce7'),
    statusYellow: hexToArgb('#fef9c3'),
    statusRed: hexToArgb('#fee2e2'),
  },
  warm: {
    primary: hexToArgb('#b45309'),
    primaryDark: hexToArgb('#78350f'),
    text: hexToArgb('#2f2823'),
    muted: hexToArgb('#66584c'),
    zebra: hexToArgb('#fefdfb'),
    border: hexToArgb('#d6d2cc'),
    statusGreen: hexToArgb('#dcfce7'),
    statusYellow: hexToArgb('#fef3c7'),
    statusRed: hexToArgb('#fee2e2'),
  },
  alert: {
    primary: hexToArgb('#9f1239'),
    primaryDark: hexToArgb('#4c0519'),
    text: hexToArgb('#1f2937'),
    muted: hexToArgb('#4b5563'),
    zebra: hexToArgb('#fef2f2'),
    border: hexToArgb('#fecaca'),
    statusGreen: hexToArgb('#dcfce7'),
    statusYellow: hexToArgb('#fef9c3'),
    statusRed: hexToArgb('#fecaca'),
  },
}

// Bounds on the per-cell regex used by XLSX conditional formatting rules.
// Pattern + input are both LLM-supplied — capping length keeps catastrophic
// backtracking on inputs like `^(a+)+$` bounded and the step timeout meaningful.
const MAX_REGEX_PATTERN_LENGTH = 256
const MAX_REGEX_INPUT_LENGTH = 4096

const NUMBER_FORMATS = {
  currencyUsd: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  currencyUsdInt: '"$"#,##0_);[Red]("$"#,##0)',
  percent: '0.0%',
  percentInt: '0%',
  integer: '#,##0',
  decimal: '#,##0.00',
  datetime: 'yyyy-mm-dd hh:mm',
  date: 'yyyy-mm-dd',
}

type ColumnFormat = keyof typeof NUMBER_FORMATS | string

interface XlsxImageRef {
  path: string
  anchor?: string // top-left cell, e.g. 'F2'
  range?: string // 'F2:M20' to span explicit area
  width?: number
  height?: number
}

interface XlsxConditionalRule {
  equals?: string | number
  notEquals?: string | number
  greaterThan?: number
  lessThan?: number
  /** Inclusive range match: `[min, max]`. Cell value must be a number with min ≤ value ≤ max. */
  between?: [number, number]
  contains?: string
  regex?: string
  fillColor?: string // hex e.g. '#fee2e2'
  fontColor?: string
  bold?: boolean
}

interface XlsxConditionalFormatSpec {
  column: string | number // header name OR 0-based index
  rules: XlsxConditionalRule[]
}

interface XlsxSheetSpec {
  name: string
  rows: unknown[][]
  titleRow?: { text: string; fillColor?: string; fontColor?: string }
  columnFormats?: Record<string | number, ColumnFormat>
  conditionalFormatting?: XlsxConditionalFormatSpec[]
  freezeHeader?: boolean
  autoFilter?: boolean
  images?: XlsxImageRef[]
}

interface XlsxBranding {
  companyName?: string
  logoPath?: string
}

/** Detect a sensible numFmt for a column based on its header name + sample data. */
function detectColumnFormat(
  header: unknown,
  sampleValues: unknown[]
): keyof typeof NUMBER_FORMATS | undefined {
  const name = String(header ?? '').toLowerCase()
  const numericSamples = sampleValues.filter(
    v => typeof v === 'number' && Number.isFinite(v)
  ) as number[]

  if (numericSamples.length === 0) return undefined

  // Currency hints in column header.
  if (/(usd|amount|revenue|price|balance|cost|fee|charge|payment|mrr|arr|\$)/.test(name)) {
    const allInts = numericSamples.every(n => Number.isInteger(n))
    return allInts ? 'currencyUsdInt' : 'currencyUsd'
  }

  // Percent hints.
  if (/(%|pct|percent|rate|share|ratio)/.test(name)) {
    // If values are 0..1 they're already fractional; if 0..100 they're already in pct units.
    const max = Math.max(...numericSamples.map(Math.abs))
    if (max <= 1.5) return 'percent'
    return 'percentInt'
  }

  // Date hints.
  if (/(date|created_at|updated_at|started_at|completed_at|timestamp)/.test(name)) {
    return 'datetime'
  }

  // Numeric default.
  const allInts = numericSamples.every(n => Number.isInteger(n))
  return allInts ? 'integer' : 'decimal'
}

function ruleMatches(rule: XlsxConditionalRule, value: unknown): boolean {
  if (rule.equals !== undefined && value !== rule.equals) return false
  if (rule.notEquals !== undefined && value === rule.notEquals) return false
  if (rule.greaterThan !== undefined) {
    if (typeof value !== 'number' || !(value > rule.greaterThan)) return false
  }
  if (rule.lessThan !== undefined) {
    if (typeof value !== 'number' || !(value < rule.lessThan)) return false
  }
  if (rule.between !== undefined) {
    if (!Array.isArray(rule.between) || rule.between.length !== 2 || typeof value !== 'number') {
      return false
    }
    const [lo, hi] = rule.between
    if (value < lo || value > hi) return false
  }
  if (rule.contains !== undefined) {
    if (typeof value !== 'string' || !value.includes(rule.contains)) return false
  }
  if (rule.regex !== undefined) {
    if (typeof value !== 'string') return false
    // Defense against catastrophic backtracking from LLM-supplied patterns.
    // safe-regex rejects nested unbounded quantifiers (star-height > 1)
    // like /(a+)+$/ that cause exponential time in JS's backtracking engine.
    // We also cap pattern length and truncate input as defense-in-depth, and
    // step execution is wall-clock bounded by resolveMaxStepTimeoutSeconds.
    if (
      typeof rule.regex !== 'string' ||
      rule.regex.length > MAX_REGEX_PATTERN_LENGTH ||
      !safeRegex(rule.regex)
    ) {
      return false
    }
    const sample =
      value.length > MAX_REGEX_INPUT_LENGTH ? value.slice(0, MAX_REGEX_INPUT_LENGTH) : value
    try {
      if (!new RegExp(rule.regex).test(sample)) return false
    } catch {
      return false
    }
  }
  return true
}

function resolveColumnIndex(column: string | number, headers: unknown[]): number | undefined {
  if (typeof column === 'number') return column
  const lower = String(column).trim().toLowerCase()
  const idx = headers.findIndex(
    h =>
      String(h ?? '')
        .trim()
        .toLowerCase() === lower
  )
  return idx === -1 ? undefined : idx
}

const generateXlsx: InternalToolDefinition = {
  name: 'clerum__generate_xlsx',
  description:
    'Generate a styled Excel (.xlsx) workbook. Each sheet supports: title row, ' +
    'palette-colored headers, freeze panes, auto-filter, currency/percent/integer ' +
    'auto-format, conditional formatting by column rules, embedded images (charts, logos). ' +
    'Backward compatible: omit new fields and you get the legacy plain workbook.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'data.xlsx'). Extension .xlsx added if missing.",
      },
      palette: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description: "Color palette. Default 'default'.",
      },
      branding: {
        type: 'object',
        description: 'Workbook-level branding for properties metadata.',
        properties: {
          companyName: { type: 'string' },
          logoPath: { type: 'string' },
        },
      },
      sheets: {
        type: 'array',
        description: 'Array of sheet objects.',
        items: {
          type: 'object',
          required: ['name', 'rows'],
          properties: {
            name: { type: 'string' },
            rows: {
              type: 'array',
              description: 'First row is the header row.',
              items: { type: 'array' },
            },
            titleRow: {
              type: 'object',
              description: 'Optional merged title row above the header.',
              properties: {
                text: { type: 'string' },
                fillColor: { type: 'string' },
                fontColor: { type: 'string' },
              },
              required: ['text'],
            },
            columnFormats: {
              type: 'object',
              description:
                'Map column index or header name to a format keyword (currencyUsd, currencyUsdInt, percent, percentInt, integer, decimal, datetime, date) or a custom Excel numFmt string.',
            },
            conditionalFormatting: {
              type: 'array',
              description: 'Rules applied per column based on cell values.',
              items: {
                type: 'object',
                required: ['column', 'rules'],
                properties: {
                  column: { type: ['string', 'number'] },
                  rules: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        equals: { type: ['string', 'number'] },
                        notEquals: { type: ['string', 'number'] },
                        greaterThan: { type: 'number' },
                        lessThan: { type: 'number' },
                        between: {
                          type: 'array',
                          items: { type: 'number' },
                          minItems: 2,
                          maxItems: 2,
                          description: 'Inclusive numeric range [min, max].',
                        },
                        contains: { type: 'string' },
                        regex: {
                          type: 'string',
                          maxLength: 256,
                          description:
                            'Regex tested against the cell value as a string. Patterns with nested unbounded quantifiers (ReDoS-prone) are rejected by a static check, as are patterns longer than 256 chars or that fail to compile; cell values longer than 4096 chars are truncated before matching.',
                        },
                        fillColor: { type: 'string' },
                        fontColor: { type: 'string' },
                        bold: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
            freezeHeader: { type: 'boolean', description: 'Default true.' },
            autoFilter: { type: 'boolean', description: 'Default true.' },
            images: {
              type: 'array',
              description: 'PNG/JPG images to embed at specific cell anchors.',
              items: {
                type: 'object',
                required: ['path'],
                properties: {
                  path: { type: 'string' },
                  anchor: { type: 'string', description: "Top-left cell anchor (e.g. 'F2')." },
                  range: { type: 'string', description: "Cell range (e.g. 'F2:M20')." },
                  width: { type: 'number' },
                  height: { type: 'number' },
                },
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
      const rawName = String(args.filename ?? 'output.xlsx')
      const filename = sanitizeFilename(ensureExtension(rawName, 'xlsx'))
      const sheets = args.sheets as XlsxSheetSpec[] | undefined
      const paletteName = String(args.palette ?? 'default')
      const palette = XLSX_PALETTES[paletteName] ?? XLSX_PALETTES.default
      const branding = (args.branding ?? {}) as XlsxBranding

      if (!Array.isArray(sheets) || sheets.length === 0) {
        return { success: false, error: 'sheets must be a non-empty array' }
      }

      const workbook = new ExcelJS.Workbook()
      workbook.creator = branding.companyName ?? ''
      workbook.company = branding.companyName ?? ''
      workbook.created = new Date()

      for (const sheet of sheets) {
        const ws = workbook.addWorksheet(String(sheet.name ?? 'Sheet'))
        if (!Array.isArray(sheet.rows)) continue
        if (sheet.rows.length === 0) continue

        const colCount = Math.max(...sheet.rows.map(r => (Array.isArray(r) ? r.length : 0)))
        if (colCount === 0) continue

        // ── Optional title row (merged across data columns only)
        let headerRowIndex = 1
        if (sheet.titleRow) {
          const titleRow = ws.addRow([safeCell(sheet.titleRow.text)])
          ws.mergeCells(1, 1, 1, colCount)
          const titleFont = {
            bold: true,
            size: 14,
            color: {
              argb: hexToArgb(sheet.titleRow.fontColor ?? '#ffffff'),
            },
          }
          const titleFill: ExcelJS.Fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: {
              argb: hexToArgb(sheet.titleRow.fillColor ?? `#${palette.primary.slice(2)}`),
            },
          }
          // Apply fill/font only to the merged range (cols 1..colCount), not
          // the entire row — otherwise exceljs writes fill on every column up
          // to Excel's max width, painting cells past the data area.
          for (let c = 1; c <= colCount; c++) {
            const cell = titleRow.getCell(c)
            cell.font = titleFont
            cell.fill = titleFill
            cell.alignment = { vertical: 'middle', horizontal: 'center' }
          }
          titleRow.height = 28
          headerRowIndex = 2
        }

        // ── Data rows (header is rows[0])
        for (let r = 0; r < sheet.rows.length; r++) {
          const row = sheet.rows[r]
          if (!Array.isArray(row)) continue
          ws.addRow(row.map(safeCell))
        }

        const headerRow = ws.getRow(headerRowIndex)
        const headers = sheet.rows[0] ?? []

        // ── Header row styling (palette background, white text, bold, border)
        // Apply at CELL level, never row level — row-level styles get written
        // as `<row s=N customFormat=1>` which Excel applies to all 16,384
        // columns of the row, painting the slate fill past the data area.
        const headerFont: Partial<ExcelJS.Font> = {
          bold: true,
          color: { argb: hexToArgb('#ffffff') },
          size: 11,
        }
        const headerFill: ExcelJS.Fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: palette.primary },
        }
        const headerBorder: Partial<ExcelJS.Borders> = {
          bottom: { style: 'thin', color: { argb: palette.primaryDark } },
        }
        const headerAlignment: Partial<ExcelJS.Alignment> = {
          vertical: 'middle',
          horizontal: 'left',
          indent: 1,
        }
        for (let c = 1; c <= colCount; c++) {
          const cell = headerRow.getCell(c)
          cell.font = headerFont
          cell.fill = headerFill
          cell.border = headerBorder
          cell.alignment = headerAlignment
        }
        headerRow.height = 22

        // ── Zebra rows for data — apply zebra fill + small font at CELL
        // level on cells 1..colCount only. Row-level styling (row.font /
        // row.fill) writes `customFormat=1` and bleeds past the data area.
        const dataRowStart = headerRowIndex + 1
        const dataRowEnd = headerRowIndex + sheet.rows.length - 1
        const dataFont: Partial<ExcelJS.Font> = {
          color: { argb: palette.text },
          size: 10,
        }
        const zebraFill: ExcelJS.Fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: palette.zebra },
        }
        for (let r = dataRowStart; r <= dataRowEnd; r++) {
          const isZebra = (r - dataRowStart) % 2 === 1
          for (let c = 1; c <= colCount; c++) {
            const cell = ws.getRow(r).getCell(c)
            cell.font = dataFont
            if (isZebra) cell.fill = zebraFill
          }
        }

        // ── Column formatting (auto + explicit)
        // Apply numFmt/alignment at the CELL level on the data range only —
        // never at the column level. Column-level styles (col.numFmt /
        // col.alignment) extend to all 1,048,576 rows in the column, which
        // Excel renders as formatting bleeding past the data range.
        const explicitFormats = sheet.columnFormats ?? {}
        for (let c = 0; c < colCount; c++) {
          const header = headers[c]
          // Resolve explicit format by header name OR index.
          let formatKey: ColumnFormat | undefined =
            (explicitFormats[c] as ColumnFormat | undefined) ??
            (explicitFormats[String(header ?? '')] as ColumnFormat | undefined)

          if (!formatKey) {
            const sampleValues: unknown[] = []
            for (let r = 1; r < sheet.rows.length; r++) {
              const cellVal = sheet.rows[r]?.[c]
              if (cellVal !== null && cellVal !== undefined) sampleValues.push(cellVal)
            }
            formatKey = detectColumnFormat(header, sampleValues)
          }

          if (formatKey) {
            const numFmt =
              formatKey in NUMBER_FORMATS
                ? NUMBER_FORMATS[formatKey as keyof typeof NUMBER_FORMATS]
                : (formatKey as string)
            const isNumeric = formatKey !== 'datetime' && formatKey !== 'date'
            for (let r = dataRowStart; r <= dataRowEnd; r++) {
              const cell = ws.getRow(r).getCell(c + 1)
              cell.numFmt = numFmt
              if (isNumeric) {
                cell.alignment = { ...(cell.alignment ?? {}), horizontal: 'right' }
              }
            }
          }
        }

        // ── Conditional formatting (apply rule-by-rule to each cell in column)
        if (Array.isArray(sheet.conditionalFormatting)) {
          for (const cf of sheet.conditionalFormatting) {
            const colIdx = resolveColumnIndex(cf.column, headers)
            if (colIdx === undefined) continue
            for (let r = dataRowStart; r <= dataRowEnd; r++) {
              const cell = ws.getRow(r).getCell(colIdx + 1)
              for (const rule of cf.rules ?? []) {
                if (ruleMatches(rule, cell.value)) {
                  if (rule.fillColor) {
                    cell.fill = {
                      type: 'pattern',
                      pattern: 'solid',
                      fgColor: { argb: hexToArgb(rule.fillColor) },
                    }
                  }
                  const newFont: Partial<ExcelJS.Font> = { ...(cell.font as object) }
                  if (rule.fontColor) newFont.color = { argb: hexToArgb(rule.fontColor) }
                  if (rule.bold !== undefined) newFont.bold = rule.bold
                  if (rule.fontColor || rule.bold !== undefined) cell.font = newFont
                  break // first matching rule wins
                }
              }
            }
          }
        }

        // ── Freeze header row (default: true if has data)
        const shouldFreeze = sheet.freezeHeader ?? sheet.rows.length > 1
        if (shouldFreeze) {
          ws.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRowIndex }]
        }

        // ── Auto-filter on header (default: true)
        const shouldAutoFilter = sheet.autoFilter ?? true
        if (shouldAutoFilter && colCount > 0 && sheet.rows.length > 1) {
          ws.autoFilter = {
            from: { row: headerRowIndex, column: 1 },
            to: { row: headerRowIndex, column: colCount },
          }
          // String form fallback for very wide sheets (>26 cols).
          if (colCount > 26) {
            ws.autoFilter = `A${headerRowIndex}:${columnLetter(colCount)}${headerRowIndex}`
          }
        }

        // ── Auto-width columns (with min/max bounds)
        ws.columns?.forEach(col => {
          let maxLen = 10
          col.eachCell?.({ includeEmpty: false }, cell => {
            const len = String(cell.value ?? '').length
            if (len > maxLen) maxLen = Math.min(len, 50)
          })
          col.width = Math.max(maxLen + 2, 12)
        })

        // ── Images (charts, logos)
        for (const img of sheet.images ?? []) {
          if (!img.path) continue
          const safeImgPath = validateOutputPath(img.path, outputDir)
          if (!fs.existsSync(safeImgPath)) continue
          const ext = (path.extname(safeImgPath).slice(1) || 'png').toLowerCase()
          if (!['png', 'jpeg', 'jpg', 'gif'].includes(ext)) continue
          const fileBytes = fs.readFileSync(safeImgPath)
          // exceljs's @types Buffer expects an ArrayBuffer-backed Buffer; in newer
          // @types/node, fs.readFileSync returns Buffer<NonSharedBuffer>. Wrap the
          // bytes in a fresh Uint8Array view to satisfy the structural type.
          const imgBuffer = Buffer.from(
            fileBytes.buffer,
            fileBytes.byteOffset,
            fileBytes.byteLength
          )
          const imageId = workbook.addImage({
            buffer: imgBuffer as unknown as ExcelJS.Buffer,
            extension: ext === 'jpg' ? 'jpeg' : (ext as 'png' | 'jpeg' | 'gif'),
          })
          if (img.range) {
            ws.addImage(imageId, img.range)
          } else if (img.anchor) {
            const ext2 =
              img.width && img.height
                ? { width: img.width, height: img.height }
                : { width: 480, height: 270 }
            ws.addImage(imageId, {
              tl: cellAddressToCoord(img.anchor),
              ext: ext2,
              editAs: 'oneCell',
            })
          } else {
            // Default placement: anchor below the data block, left-aligned.
            ws.addImage(imageId, {
              tl: { col: 0, row: headerRowIndex + sheet.rows.length },
              ext: { width: 480, height: 270 },
              editAs: 'oneCell',
            })
          }
        }
      }

      // Serialize to a buffer first so we can enforce the quota atomically
      // before committing to disk (no partial/corrupt writes on quota breach).
      const xlsxRaw = (await workbook.xlsx.writeBuffer()) as unknown as ArrayBufferView
      const xlsxBuffer = Buffer.from(xlsxRaw.buffer, xlsxRaw.byteOffset, xlsxRaw.byteLength)
      ensureDir(outputDir)
      enforceQuota(outputDir, xlsxBuffer.byteLength)
      const filePath = path.join(outputDir, filename)
      fs.writeFileSync(filePath, xlsxBuffer)

      return { success: true, artifact: buildArtifact(filePath, 'xlsx') }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

/**
 * Convert "F2" → { col: 5, row: 1 } (zero-based, ExcelJS image anchor format).
 * Throws on invalid input so a typo surfaces instead of placing the image
 * over the title row.
 */
function cellAddressToCoord(addr: string): { col: number; row: number } {
  const trimmed = String(addr ?? '').trim()
  const m = /^([A-Za-z]+)(\d+)$/.exec(trimmed)
  if (!m) {
    throw new Error(`Invalid cell anchor: "${addr}" (expected e.g. "F2")`)
  }
  const colLetters = m[1].toUpperCase()
  const rowNum = parseInt(m[2], 10)
  if (rowNum <= 0) {
    throw new Error(`Invalid cell anchor row: "${addr}" (must be >= 1)`)
  }
  let col = 0
  for (const ch of colLetters) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { col: col - 1, row: rowNum - 1 }
}

function columnLetter(n: number): string {
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// ════════════════════════════════════════════════════════════════════
// ─── DASHBOARD GENERATION (clerum__generate_dashboard) ──────────────
// ════════════════════════════════════════════════════════════════════
//
// Self-contained HTML dashboard renderer. Produces a single .html file
// with inlined CSS + Chart.js bundle, works offline, prints cleanly.
//
// Templates (4 fixed presets):
//   - executive-brief   general-purpose daily/weekly executive report
//   - operations-pulse  engineering / SRE / oncall view
//   - financial-review  finance with hero chart + dense tables
//   - technical-report  long-form engineering writeup with code blocks
//
// Themes: default | corporate | warm | alert (light + dark variants)

// ─── Theme types ────────────────────────────────────────────────────

type ThemeName = 'default' | 'corporate' | 'warm' | 'alert'

interface DashboardThemeColors {
  bg: string
  surface: string
  surfaceMuted: string
  text: string
  textMuted: string
  textSoft: string
  border: string
  primary: string
  primaryHover: string
  accent: string
  success: string
  warning: string
  danger: string
  successBg: string
  warningBg: string
  dangerBg: string
  neutralBg: string
}

interface DashboardTheme {
  name: ThemeName
  light: DashboardThemeColors
  dark: DashboardThemeColors
  fontFamily: string
  chartPalette: string[]
}

const DASHBOARD_THEMES: Record<ThemeName, DashboardTheme> = {
  default: {
    name: 'default',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    chartPalette: ['#0f172a', '#22c55e', '#f59e0b', '#ef4444', '#3b82f6', '#a855f7', '#06b6d4'],
    light: {
      bg: '#f8fafc',
      surface: '#ffffff',
      surfaceMuted: '#f1f5f9',
      text: '#0f172a',
      textMuted: '#475569',
      textSoft: '#94a3b8',
      border: '#e2e8f0',
      primary: '#0f172a',
      primaryHover: '#1e293b',
      accent: '#3b82f6',
      success: '#16a34a',
      warning: '#ca8a04',
      danger: '#dc2626',
      successBg: '#dcfce7',
      warningBg: '#fef9c3',
      dangerBg: '#fee2e2',
      neutralBg: '#f1f5f9',
    },
    dark: {
      bg: '#0f172a',
      surface: '#1e293b',
      surfaceMuted: '#334155',
      text: '#f1f5f9',
      textMuted: '#cbd5e1',
      textSoft: '#94a3b8',
      border: '#334155',
      primary: '#3b82f6',
      primaryHover: '#60a5fa',
      accent: '#3b82f6',
      success: '#22c55e',
      warning: '#facc15',
      danger: '#f87171',
      successBg: '#14532d',
      warningBg: '#713f12',
      dangerBg: '#7f1d1d',
      neutralBg: '#334155',
    },
  },
  corporate: {
    name: 'corporate',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    chartPalette: ['#1e40af', '#0891b2', '#0d9488', '#059669', '#65a30d', '#ca8a04', '#dc2626'],
    light: {
      bg: '#f1f5f9',
      surface: '#ffffff',
      surfaceMuted: '#e0f2fe',
      text: '#1e293b',
      textMuted: '#475569',
      textSoft: '#94a3b8',
      border: '#cbd5e1',
      primary: '#1e3a8a',
      primaryHover: '#1e40af',
      accent: '#0891b2',
      success: '#059669',
      warning: '#ca8a04',
      danger: '#b91c1c',
      successBg: '#dcfce7',
      warningBg: '#fef9c3',
      dangerBg: '#fee2e2',
      neutralBg: '#e0f2fe',
    },
    dark: {
      bg: '#0f172a',
      surface: '#1e293b',
      surfaceMuted: '#1e3a5f',
      text: '#e0f2fe',
      textMuted: '#bae6fd',
      textSoft: '#7dd3fc',
      border: '#1e3a5f',
      primary: '#3b82f6',
      primaryHover: '#60a5fa',
      accent: '#0ea5e9',
      success: '#34d399',
      warning: '#facc15',
      danger: '#f87171',
      successBg: '#14532d',
      warningBg: '#713f12',
      dangerBg: '#7f1d1d',
      neutralBg: '#1e3a5f',
    },
  },
  warm: {
    name: 'warm',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    chartPalette: ['#b45309', '#2f2823', '#0d9488', '#1e40af', '#9f1239', '#65a30d', '#7c3aed'],
    light: {
      bg: '#f7f7f5',
      surface: '#fffdfa',
      surfaceMuted: '#f1ede6',
      text: '#2f2823',
      textMuted: '#66584c',
      textSoft: '#857568',
      border: '#d6d2cc',
      primary: '#b45309',
      primaryHover: '#ca6e1e',
      accent: '#b45309',
      success: '#15803d',
      warning: '#b45309',
      danger: '#9f1239',
      successBg: '#dcfce7',
      warningBg: '#fef3c7',
      dangerBg: '#fee2e2',
      neutralBg: '#f1ede6',
    },
    dark: {
      bg: '#0e0f10',
      surface: '#141517',
      surfaceMuted: '#1f2123',
      text: '#f2f2ef',
      textMuted: '#c6c8cc',
      textSoft: '#92969e',
      border: '#2a2c2f',
      primary: '#ca6e1e',
      primaryHover: '#e0833a',
      accent: '#ca6e1e',
      success: '#34d399',
      warning: '#fbbf24',
      danger: '#fb7185',
      successBg: '#14532d',
      warningBg: '#78350f',
      dangerBg: '#7f1d1d',
      neutralBg: '#1f2123',
    },
  },
  alert: {
    name: 'alert',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    chartPalette: ['#9f1239', '#dc2626', '#ea580c', '#ca8a04', '#65a30d', '#0891b2', '#1e40af'],
    light: {
      bg: '#fef2f2',
      surface: '#ffffff',
      surfaceMuted: '#fee2e2',
      text: '#1f2937',
      textMuted: '#4b5563',
      textSoft: '#9ca3af',
      border: '#fecaca',
      primary: '#9f1239',
      primaryHover: '#be123c',
      accent: '#dc2626',
      success: '#15803d',
      warning: '#ca8a04',
      danger: '#9f1239',
      successBg: '#dcfce7',
      warningBg: '#fef9c3',
      dangerBg: '#fecaca',
      neutralBg: '#fee2e2',
    },
    dark: {
      bg: '#1f0a0a',
      surface: '#2c0f0f',
      surfaceMuted: '#3d1414',
      text: '#fee2e2',
      textMuted: '#fca5a5',
      textSoft: '#f87171',
      border: '#3d1414',
      primary: '#fb7185',
      primaryHover: '#fda4af',
      accent: '#f87171',
      success: '#34d399',
      warning: '#facc15',
      danger: '#fb7185',
      successBg: '#14532d',
      warningBg: '#713f12',
      dangerBg: '#7f1d1d',
      neutralBg: '#3d1414',
    },
  },
}

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
  --neutral-bg: ${c.neutralBg};`.trim()
}

function buildDashboardCss(theme: DashboardTheme, defaultMode: 'light' | 'dark' = 'light'): string {
  const lightVars = dashboardColorVars(theme.light)
  const darkVars = dashboardColorVars(theme.dark)
  const baseVars = defaultMode === 'dark' ? darkVars : lightVars
  const oppositeVars = defaultMode === 'dark' ? lightVars : darkVars
  const oppositeKey = defaultMode === 'dark' ? 'light' : 'dark'

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

@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    ${darkVars}
  }
}

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
.kpi-card__delta[data-direction="up"]   { color: var(--success); }
.kpi-card__delta[data-direction="down"] { color: var(--danger); }
.kpi-card__delta[data-direction="neutral"] { color: var(--text-muted); }
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
  overflow: hidden;
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
.data-table .severity-badge {
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
  body { background: white; }
  .dashboard { max-width: 100%; padding: 0; }
  .kpi-card, .chart-card, .data-table-wrap, .narrative, .callout {
    box-shadow: none;
    break-inside: avoid;
  }
  .hero { box-shadow: none; }
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

interface KpiCard {
  label: string
  value: string | number
  delta?: string
  deltaDirection?: 'up' | 'down' | 'neutral'
  sparkline?: number[]
  accent?: 'success' | 'warning' | 'danger' | 'neutral'
}

interface ChartSpec {
  type: 'line' | 'bar' | 'horizontalBar' | 'pie' | 'doughnut' | 'area' | 'radar' | 'polarArea'
  title?: string
  labels?: string[]
  datasets: Array<{
    label?: string
    data: number[]
    backgroundColor?: string | string[]
    borderColor?: string | string[]
    fill?: boolean
  }>
  yAxisLabel?: string
  xAxisLabel?: string
}

interface TableSpec {
  title?: string
  headers: string[]
  rows: (string | number | null)[][]
  columnTypes?: Record<string | number, 'severity' | 'priority' | 'plain' | 'status'>
}

interface SectionSpec {
  title?: string
  type: 'narrative' | 'bullets' | 'callout' | 'code'
  content: string | string[]
  tone?: 'info' | 'success' | 'warning' | 'danger'
  language?: string
}

interface ServiceHealth {
  name: string
  status: 'healthy' | 'degraded' | 'down' | 'maintenance'
  metric?: string
  delta?: string
  deltaDirection?: 'up' | 'down' | 'neutral'
}

interface IncidentItem {
  time: string
  title: string
  severity?: 'critical' | 'high' | 'med' | 'low' | 'info'
  description?: string
  resolvedAt?: string
}

interface FooterMeta {
  date?: string
  author?: string
  runId?: string
}

interface DashboardBranding {
  companyName?: string
  footerText?: string
}

function escapeDashHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#x2F;')
}

function renderInlineMd(s: string): string {
  return escapeDashHtml(s)
    .replace(/\*\*([\s\S]+?)\*\*(?!\*)/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

interface HeroOptions {
  title: string
  eyebrow?: string
  headline?: string
  status?: 'green' | 'yellow' | 'red' | 'neutral'
  statusLabel?: string
}

function renderHero(o: HeroOptions): string {
  const eyebrow = o.eyebrow ? `<div class="hero__eyebrow">${escapeDashHtml(o.eyebrow)}</div>` : ''
  const status = o.status ?? 'neutral'
  const statusLabel = o.statusLabel ?? status.toUpperCase()
  const statusBadge =
    o.status || o.statusLabel
      ? `<span class="status-badge" data-status="${escapeDashHtml(status)}">${escapeDashHtml(statusLabel)}</span>`
      : ''
  const headline = o.headline ? `<p class="hero__headline">${renderInlineMd(o.headline)}</p>` : ''
  return `
<header class="hero" data-status="${escapeDashHtml(status)}">
  ${eyebrow}
  <h1 class="hero__title">${escapeDashHtml(o.title)}</h1>
  ${headline}
  ${statusBadge}
</header>`.trim()
}

function renderKpis(kpis: KpiCard[]): string {
  if (!kpis || kpis.length === 0) return ''
  const cards = kpis
    .map((kpi, idx) => {
      const delta = kpi.delta
        ? `<p class="kpi-card__delta" data-direction="${escapeDashHtml(
            kpi.deltaDirection ?? 'neutral'
          )}">${escapeDashHtml(kpi.delta)}</p>`
        : ''
      const sparkline =
        kpi.sparkline && kpi.sparkline.length > 1
          ? `<div class="kpi-card__sparkline-wrap"><canvas class="kpi-card__sparkline" id="sparkline-${idx}" data-spark="${escapeHtmlAttr(
              JSON.stringify(kpi.sparkline)
            )}"></canvas></div>`
          : ''
      const accent = kpi.accent ? ` data-accent="${escapeDashHtml(kpi.accent)}"` : ''
      return `
<div class="kpi-card"${accent}>
  <p class="kpi-card__label">${escapeDashHtml(kpi.label)}</p>
  <p class="kpi-card__value">${escapeDashHtml(kpi.value)}</p>
  ${delta}
  ${sparkline}
</div>`.trim()
    })
    .join('\n')
  return `<section class="kpi-grid">${cards}</section>`
}

function renderChartsGrid(charts: ChartSpec[], sectionTitle?: string, baseIdx = 0): string {
  if (!charts || charts.length === 0) return ''
  const cards = charts
    .map(
      (_, idx) => `
<div class="chart-card">
  ${charts[idx].title ? `<h3 class="chart-card__title">${escapeDashHtml(charts[idx].title!)}</h3>` : ''}
  <div class="chart-card__container">
    <canvas id="chart-${baseIdx + idx}"></canvas>
  </div>
</div>`
    )
    .join('\n')
  const heading = sectionTitle
    ? `<section class="section"><h2 class="section__title">${escapeDashHtml(sectionTitle)}</h2></section>`
    : ''
  return `${heading}<section class="chart-grid">${cards}</section>`
}

function renderChartsStacked(charts: ChartSpec[], sectionTitle?: string, baseIdx = 0): string {
  if (!charts || charts.length === 0) return ''
  const cards = charts
    .map(
      (_, idx) => `
<div class="chart-card chart-card--wide">
  ${charts[idx].title ? `<h3 class="chart-card__title">${escapeDashHtml(charts[idx].title!)}</h3>` : ''}
  <div class="chart-card__container chart-card__container--tall">
    <canvas id="chart-${baseIdx + idx}"></canvas>
  </div>
</div>`
    )
    .join('\n')
  const heading = sectionTitle
    ? `<section class="section"><h2 class="section__title">${escapeDashHtml(sectionTitle)}</h2></section>`
    : ''
  return `${heading}<section class="chart-stack">${cards}</section>`
}

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

function renderTableHtml(t: TableSpec): string {
  const colTypes = t.columnTypes ?? {}
  const headerHtml = t.headers.map(h => `<th>${escapeDashHtml(h)}</th>`).join('')
  const bodyHtml = (t.rows ?? [])
    .map(row => {
      const cells = (row ?? [])
        .map((cell, c) => {
          const colType = colTypes[c] ?? colTypes[t.headers[c]] ?? 'plain'
          if (colType === 'severity' || colType === 'priority' || colType === 'status') {
            const cls = dashSeverityClass(cell)
            const label = escapeDashHtml(cell ?? '')
            return cls
              ? `<td><span class="severity-badge ${cls}">${label}</span></td>`
              : `<td>${label}</td>`
          }
          return `<td>${renderInlineMd(String(cell ?? ''))}</td>`
        })
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('\n')

  const title = t.title
    ? `<section class="section"><h2 class="section__title">${escapeDashHtml(t.title)}</h2></section>`
    : ''

  return `${title}
<div class="data-table-wrap">
  <table class="data-table">
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table>
</div>`.trim()
}

function renderSectionHtml(s: SectionSpec): string {
  const title = s.title ? `<h2 class="section__title">${escapeDashHtml(s.title)}</h2>` : ''
  let body = ''
  if (s.type === 'narrative') {
    const paras = (Array.isArray(s.content) ? s.content : [s.content])
      .map(p => `<p>${renderInlineMd(p)}</p>`)
      .join('\n')
    body = `<div class="narrative">${paras}</div>`
  } else if (s.type === 'bullets') {
    const items = (Array.isArray(s.content) ? s.content : [s.content])
      .map(b => `<li>${renderInlineMd(b)}</li>`)
      .join('')
    body = `<ul class="bullets">${items}</ul>`
  } else if (s.type === 'callout') {
    const tone = s.tone ?? 'info'
    const text = Array.isArray(s.content) ? s.content.join('\n') : s.content
    body = `<div class="callout" data-tone="${escapeDashHtml(tone)}">${renderInlineMd(text)}</div>`
  } else if (s.type === 'code') {
    const lang = s.language
      ? `<div class="code-block__lang">${escapeDashHtml(s.language)}</div>`
      : ''
    const text = Array.isArray(s.content) ? s.content.join('\n') : s.content
    body = `<div class="code-block">${lang}<pre><code>${escapeDashHtml(text)}</code></pre></div>`
  }
  return `<section class="section">${title}${body}</section>`
}

function renderServiceHealthGrid(services: ServiceHealth[], title?: string): string {
  if (!services || services.length === 0) return ''
  const cards = services
    .map(s => {
      const delta = s.delta
        ? `<p class="kpi-card__delta" data-direction="${escapeDashHtml(
            s.deltaDirection ?? 'neutral'
          )}">${escapeDashHtml(s.delta)}</p>`
        : ''
      return `
<div class="health-card" data-status="${escapeDashHtml(s.status)}">
  <div class="health-card__head">
    <span class="health-card__dot"></span>
    <h3 class="health-card__name">${escapeDashHtml(s.name)}</h3>
  </div>
  <p class="health-card__status">${escapeDashHtml(s.status.toUpperCase())}</p>
  ${s.metric ? `<p class="health-card__metric">${escapeDashHtml(s.metric)}</p>` : ''}
  ${delta}
</div>`.trim()
    })
    .join('\n')
  const heading = title
    ? `<section class="section"><h2 class="section__title">${escapeDashHtml(title)}</h2></section>`
    : ''
  return `${heading}<section class="health-grid">${cards}</section>`
}

function renderIncidentsTimeline(items: IncidentItem[], title?: string): string {
  if (!items || items.length === 0) return ''
  const list = items
    .map(it => {
      const sev = it.severity ?? 'info'
      const resolved = it.resolvedAt
        ? `<span class="timeline-item__resolved">resolved ${escapeDashHtml(it.resolvedAt)}</span>`
        : `<span class="timeline-item__open">open</span>`
      const desc = it.description
        ? `<p class="timeline-item__desc">${renderInlineMd(it.description)}</p>`
        : ''
      return `
<li class="timeline-item" data-severity="${escapeDashHtml(sev)}">
  <div class="timeline-item__time">${escapeDashHtml(it.time)}</div>
  <div class="timeline-item__body">
    <div class="timeline-item__head">
      <span class="severity-badge severity-${escapeDashHtml(sev)}">${escapeDashHtml(sev.toUpperCase())}</span>
      <h4 class="timeline-item__title">${escapeDashHtml(it.title)}</h4>
      ${resolved}
    </div>
    ${desc}
  </div>
</li>`.trim()
    })
    .join('\n')
  const heading = title
    ? `<section class="section"><h2 class="section__title">${escapeDashHtml(title)}</h2></section>`
    : ''
  return `${heading}<ol class="timeline">${list}</ol>`
}

function renderDashboardFooter(meta: FooterMeta | undefined, branding: DashboardBranding): string {
  const date =
    meta?.date ??
    new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  const left = branding.companyName
    ? `<span class="dash-footer__brand">${escapeDashHtml(branding.companyName)}</span>`
    : ''
  const right = branding.footerText
    ? `<span>${escapeDashHtml(branding.footerText)} · ${escapeDashHtml(date)}</span>`
    : `<span>${escapeDashHtml(date)}</span>`
  return `<footer class="dash-footer">${left}${right}</footer>`
}

function buildChartScript(charts: ChartSpec[], theme: DashboardTheme): string {
  const normalized = charts.map(c => {
    const isHorizontalBar = c.type === 'horizontalBar'
    const isArea = c.type === 'area'
    const chartType = isHorizontalBar || c.type === 'bar' ? 'bar' : isArea ? 'line' : c.type
    const datasets = c.datasets.map((ds, i) => {
      const color = theme.chartPalette[i % theme.chartPalette.length]
      const isSlice = c.type === 'pie' || c.type === 'doughnut' || c.type === 'polarArea'
      const out: Record<string, unknown> = {
        label: ds.label ?? '',
        data: ds.data,
      }
      if (isSlice) {
        out.backgroundColor =
          ds.backgroundColor ??
          ds.data.map((_, j) => theme.chartPalette[j % theme.chartPalette.length])
      } else {
        out.borderColor = ds.borderColor ?? color
        out.backgroundColor =
          ds.backgroundColor ?? (chartType === 'line' || isArea ? `${color}33` : color)
        if (isArea && ds.fill === undefined) out.fill = true
      }
      return out
    })
    return {
      type: chartType,
      indexAxis: isHorizontalBar ? 'y' : 'x',
      data: { labels: c.labels ?? [], datasets },
      title: c.title,
      yAxisLabel: c.yAxisLabel,
      xAxisLabel: c.xAxisLabel,
    }
  })

  return `
const __charts = ${safeJsonForScript(normalized)};
const __cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const textColor = () => __cssVar('--text-muted') || '#475569';
const gridColor = () => __cssVar('--border') || '#e2e8f0';

function makeChart(idx, spec) {
  const ctx = document.getElementById('chart-' + idx);
  if (!ctx) return;
  const showAxes = spec.type === 'bar' || spec.type === 'line' || spec.type === 'scatter';
  new Chart(ctx, {
    type: spec.type,
    data: spec.data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 200,
      indexAxis: spec.indexAxis,
      plugins: {
        legend: { labels: { color: textColor() } },
      },
      scales: showAxes
        ? {
            x: {
              ticks: { color: textColor() },
              grid: { color: gridColor() },
              title: spec.xAxisLabel
                ? { display: true, text: spec.xAxisLabel, color: textColor() }
                : { display: false },
            },
            y: {
              ticks: { color: textColor() },
              grid: { color: gridColor() },
              title: spec.yAxisLabel
                ? { display: true, text: spec.yAxisLabel, color: textColor() }
                : { display: false },
            },
          }
        : undefined,
    },
  });
}

__charts.forEach((s, i) => makeChart(i, s));

document.querySelectorAll('canvas.kpi-card__sparkline[data-spark]').forEach(el => {
  const data = JSON.parse(el.getAttribute('data-spark') || '[]');
  if (!Array.isArray(data) || data.length < 2) return;
  new Chart(el, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i),
      datasets: [{
        data,
        borderColor: __cssVar('--accent') || '#3b82f6',
        backgroundColor: 'transparent',
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 200,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
      animation: false,
    },
  });
});
`.trim()
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
  const chartLib = o.chartJsSource ? `<script>${o.chartJsSource}</script>` : ''
  const chartInit = o.chartInit ? `<script>${o.chartInit}</script>` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeDashHtml(o.title)}</title>
${styleBlock}
</head>
<body>
<main class="dashboard">
${o.body}
</main>
${chartLib}
${chartInit}
</body>
</html>`
}

// ─── Chart.js bundle loader (cached) ────────────────────────────────

let cachedChartJsBundle: string | undefined
function loadChartJsBundle(): string {
  if (cachedChartJsBundle) return cachedChartJsBundle
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resolved = require.resolve('chart.js/dist/chart.umd.js')
    cachedChartJsBundle = fs.readFileSync(resolved, 'utf-8')
    return cachedChartJsBundle
  } catch {
    const candidates = [
      path.resolve(__dirname, '../../node_modules/chart.js/dist/chart.umd.js'),
      path.resolve(__dirname, '../../../node_modules/chart.js/dist/chart.umd.js'),
      path.resolve(process.cwd(), 'node_modules/chart.js/dist/chart.umd.js'),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        cachedChartJsBundle = fs.readFileSync(p, 'utf-8')
        return cachedChartJsBundle
      }
    }
    throw new Error(
      'Could not locate chart.js UMD bundle. Pass inlineChartJs:false if charts are not needed.'
    )
  }
}

// ─── Template orchestrators ─────────────────────────────────────────

interface ExecutiveBriefData {
  eyebrow?: string
  title: string
  headline?: string
  status?: 'green' | 'yellow' | 'red' | 'neutral'
  statusLabel?: string
  kpis?: KpiCard[]
  charts?: ChartSpec[]
  tables?: TableSpec[]
  sections?: SectionSpec[]
  meta?: FooterMeta
}

function renderExecutiveBrief(opts: {
  data: ExecutiveBriefData
  branding?: DashboardBranding
  theme: DashboardTheme
  chartJsSource?: string
  cssSource?: string
}): string {
  const { data, theme, chartJsSource, cssSource } = opts
  const branding = opts.branding ?? {}

  const body = [
    renderHero({
      title: data.title,
      eyebrow: data.eyebrow,
      headline: data.headline,
      status: data.status,
      statusLabel: data.statusLabel,
    }),
    renderKpis(data.kpis ?? []),
    renderChartsGrid(data.charts ?? [], 'Visual Trends'),
    (data.tables ?? []).map(renderTableHtml).join('\n'),
    (data.sections ?? []).map(renderSectionHtml).join('\n'),
    renderDashboardFooter(data.meta, branding),
  ].join('\n')

  const chartInit =
    chartJsSource && (data.charts?.length || data.kpis?.some(k => k.sparkline))
      ? buildChartScript(data.charts ?? [], theme)
      : undefined

  return htmlWrapper({
    title: data.title,
    cssSource,
    chartJsSource,
    chartInit,
    body,
  })
}

interface OperationsPulseData {
  eyebrow?: string
  title: string
  headline?: string
  status?: 'green' | 'yellow' | 'red' | 'neutral'
  statusLabel?: string
  services?: ServiceHealth[]
  kpis?: KpiCard[]
  incidents?: IncidentItem[]
  charts?: ChartSpec[]
  tables?: TableSpec[]
  sections?: SectionSpec[]
  meta?: FooterMeta
}

function renderOperationsPulse(opts: {
  data: OperationsPulseData
  branding?: DashboardBranding
  theme: DashboardTheme
  chartJsSource?: string
  cssSource?: string
}): string {
  const { data, theme, chartJsSource, cssSource } = opts
  const branding = opts.branding ?? {}

  const body = [
    renderHero({
      title: data.title,
      eyebrow: data.eyebrow,
      headline: data.headline,
      status: data.status,
      statusLabel: data.statusLabel,
    }),
    renderServiceHealthGrid(data.services ?? [], 'Service Health'),
    renderKpis(data.kpis ?? []),
    renderIncidentsTimeline(data.incidents ?? [], 'Incident Timeline'),
    renderChartsGrid(data.charts ?? [], 'Performance Trends'),
    (data.tables ?? []).map(renderTableHtml).join('\n'),
    (data.sections ?? []).map(renderSectionHtml).join('\n'),
    renderDashboardFooter(data.meta, branding),
  ].join('\n')

  const chartInit =
    chartJsSource && (data.charts?.length || data.kpis?.some(k => k.sparkline))
      ? buildChartScript(data.charts ?? [], theme)
      : undefined

  return htmlWrapper({
    title: data.title,
    cssSource,
    chartJsSource,
    chartInit,
    body,
  })
}

interface FinancialReviewData {
  eyebrow?: string
  title: string
  headline?: string
  period?: string
  status?: 'green' | 'yellow' | 'red' | 'neutral'
  statusLabel?: string
  kpis?: KpiCard[]
  heroChart?: ChartSpec
  charts?: ChartSpec[]
  tables?: TableSpec[]
  sections?: SectionSpec[]
  meta?: FooterMeta
}

function renderFinancialReview(opts: {
  data: FinancialReviewData
  branding?: DashboardBranding
  theme: DashboardTheme
  chartJsSource?: string
  cssSource?: string
}): string {
  const { data, theme, chartJsSource, cssSource } = opts
  const branding = opts.branding ?? {}

  const allCharts: ChartSpec[] = []
  if (data.heroChart) allCharts.push(data.heroChart)
  if (data.charts) allCharts.push(...data.charts)

  const heroChartHtml = data.heroChart ? renderChartsStacked([data.heroChart], undefined, 0) : ''
  const supportingChartsHtml =
    data.charts && data.charts.length > 0
      ? renderChartsGrid(
          data.charts,
          data.heroChart ? 'Breakdowns' : 'Visual Trends',
          data.heroChart ? 1 : 0
        )
      : ''

  const body = [
    renderHero({
      title: data.title,
      eyebrow: data.eyebrow ?? data.period,
      headline: data.headline,
      status: data.status,
      statusLabel: data.statusLabel,
    }),
    renderKpis(data.kpis ?? []),
    heroChartHtml,
    supportingChartsHtml,
    (data.tables ?? []).map(renderTableHtml).join('\n'),
    (data.sections ?? []).map(renderSectionHtml).join('\n'),
    renderDashboardFooter(data.meta, branding),
  ].join('\n')

  const chartInit =
    chartJsSource && (allCharts.length || data.kpis?.some(k => k.sparkline))
      ? buildChartScript(allCharts, theme)
      : undefined

  return htmlWrapper({
    title: data.title,
    cssSource,
    chartJsSource,
    chartInit,
    body,
  })
}

interface TechnicalReportData {
  eyebrow?: string
  title: string
  headline?: string
  status?: 'green' | 'yellow' | 'red' | 'neutral'
  statusLabel?: string
  kpis?: KpiCard[]
  sections?: SectionSpec[]
  tables?: TableSpec[]
  charts?: ChartSpec[]
  meta?: FooterMeta
}

function renderTechnicalReport(opts: {
  data: TechnicalReportData
  branding?: DashboardBranding
  theme: DashboardTheme
  chartJsSource?: string
  cssSource?: string
}): string {
  const { data, theme, chartJsSource, cssSource } = opts
  const branding = opts.branding ?? {}

  const body = [
    renderHero({
      title: data.title,
      eyebrow: data.eyebrow,
      headline: data.headline,
      status: data.status,
      statusLabel: data.statusLabel,
    }),
    renderKpis(data.kpis ?? []),
    (data.sections ?? []).map(renderSectionHtml).join('\n'),
    (data.tables ?? []).map(renderTableHtml).join('\n'),
    renderChartsGrid(data.charts ?? [], data.charts?.length ? 'Charts' : undefined),
    renderDashboardFooter(data.meta, branding),
  ].join('\n')

  const chartInit =
    chartJsSource && (data.charts?.length || data.kpis?.some(k => k.sparkline))
      ? buildChartScript(data.charts ?? [], theme)
      : undefined

  return htmlWrapper({
    title: data.title,
    cssSource,
    chartJsSource,
    chartInit,
    body,
  })
}

// ─── Public entry point ─────────────────────────────────────────────

type DashboardTemplateName =
  | 'executive-brief'
  | 'operations-pulse'
  | 'financial-review'
  | 'technical-report'
  | 'custom'

interface DashboardRenderOptions {
  template?: DashboardTemplateName
  data:
    | ExecutiveBriefData
    | OperationsPulseData
    | FinancialReviewData
    | TechnicalReportData
    | CustomDashboardData
  theme?: ThemeName
  defaultThemeMode?: 'light' | 'dark'
  branding?: DashboardBranding
  inlineChartJs?: boolean
}

function renderDashboard(opts: DashboardRenderOptions): string {
  const themeName: ThemeName = opts.theme ?? 'default'
  const theme = DASHBOARD_THEMES[themeName] ?? DASHBOARD_THEMES.default
  const cssSource = buildDashboardCss(theme, opts.defaultThemeMode ?? 'light')
  const inlineChartJs = opts.inlineChartJs ?? true
  const chartJsSource = inlineChartJs ? loadChartJsBundle() : undefined
  const template = opts.template ?? 'executive-brief'

  const common = {
    theme,
    cssSource,
    chartJsSource,
    branding: opts.branding,
  }

  switch (template) {
    case 'operations-pulse':
      return renderOperationsPulse({
        ...common,
        data: opts.data as OperationsPulseData,
      })
    case 'financial-review':
      return renderFinancialReview({
        ...common,
        data: opts.data as FinancialReviewData,
      })
    case 'technical-report':
      return renderTechnicalReport({
        ...common,
        data: opts.data as TechnicalReportData,
      })
    case 'custom':
      return renderCustomDashboard({
        ...common,
        data: opts.data as CustomDashboardData,
      })
    case 'executive-brief':
    default:
      return renderExecutiveBrief({
        ...common,
        data: opts.data as ExecutiveBriefData,
      })
  }
}

// ─── Custom template (composable blocks) ────────────────────────────
//
// Recipe-author composes an ordered list of typed blocks. Renderer
// dispatches each to the matching helper. Per-block failure is
// isolated — a malformed block becomes an inline callout with the
// error message; the rest of the document still renders.

type DashboardBlock =
  | ({ type: 'hero' } & HeroOptions)
  | { type: 'kpis'; items: KpiCard[] }
  | { type: 'chart'; spec: ChartSpec; title?: string }
  | { type: 'charts-grid'; items: ChartSpec[]; title?: string }
  | { type: 'table'; spec: TableSpec }
  | { type: 'narrative'; title?: string; content: string | string[] }
  | { type: 'bullets'; title?: string; items: string[] }
  | { type: 'code'; title?: string; language?: string; content: string }
  | { type: 'callout'; tone?: 'info' | 'success' | 'warning' | 'danger'; content: string }
  | { type: 'incidents'; items: IncidentItem[]; title?: string }
  | { type: 'service-health'; services: ServiceHealth[]; title?: string }
  | { type: 'divider' }
  | { type: 'spacer'; size?: 'sm' | 'md' | 'lg' }

interface CustomDashboardData {
  title: string
  blocks: DashboardBlock[]
  meta?: FooterMeta
}

function renderCustomDashboard(opts: {
  data: CustomDashboardData
  branding?: DashboardBranding
  theme: DashboardTheme
  chartJsSource?: string
  cssSource?: string
}): string {
  const { data, theme, chartJsSource, cssSource } = opts
  const branding = opts.branding ?? {}

  if (!Array.isArray(data.blocks) || data.blocks.length === 0) {
    throw new Error('custom template requires data.blocks[] (non-empty array)')
  }

  // Collect all charts across blocks so buildChartScript gets a flat list with
  // stable indices matching the canvas IDs we emit per block.
  const collectedCharts: ChartSpec[] = []
  let hasSparkline = false

  const blockHtml = data.blocks
    .map((b, idx) => {
      try {
        switch (b.type) {
          case 'hero':
            return renderHero({
              title: b.title,
              eyebrow: b.eyebrow,
              headline: b.headline,
              status: b.status,
              statusLabel: b.statusLabel,
            })
          case 'kpis': {
            if (b.items?.some(k => k.sparkline)) hasSparkline = true
            return renderKpis(b.items ?? [])
          }
          case 'chart': {
            const baseIdx = collectedCharts.length
            collectedCharts.push(b.spec)
            return renderChartsGrid(
              [{ ...b.spec, title: b.title ?? b.spec.title }],
              undefined,
              baseIdx
            )
          }
          case 'charts-grid': {
            const baseIdx = collectedCharts.length
            collectedCharts.push(...b.items)
            return renderChartsGrid(b.items, b.title, baseIdx)
          }
          case 'table':
            return renderTableHtml(b.spec)
          case 'narrative':
            return renderSectionHtml({
              type: 'narrative',
              title: b.title,
              content: b.content,
            })
          case 'bullets':
            return renderSectionHtml({
              type: 'bullets',
              title: b.title,
              content: b.items,
            })
          case 'code':
            return renderSectionHtml({
              type: 'code',
              title: b.title,
              language: b.language,
              content: b.content,
            })
          case 'callout':
            return renderSectionHtml({
              type: 'callout',
              tone: b.tone,
              content: b.content,
            })
          case 'incidents':
            return renderIncidentsTimeline(b.items ?? [], b.title)
          case 'service-health':
            return renderServiceHealthGrid(b.services ?? [], b.title)
          case 'divider':
            return '<hr class="dashboard-divider"/>'
          case 'spacer':
            return `<div class="dashboard-spacer dashboard-spacer--${b.size ?? 'md'}"></div>`
          default: {
            // AJV should catch unknown block types upstream. If one slips
            // through (schema drift), render it as a visible danger
            // callout so the failure isn't silent.
            const unknownType = (b as { type?: unknown }).type
            return renderSectionHtml({
              type: 'callout',
              tone: 'danger',
              title: `Block ${idx} skipped`,
              content: `Unknown block type: ${escapeDashHtml(String(unknownType))}`,
            })
          }
        }
      } catch (e) {
        // Failure aislado: bloque malo → callout de error, el resto se renderea.
        return renderSectionHtml({
          type: 'callout',
          tone: 'danger',
          title: `Block ${idx} failed`,
          content: e instanceof Error ? e.message : String(e),
        })
      }
    })
    .join('\n')

  const footerHtml = renderDashboardFooter(data.meta, branding)
  const fullBody = `${blockHtml}\n${footerHtml}`

  const chartInit =
    chartJsSource && (collectedCharts.length > 0 || hasSparkline)
      ? buildChartScript(collectedCharts, theme)
      : undefined

  return htmlWrapper({
    title: data.title,
    cssSource,
    chartJsSource,
    chartInit,
    body: fullBody,
  })
}

// ─── generate_dashboard tool definition ─────────────────────────────

const generateDashboardTool: InternalToolDefinition = {
  name: 'clerum__generate_dashboard',
  description:
    'Generate a standalone HTML dashboard. The output is a single ' +
    '.html file (Tailwind-style CSS + Chart.js inlined) that opens in any modern ' +
    'browser, works offline, prints cleanly, and is responsive. ' +
    'Templates: executive-brief (general), operations-pulse (engineering / SRE), ' +
    'financial-review (finance with hero chart), technical-report (long-form writeup ' +
    'with code blocks), custom (composable: pass data.blocks[] in any order). ' +
    'Themes: default | corporate | warm | alert.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'dashboard.html'). Extension .html added if missing.",
      },
      template: {
        type: 'string',
        enum: [
          'executive-brief',
          'operations-pulse',
          'financial-review',
          'technical-report',
          'custom',
        ],
        description:
          "Template name. Default 'executive-brief'. " +
          'operations-pulse adds service-health grid + incidents timeline. ' +
          'financial-review adds heroChart (single wide chart) + dense tables. ' +
          'technical-report puts narrative sections first and supports code-block sections. ' +
          "'custom' renders an ordered list of typed blocks from data.blocks[] " +
          '— use when none of the 4 fixed layouts fit.',
      },
      theme: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description:
          "Color theme. Default 'default' (neutral slate). Use 'corporate' (navy), 'warm' (warm amber), or 'alert' (rose) when explicitly appropriate.",
      },
      defaultThemeMode: {
        type: 'string',
        enum: ['light', 'dark'],
        description: "Initial theme mode. Default 'light'. The HTML respects prefers-color-scheme.",
      },
      inlineChartJs: {
        type: 'boolean',
        description:
          'When true (default), the Chart.js bundle (~210 KB) is inlined so the HTML works offline. ' +
          'Set to false to skip inlining (no charts will render in the output).',
      },
      branding: {
        type: 'object',
        properties: {
          companyName: { type: 'string' },
          footerText: { type: 'string' },
        },
      },
      data: {
        type: 'object',
        description:
          'Template payload. For the 4 fixed templates pass kpis/charts/tables/sections. ' +
          "For template='custom', pass blocks[] (an ordered list of typed blocks).",
        required: ['title'],
        properties: {
          eyebrow: { type: 'string' },
          title: { type: 'string' },
          headline: { type: 'string' },
          status: { type: 'string', enum: ['green', 'yellow', 'red', 'neutral'] },
          statusLabel: { type: 'string' },
          kpis: {
            type: 'array',
            items: {
              type: 'object',
              required: ['label', 'value'],
              properties: {
                label: { type: 'string' },
                value: { type: ['string', 'number'] },
                delta: { type: 'string' },
                deltaDirection: { type: 'string', enum: ['up', 'down', 'neutral'] },
                sparkline: { type: 'array', items: { type: 'number' } },
              },
            },
          },
          charts: {
            type: 'array',
            description:
              'Charts rendered with Chart.js. Same shape as `clerum__generate_chart` data.',
            items: {
              type: 'object',
              required: ['type', 'datasets'],
              properties: {
                type: {
                  type: 'string',
                  enum: [
                    'line',
                    'bar',
                    'horizontalBar',
                    'pie',
                    'doughnut',
                    'area',
                    'radar',
                    'polarArea',
                  ],
                },
                title: { type: 'string' },
                labels: { type: 'array', items: { type: 'string' } },
                datasets: { type: 'array' },
                yAxisLabel: { type: 'string' },
                xAxisLabel: { type: 'string' },
              },
            },
          },
          tables: {
            type: 'array',
            items: {
              type: 'object',
              required: ['headers', 'rows'],
              properties: {
                title: { type: 'string' },
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array' } },
                columnTypes: {
                  type: 'object',
                  description:
                    "Map column index or header name to 'severity' | 'priority' | 'plain' for badge styling.",
                },
              },
            },
          },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type', 'content'],
              properties: {
                title: { type: 'string' },
                type: { type: 'string', enum: ['narrative', 'bullets', 'callout'] },
                content: { type: ['string', 'array'] },
                tone: { type: 'string', enum: ['info', 'success', 'warning', 'danger'] },
              },
            },
          },
          blocks: {
            type: 'array',
            description:
              "Required when template='custom'. Ordered list of typed blocks. " +
              'Each block must declare its `type` from the closed enum below; ' +
              'the renderer dispatches to the matching helper. Per-block failure ' +
              'is isolated — a malformed block becomes an inline danger callout, ' +
              'the rest of the document still renders.',
            items: {
              type: 'object',
              required: ['type'],
              properties: {
                type: {
                  type: 'string',
                  enum: [
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
                  ],
                  description:
                    "Block type. 'hero' (banner with title/status), 'kpis' (KPI grid), " +
                    "'chart' (single chart), 'charts-grid' (multiple charts in a grid), " +
                    "'table' (data table), 'narrative' (markdown paragraphs), " +
                    "'bullets' (bullet list), 'code' (monospaced code block), " +
                    "'callout' (info/warning/danger box), 'incidents' (timeline), " +
                    "'service-health' (status grid), 'divider' (horizontal rule), " +
                    "'spacer' (vertical whitespace).",
                },
                // hero
                title: { type: 'string' },
                eyebrow: { type: 'string' },
                headline: { type: 'string' },
                status: { type: 'string', enum: ['green', 'yellow', 'red', 'neutral'] },
                statusLabel: { type: 'string' },
                // kpis / charts-grid / incidents / service-health / bullets
                items: { type: 'array' },
                services: { type: 'array' },
                // chart / table
                spec: { type: 'object' },
                // narrative / code / callout
                content: { type: ['string', 'array'] },
                language: { type: 'string' },
                tone: { type: 'string', enum: ['info', 'success', 'warning', 'danger'] },
                // spacer
                size: { type: 'string', enum: ['sm', 'md', 'lg'] },
              },
            },
          },
          meta: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              author: { type: 'string' },
              runId: { type: 'string' },
            },
          },
        },
      },
    },
    required: ['filename', 'data'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    try {
      const rawName = String(args.filename ?? 'dashboard.html')
      const filename = sanitizeFilename(ensureExtension(rawName, 'html'))
      const data = args.data as { title?: string } | undefined
      if (!data || typeof data !== 'object' || !data.title) {
        return { success: false, error: 'data.title is required' }
      }

      const opts: DashboardRenderOptions = {
        template: (args.template as DashboardTemplateName | undefined) ?? 'executive-brief',
        theme: (args.theme as ThemeName | undefined) ?? 'default',
        defaultThemeMode: (args.defaultThemeMode as 'light' | 'dark' | undefined) ?? 'light',
        inlineChartJs: args.inlineChartJs !== false,
        branding: args.branding as { companyName?: string; footerText?: string } | undefined,
        data: data as DashboardRenderOptions['data'],
      }
      const html = renderDashboard(opts)

      ensureDir(outputDir)
      enforceQuota(outputDir, Buffer.byteLength(html, 'utf-8'))
      const filePath = path.join(outputDir, filename)
      fs.writeFileSync(filePath, html, 'utf-8')

      return { success: true, artifact: buildArtifact(filePath, 'html') }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

// ════════════════════════════════════════════════════════════════════
// ─── PPTX GENERATION (clerum__generate_pptx) ────────────────────────
// ════════════════════════════════════════════════════════════════════
//
// Generates a .pptx via pptxgenjs (pure JS, no native deps).
// Coordinates are inches.
//
// Slide layouts: cover, section, title-bullets, title-chart, title-table,
// kpis, two-column, image, quote.
// Themes: default | corporate | warm | alert.
// Aspect ratios: wide (default, 13.33×7.5) | 16x9 | 16x10 | 4x3.
//
// Hardening: image paths must resolve under outputDir (validateOutputPath);
// filename is sanitized + extension-normalized; the .pptx buffer is
// quota-checked before disk write so a quota breach can't leave a partial
// file. pptxgenjs XML-escapes text fields, and boundText() caps each input
// so a runaway LLM cannot bloat the archive.

interface PptxPalette {
  // Canonical '#xxxxxx' lowercase. pptxgenjs expects bare uppercase
  // hex without '#'; use pptxHex() at usage sites.
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

const PPTX_PALETTES: Record<string, PptxPalette> = {
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

/** pptxgenjs accepts bare uppercase hex (no `#`). */
function pptxHex(c: string): string {
  return c.startsWith('#') ? c.slice(1).toUpperCase() : c.toUpperCase()
}

interface PptxDimensions {
  width: number
  height: number
}

const PPTX_LAYOUTS: Record<string, { name: string; dims: PptxDimensions }> = {
  wide: { name: 'LAYOUT_WIDE', dims: { width: 13.333, height: 7.5 } },
  '16x9': { name: 'LAYOUT_16x9', dims: { width: 10, height: 5.625 } },
  '16x10': { name: 'LAYOUT_16x10', dims: { width: 10, height: 6.25 } },
  '4x3': { name: 'LAYOUT_4x3', dims: { width: 10, height: 7.5 } },
}

const SLIDE_LAYOUT_TYPES = [
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

type SlideLayoutType = (typeof SLIDE_LAYOUT_TYPES)[number]

const PPTX_CHART_TYPES = ['line', 'bar', 'horizontalBar', 'pie', 'doughnut', 'area'] as const
type PptxChartType = (typeof PPTX_CHART_TYPES)[number]

interface PptxBranding {
  companyName?: string
  logoPath?: string
  footerText?: string
}

interface PptxImageRef {
  path: string
  caption?: string
  /** Optional explicit dimensions (inches). Default: fit to body area. */
  width?: number
  height?: number
}

interface PptxChartSpec {
  /** Either `path` (embedded PNG) OR `type`+`data` for a native pptx chart. */
  path?: string
  type?: PptxChartType
  title?: string
  labels?: string[]
  datasets?: Array<{ label: string; data: number[] }>
  caption?: string
}

interface PptxTableSpec {
  headers: string[]
  rows: (string | number | null)[][]
}

interface PptxKpiCard {
  label: string
  value: string | number
  delta?: string
  deltaDirection?: 'up' | 'down' | 'neutral'
}

interface PptxColumnContent {
  type: 'bullets' | 'narrative' | 'image'
  bullets?: string[]
  text?: string
  image?: PptxImageRef
}

interface PptxSlideSpec {
  layout: SlideLayoutType
  title?: string
  eyebrow?: string
  subtitle?: string
  /** Cover-only: optional status band color. */
  status?: 'green' | 'yellow' | 'red'
  bullets?: string[]
  table?: PptxTableSpec
  kpis?: PptxKpiCard[]
  chart?: PptxChartSpec
  image?: PptxImageRef
  quote?: { text: string; attribution?: string }
  columns?: { left: PptxColumnContent; right: PptxColumnContent }
  /** Speaker notes attached to the slide. */
  notes?: string
}

/**
 * Bound a free-form text field to a sane character count so a runaway
 * LLM cannot emit a megabyte of text and bloat the .pptx.
 */
function boundText(s: unknown, max = 4000): string {
  return String(s ?? '').slice(0, max)
}

/**
 * Resolve and validate an image path against outputDir, then read it.
 * Returns null if the path is missing, traversal-unsafe, or the file
 * doesn't exist (caller skips the image silently — same pattern as PDF).
 */
function loadSafeImage(p: string | undefined, outputDir: string): string | null {
  if (!p) return null
  try {
    const safe = validateOutputPath(p, outputDir)
    if (!fs.existsSync(safe)) return null
    return safe
  } catch {
    return null
  }
}

/**
 * Map our chart type names (matching clerum__generate_chart) to
 * pptxgenjs's internal chart-type strings.
 */
function pptxChartTypeFromName(t: PptxChartType, pptx: typeof PptxGenJS): string {
  const c = pptx.charts ?? {}
  switch (t) {
    case 'line':
      return c.LINE ?? 'line'
    case 'area':
      return c.AREA ?? 'area'
    case 'pie':
      return c.PIE ?? 'pie'
    case 'doughnut':
      return c.DOUGHNUT ?? 'doughnut'
    case 'horizontalBar':
    case 'bar':
    default:
      return c.BAR ?? 'bar'
  }
}

/**
 * Compute a body region (inches) given slide dimensions and reserved
 * margins for title/footer. All slide-render helpers anchor to this.
 */
function pptxBodyRegion(dims: PptxDimensions): {
  marginX: number
  titleY: number
  titleH: number
  bodyX: number
  bodyY: number
  bodyW: number
  bodyH: number
  footerY: number
} {
  const marginX = dims.width <= 10 ? 0.4 : 0.5
  const titleY = 0.4
  const titleH = 0.7
  const bodyX = marginX
  const bodyY = 1.3
  const bodyW = dims.width - marginX * 2
  const footerY = dims.height - 0.45
  const bodyH = footerY - bodyY - 0.2
  return { marginX, titleY, titleH, bodyX, bodyY, bodyW, bodyH, footerY }
}

/** Add the standard footer (company / footerText / page number) to every slide. */
function addPptxFooter(
  slide: Record<string, unknown> & { addText: (...args: unknown[]) => void },
  region: ReturnType<typeof pptxBodyRegion>,
  dims: PptxDimensions,
  branding: PptxBranding,
  palette: PptxPalette,
  slideNumber: number,
  totalSlides: number
): void {
  const muted = pptxHex(palette.muted)
  const leftText = [branding.companyName, branding.footerText].filter(Boolean).join(' · ')
  if (leftText) {
    slide.addText(boundText(leftText, 200), {
      x: region.marginX,
      y: region.footerY,
      w: dims.width / 2,
      h: 0.3,
      fontSize: 9,
      color: muted,
      align: 'left',
    })
  }
  slide.addText(`${slideNumber} / ${totalSlides}`, {
    x: dims.width - region.marginX - 1.0,
    y: region.footerY,
    w: 1.0,
    h: 0.3,
    fontSize: 9,
    color: muted,
    align: 'right',
  })
}

/** Convert palette delta-direction to a small visible glyph + color. */
function deltaSpec(
  direction: PptxKpiCard['deltaDirection'],
  palette: PptxPalette
): {
  glyph: string
  color: string
} {
  if (direction === 'up') return { glyph: '▲ ', color: pptxHex(palette.statusGreen) }
  if (direction === 'down') return { glyph: '▼ ', color: pptxHex(palette.statusRed) }
  return { glyph: '— ', color: pptxHex(palette.muted) }
}

// ─── Presentation templates ─────────────────────────────────────────
//
// 4 fixed templates + custom. The caller passes a typed `data` object;
// the builder expands it into a slides[] array which is then rendered
// by the same per-slide pipeline used in custom mode.

type PptxTemplateName =
  | 'executive-brief'
  | 'quarterly-review'
  | 'incident-review'
  | 'pitch-deck'
  | 'custom'

interface PptxExecutiveBriefData {
  title: string
  subtitle?: string
  status?: 'green' | 'yellow' | 'red'
  kpis?: PptxKpiCard[]
  charts?: PptxChartSpec[]
  takeaways?: string[]
  nextSteps?: string[]
}

interface PptxQuarterlyReviewData {
  title: string
  period: string
  status?: 'green' | 'yellow' | 'red'
  highlights?: string[]
  kpis?: PptxKpiCard[]
  revenueChart?: PptxChartSpec
  breakdownChart?: PptxChartSpec
  metricsTable?: PptxTableSpec
  outlook?: string[]
}

interface PptxIncidentReviewData {
  title: string
  date: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  summary: string
  timelineTable?: PptxTableSpec
  impact?: string[]
  rootCause?: string
  remediation?: string[]
  lessons?: string[]
}

interface PptxPitchDeckData {
  company: string
  tagline: string
  problem: string
  solution: string
  marketSize?: { value: string; description: string }
  tractionChart?: PptxChartSpec
  team?: PptxKpiCard[]
  ask?: { amount: string; useOfFunds: string[] }
}

/**
 * Convert a `severity` keyword to a `status` color used by cover/section
 * slides. Keeps the cover band visually consistent across templates.
 */
function severityToStatus(s: PptxIncidentReviewData['severity']): 'green' | 'yellow' | 'red' {
  if (s === 'critical' || s === 'high') return 'red'
  if (s === 'medium') return 'yellow'
  return 'green'
}

function buildExecutiveBrief(data: PptxExecutiveBriefData): PptxSlideSpec[] {
  const slides: PptxSlideSpec[] = []
  slides.push({
    layout: 'cover',
    title: data.title,
    subtitle: data.subtitle,
    status: data.status,
  })
  if (data.kpis && data.kpis.length > 0) {
    slides.push({ layout: 'kpis', title: 'Key Metrics', kpis: data.kpis.slice(0, 8) })
  }
  for (const c of data.charts ?? []) {
    slides.push({ layout: 'title-chart', title: c.title ?? 'Chart', chart: c })
  }
  if (data.takeaways && data.takeaways.length > 0) {
    slides.push({
      layout: 'title-bullets',
      title: 'Key Takeaways',
      bullets: data.takeaways,
    })
  }
  if (data.nextSteps && data.nextSteps.length > 0) {
    slides.push({
      layout: 'title-bullets',
      title: 'Next Steps',
      bullets: data.nextSteps,
    })
  }
  return slides
}

function buildQuarterlyReview(data: PptxQuarterlyReviewData): PptxSlideSpec[] {
  const slides: PptxSlideSpec[] = []
  slides.push({
    layout: 'cover',
    title: data.title,
    subtitle: data.period,
    status: data.status,
  })
  if (data.highlights && data.highlights.length > 0) {
    slides.push({
      layout: 'title-bullets',
      title: `${data.period} Highlights`,
      bullets: data.highlights,
    })
  }
  if (data.kpis && data.kpis.length > 0) {
    slides.push({ layout: 'kpis', title: 'Quarterly KPIs', kpis: data.kpis.slice(0, 8) })
  }
  if (data.revenueChart) {
    slides.push({
      layout: 'title-chart',
      title: data.revenueChart.title ?? 'Revenue Trend',
      chart: data.revenueChart,
    })
  }
  if (data.breakdownChart) {
    slides.push({
      layout: 'title-chart',
      title: data.breakdownChart.title ?? 'Revenue Breakdown',
      chart: data.breakdownChart,
    })
  }
  if (data.metricsTable) {
    slides.push({
      layout: 'title-table',
      title: 'Metrics Snapshot',
      table: data.metricsTable,
    })
  }
  slides.push({ layout: 'section', eyebrow: 'Looking ahead', title: 'Outlook' })
  if (data.outlook && data.outlook.length > 0) {
    slides.push({
      layout: 'title-bullets',
      title: 'Next Quarter Priorities',
      bullets: data.outlook,
    })
  }
  return slides
}

function buildIncidentReview(data: PptxIncidentReviewData): PptxSlideSpec[] {
  const slides: PptxSlideSpec[] = []
  slides.push({
    layout: 'cover',
    title: data.title,
    subtitle: `${data.severity.toUpperCase()} · ${data.date}`,
    status: severityToStatus(data.severity),
  })
  slides.push({
    layout: 'title-bullets',
    title: 'Summary',
    bullets: [data.summary],
  })
  if (data.timelineTable) {
    slides.push({
      layout: 'title-table',
      title: 'Timeline',
      table: data.timelineTable,
    })
  }
  if (data.impact && data.impact.length > 0) {
    slides.push({
      layout: 'title-bullets',
      title: 'Impact',
      bullets: data.impact,
    })
  }
  if (data.rootCause) {
    slides.push({
      layout: 'title-bullets',
      title: 'Root Cause',
      bullets: [data.rootCause],
    })
  }
  if (data.remediation && data.remediation.length > 0) {
    slides.push({
      layout: 'title-bullets',
      title: 'Remediation',
      bullets: data.remediation,
    })
  }
  if (data.lessons && data.lessons.length > 0) {
    slides.push({
      layout: 'title-bullets',
      title: 'Lessons Learned',
      bullets: data.lessons,
    })
  }
  return slides
}

function buildPitchDeck(data: PptxPitchDeckData): PptxSlideSpec[] {
  const slides: PptxSlideSpec[] = []
  slides.push({
    layout: 'cover',
    title: data.company,
    subtitle: data.tagline,
  })
  slides.push({
    layout: 'section',
    eyebrow: 'The pain',
    title: 'Problem',
    subtitle: data.problem,
  })
  slides.push({
    layout: 'section',
    eyebrow: 'Our approach',
    title: 'Solution',
    subtitle: data.solution,
  })
  if (data.marketSize) {
    slides.push({
      layout: 'kpis',
      title: 'Market Size',
      kpis: [{ label: 'TAM', value: data.marketSize.value, delta: data.marketSize.description }],
    })
  }
  if (data.tractionChart) {
    slides.push({
      layout: 'title-chart',
      title: 'Traction',
      chart: data.tractionChart,
    })
  }
  if (data.team && data.team.length > 0) {
    slides.push({ layout: 'kpis', title: 'Team', kpis: data.team.slice(0, 8) })
  }
  if (data.ask) {
    slides.push({
      layout: 'title-bullets',
      title: `The Ask · ${data.ask.amount}`,
      bullets: data.ask.useOfFunds,
    })
  }
  return slides
}

const generatePptxTool: InternalToolDefinition = {
  name: 'clerum__generate_pptx',
  description:
    'Generate a styled PowerPoint (.pptx) deck. Two ways to drive it: ' +
    '(1) pass `template` ∈ {executive-brief, quarterly-review, incident-review, pitch-deck} ' +
    'with a typed `data` object — the tool auto-builds the slide sequence; ' +
    "(2) leave `template` as 'custom' (default) and pass `slides[]` directly with explicit " +
    'layouts: cover, section, title-bullets, title-chart, title-table, kpis, two-column, image, quote. ' +
    'Themes: default | corporate | warm | alert. Charts may be embedded PNGs (use ' +
    'clerum__generate_chart first) or native editable pptx charts. Branding (companyName, ' +
    'logoPath, footerText) appears on every slide. Speaker notes via per-slide `notes`.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'deck.pptx'). Extension .pptx added if missing.",
      },
      title: {
        type: 'string',
        description: 'Document title (PowerPoint metadata).',
      },
      subject: { type: 'string', description: 'Subject (PowerPoint metadata).' },
      author: { type: 'string', description: 'Author (PowerPoint metadata).' },
      template: {
        type: 'string',
        enum: ['executive-brief', 'quarterly-review', 'incident-review', 'pitch-deck', 'custom'],
        description:
          "Preset deck shape. 'executive-brief' (cover + KPIs + charts + takeaways + next steps). " +
          "'quarterly-review' (cover + highlights + KPIs + revenue chart + breakdown + table + outlook). " +
          "'incident-review' (cover + summary + timeline + impact + RCA + remediation + lessons). " +
          "'pitch-deck' (cover + problem + solution + market + traction + team + ask). " +
          "'custom' (default): pass `slides[]` directly.",
      },
      data: {
        type: 'object',
        description:
          'Template payload (required when `template` is not "custom" or absent). Shape varies ' +
          'by template — see the template description.',
      },
      palette: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description: "Color palette. Default 'default'.",
      },
      aspectRatio: {
        type: 'string',
        enum: ['wide', '16x9', '16x10', '4x3'],
        description: "Slide aspect ratio. Default 'wide' (13.33×7.5 inches).",
      },
      branding: {
        type: 'object',
        description: 'Branding shown in the footer of every slide.',
        properties: {
          companyName: { type: 'string' },
          logoPath: {
            type: 'string',
            description:
              'Absolute path to a PNG/JPG logo (under outputDir for path-traversal safety).',
          },
          footerText: { type: 'string' },
        },
      },
      slides: {
        type: 'array',
        minItems: 1,
        description: 'Ordered list of slides to render.',
        items: {
          type: 'object',
          required: ['layout'],
          properties: {
            layout: { type: 'string', enum: [...SLIDE_LAYOUT_TYPES] },
            title: { type: 'string' },
            eyebrow: { type: 'string' },
            subtitle: { type: 'string' },
            status: { type: 'string', enum: ['green', 'yellow', 'red'] },
            bullets: { type: 'array', items: { type: 'string' } },
            table: {
              type: 'object',
              required: ['headers', 'rows'],
              properties: {
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array' } },
              },
            },
            kpis: {
              type: 'array',
              items: {
                type: 'object',
                required: ['label', 'value'],
                properties: {
                  label: { type: 'string' },
                  value: { type: ['string', 'number'] },
                  delta: { type: 'string' },
                  deltaDirection: { type: 'string', enum: ['up', 'down', 'neutral'] },
                },
              },
            },
            chart: {
              type: 'object',
              description:
                'Either { path } for an embedded PNG, or { type, labels, datasets } for a native pptx chart.',
              properties: {
                path: { type: 'string' },
                type: { type: 'string', enum: [...PPTX_CHART_TYPES] },
                title: { type: 'string' },
                labels: { type: 'array', items: { type: 'string' } },
                datasets: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['label', 'data'],
                    properties: {
                      label: { type: 'string' },
                      data: { type: 'array', items: { type: 'number' } },
                    },
                  },
                },
                caption: { type: 'string' },
              },
            },
            image: {
              type: 'object',
              required: ['path'],
              properties: {
                path: { type: 'string' },
                caption: { type: 'string' },
                width: { type: 'number' },
                height: { type: 'number' },
              },
            },
            quote: {
              type: 'object',
              required: ['text'],
              properties: {
                text: { type: 'string' },
                attribution: { type: 'string' },
              },
            },
            columns: {
              type: 'object',
              required: ['left', 'right'],
              properties: {
                left: {
                  type: 'object',
                  required: ['type'],
                  properties: {
                    type: { type: 'string', enum: ['bullets', 'narrative', 'image'] },
                    bullets: { type: 'array', items: { type: 'string' } },
                    text: { type: 'string' },
                    image: {
                      type: 'object',
                      required: ['path'],
                      properties: {
                        path: { type: 'string' },
                        caption: { type: 'string' },
                      },
                    },
                  },
                },
                right: {
                  type: 'object',
                  required: ['type'],
                  properties: {
                    type: { type: 'string', enum: ['bullets', 'narrative', 'image'] },
                    bullets: { type: 'array', items: { type: 'string' } },
                    text: { type: 'string' },
                    image: {
                      type: 'object',
                      required: ['path'],
                      properties: {
                        path: { type: 'string' },
                        caption: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
            notes: { type: 'string', description: 'Speaker notes attached to this slide.' },
          },
        },
      },
    },
    required: ['filename'],
  },
  async execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    try {
      const rawName = String(args.filename ?? 'deck.pptx')
      const filename = sanitizeFilename(ensureExtension(rawName, 'pptx'))
      const paletteName = String(args.palette ?? 'default')
      const palette = PPTX_PALETTES[paletteName] ?? PPTX_PALETTES.default
      const aspectRatio = String(args.aspectRatio ?? 'wide')
      const layoutDef = PPTX_LAYOUTS[aspectRatio] ?? PPTX_LAYOUTS.wide
      const branding = (args.branding ?? {}) as PptxBranding

      // Resolve slides: either from a fixed template or from the caller's
      // explicit `slides[]` array (custom mode = default).
      const template = (args.template as PptxTemplateName | undefined) ?? 'custom'
      let slides: PptxSlideSpec[] | undefined
      if (template === 'custom') {
        slides = args.slides as PptxSlideSpec[] | undefined
      } else {
        const data = args.data as Record<string, unknown> | undefined
        if (!data) {
          return {
            success: false,
            error: `template "${template}" requires a \`data\` object`,
          }
        }
        switch (template) {
          case 'executive-brief':
            slides = buildExecutiveBrief(data as unknown as PptxExecutiveBriefData)
            break
          case 'quarterly-review':
            slides = buildQuarterlyReview(data as unknown as PptxQuarterlyReviewData)
            break
          case 'incident-review':
            slides = buildIncidentReview(data as unknown as PptxIncidentReviewData)
            break
          case 'pitch-deck':
            slides = buildPitchDeck(data as unknown as PptxPitchDeckData)
            break
          default: {
            const exhaustive: never = template
            return { success: false, error: `unknown template: ${exhaustive as string}` }
          }
        }
      }

      if (!Array.isArray(slides) || slides.length === 0) {
        return {
          success: false,
          error:
            template === 'custom'
              ? 'slides must be a non-empty array (or use a non-custom template with `data`)'
              : `template "${template}" produced no slides — check that \`data\` has the required fields`,
        }
      }

      const pptx = new PptxGenJS()
      pptx.layout = layoutDef.name
      const dims = layoutDef.dims
      const region = pptxBodyRegion(dims)
      const total = slides.length

      // Document metadata.
      // Always assign every metadata field (even when empty). The pptxgenjs
      // library otherwise fills `dc:subject` / `dc:creator` with its own
      // default strings, which would surface as an unintentional brand mark
      // in the deliverable.
      pptx.title = boundText(args.title ?? '', 200)
      pptx.subject = boundText(args.subject ?? '', 200)
      pptx.author = boundText(args.author ?? '', 200)
      pptx.company = boundText(branding.companyName ?? '', 200)

      const safeLogoPath = loadSafeImage(branding.logoPath, outputDir)

      slides.forEach((spec, idx) => {
        const slide = pptx.addSlide()
        slide.background = { color: pptxHex(palette.background) }
        renderPptxSlide(slide, spec, {
          dims,
          region,
          palette,
          branding,
          safeLogoPath,
          outputDir,
          pptx,
        })
        if (spec.notes) {
          slide.addNotes(boundText(spec.notes, 8000))
        }
        // Footer on every slide except the cover (which has its own date).
        if (spec.layout !== 'cover') {
          addPptxFooter(slide, region, dims, branding, palette, idx + 1, total)
        }
      })

      // Buffer first, quota check, then write — atomic, no partial files.
      const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
      ensureDir(outputDir)
      enforceQuota(outputDir, buffer.byteLength)
      const filePath = path.join(outputDir, filename)
      fs.writeFileSync(filePath, buffer)

      return { success: true, artifact: buildArtifact(filePath, 'pptx') }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

interface RenderCtx {
  dims: PptxDimensions
  region: ReturnType<typeof pptxBodyRegion>
  palette: PptxPalette
  branding: PptxBranding
  safeLogoPath: string | null
  outputDir: string
  pptx: typeof PptxGenJS
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderPptxSlide(slide: any, spec: PptxSlideSpec, ctx: RenderCtx): void {
  switch (spec.layout) {
    case 'cover':
      return renderCoverSlide(slide, spec, ctx)
    case 'section':
      return renderSectionSlide(slide, spec, ctx)
    case 'title-bullets':
      return renderBulletsSlide(slide, spec, ctx)
    case 'title-chart':
      return renderChartSlide(slide, spec, ctx)
    case 'title-table':
      return renderTableSlide(slide, spec, ctx)
    case 'kpis':
      return renderKpisSlide(slide, spec, ctx)
    case 'two-column':
      return renderTwoColumnSlide(slide, spec, ctx)
    case 'image':
      return renderImageSlide(slide, spec, ctx)
    case 'quote':
      return renderQuoteSlide(slide, spec, ctx)
    default: {
      // AJV's enum should reject this earlier; the fallback only fires
      // if a recipe author bypasses validation or the schema drifts.
      const exhaustive: never = spec.layout
      void exhaustive
      slide.addText(`Unknown slide layout: ${(spec as { layout?: string }).layout ?? 'unknown'}`, {
        x: 1,
        y: 1,
        w: ctx.dims.width - 2,
        h: 1,
        fontSize: 18,
        color: pptxHex(ctx.palette.statusRed),
      })
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderCoverSlide(slide: any, spec: PptxSlideSpec, ctx: RenderCtx): void {
  const { dims, palette } = ctx
  // Status band at top.
  if (spec.status) {
    const bandColor =
      spec.status === 'green'
        ? palette.statusGreen
        : spec.status === 'yellow'
          ? palette.statusYellow
          : palette.statusRed
    slide.addShape(ctx.pptx.shapes?.RECTANGLE ?? 'rect', {
      x: 0,
      y: 0,
      w: dims.width,
      h: 0.18,
      fill: { color: pptxHex(bandColor) },
      line: { color: pptxHex(bandColor) },
    })
  }
  // Logo top-left.
  if (ctx.safeLogoPath) {
    slide.addImage({
      path: ctx.safeLogoPath,
      x: 0.5,
      y: 0.5,
      w: 1.5,
      h: 0.5,
      sizing: { type: 'contain', w: 1.5, h: 0.5 },
      altText: '',
    })
  }
  // Title.
  slide.addText(boundText(spec.title ?? '', 200), {
    x: 0.5,
    y: dims.height * 0.35,
    w: dims.width - 1,
    h: 1.5,
    fontSize: dims.width > 12 ? 44 : 36,
    bold: true,
    color: pptxHex(palette.primary),
    fontFace: 'Helvetica',
  })
  // Subtitle.
  if (spec.subtitle) {
    slide.addText(boundText(spec.subtitle, 400), {
      x: 0.5,
      y: dims.height * 0.55,
      w: dims.width - 1,
      h: 1,
      fontSize: dims.width > 12 ? 20 : 16,
      italic: true,
      color: pptxHex(palette.muted),
      fontFace: 'Helvetica',
    })
  }
  // Date.
  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  slide.addText(dateStr, {
    x: 0.5,
    y: dims.height - 0.7,
    w: dims.width - 1,
    h: 0.3,
    fontSize: 11,
    color: pptxHex(palette.muted),
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderSectionSlide(slide: any, spec: PptxSlideSpec, ctx: RenderCtx): void {
  const { dims, palette } = ctx
  // Surface fill behind the title to differentiate section slides.
  slide.addShape(ctx.pptx.shapes?.RECTANGLE ?? 'rect', {
    x: 0,
    y: 0,
    w: dims.width,
    h: dims.height,
    fill: { color: pptxHex(palette.surface) },
    line: { color: pptxHex(palette.surface) },
  })
  if (spec.eyebrow) {
    slide.addText(boundText(spec.eyebrow, 100).toUpperCase(), {
      x: 0.5,
      y: dims.height * 0.4,
      w: dims.width - 1,
      h: 0.5,
      fontSize: 14,
      bold: true,
      color: pptxHex(palette.accent),
      charSpacing: 4,
    })
  }
  slide.addText(boundText(spec.title ?? '', 200), {
    x: 0.5,
    y: dims.height * 0.45,
    w: dims.width - 1,
    h: 1.5,
    fontSize: dims.width > 12 ? 48 : 40,
    bold: true,
    color: pptxHex(palette.primary),
  })
  if (spec.subtitle) {
    slide.addText(boundText(spec.subtitle, 400), {
      x: 0.5,
      y: dims.height * 0.65,
      w: dims.width - 1,
      h: 0.7,
      fontSize: 18,
      italic: true,
      color: pptxHex(palette.muted),
    })
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addSlideTitle(slide: any, title: string, ctx: RenderCtx): void {
  if (!title) return
  slide.addText(boundText(title, 200), {
    x: ctx.region.marginX,
    y: ctx.region.titleY,
    w: ctx.dims.width - ctx.region.marginX * 2,
    h: ctx.region.titleH,
    fontSize: ctx.dims.width > 12 ? 28 : 22,
    bold: true,
    color: pptxHex(ctx.palette.primary),
  })
  // Accent underline under the title.
  slide.addShape(ctx.pptx.shapes?.RECTANGLE ?? 'rect', {
    x: ctx.region.marginX,
    y: ctx.region.titleY + ctx.region.titleH + 0.05,
    w: 1.0,
    h: 0.04,
    fill: { color: pptxHex(ctx.palette.accent) },
    line: { color: pptxHex(ctx.palette.accent) },
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderBulletsSlide(slide: any, spec: PptxSlideSpec, ctx: RenderCtx): void {
  addSlideTitle(slide, spec.title ?? '', ctx)
  const bullets = (spec.bullets ?? []).map(b => ({
    text: boundText(b, 1000),
    options: { bullet: { code: '25CF' } },
  }))
  if (bullets.length === 0) return
  slide.addText(bullets, {
    x: ctx.region.bodyX,
    y: ctx.region.bodyY,
    w: ctx.region.bodyW,
    h: ctx.region.bodyH,
    fontSize: ctx.dims.width > 12 ? 18 : 14,
    color: pptxHex(ctx.palette.text),
    paraSpaceAfter: 8,
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderChartSlide(slide: any, spec: PptxSlideSpec, ctx: RenderCtx): void {
  addSlideTitle(slide, spec.title ?? '', ctx)
  const chart = spec.chart
  if (!chart) return

  const captionH = chart.caption ? 0.4 : 0
  const chartArea = {
    x: ctx.region.bodyX,
    y: ctx.region.bodyY,
    w: ctx.region.bodyW,
    h: ctx.region.bodyH - captionH,
  }

  // Path takes precedence over native chart spec.
  if (chart.path) {
    const safe = loadSafeImage(chart.path, ctx.outputDir)
    if (safe) {
      slide.addImage({
        path: safe,
        ...chartArea,
        sizing: { type: 'contain', w: chartArea.w, h: chartArea.h },
        altText: chart.caption ?? '',
      })
    }
  } else if (chart.type && Array.isArray(chart.datasets)) {
    const datasets = chart.datasets
      .filter(d => Array.isArray(d.data))
      .map(d => ({
        name: boundText(d.label ?? '', 100),
        labels: chart.labels?.map(l => boundText(l, 80)) ?? [],
        values: d.data,
      }))
    if (datasets.length === 0) return
    const chartType = pptxChartTypeFromName(chart.type, ctx.pptx)
    slide.addChart(chartType, datasets, {
      ...chartArea,
      barDir: chart.type === 'horizontalBar' ? 'bar' : 'col',
      chartColors: [
        pptxHex(ctx.palette.primary),
        pptxHex(ctx.palette.accent),
        pptxHex(ctx.palette.statusGreen),
        pptxHex(ctx.palette.statusYellow),
        pptxHex(ctx.palette.statusRed),
        pptxHex(ctx.palette.muted),
      ],
      showTitle: Boolean(chart.title),
      title: boundText(chart.title ?? '', 200),
      titleColor: pptxHex(ctx.palette.text),
      showLegend: datasets.length > 1,
      legendPos: 'b',
      legendColor: pptxHex(ctx.palette.text),
      catAxisLabelColor: pptxHex(ctx.palette.muted),
      valAxisLabelColor: pptxHex(ctx.palette.muted),
    })
  }

  if (chart.caption) {
    slide.addText(boundText(chart.caption, 400), {
      x: ctx.region.bodyX,
      y: ctx.region.bodyY + ctx.region.bodyH - captionH,
      w: ctx.region.bodyW,
      h: captionH,
      fontSize: 10,
      italic: true,
      color: pptxHex(ctx.palette.muted),
      align: 'center',
    })
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderTableSlide(slide: any, spec: PptxSlideSpec, ctx: RenderCtx): void {
  addSlideTitle(slide, spec.title ?? '', ctx)
  const t = spec.table
  if (!t || !Array.isArray(t.headers) || !Array.isArray(t.rows)) return

  const headers = t.headers.map(h => boundText(h, 200))
  const rows = t.rows.map(r => normalizeRowLength(r, headers.length))

  const tableData = [
    headers.map(h => ({
      text: h,
      options: {
        bold: true,
        color: 'FFFFFF',
        fill: { color: pptxHex(ctx.palette.primary) },
        align: 'left',
      },
    })),
    ...rows.map((row, rIdx) =>
      row.map(cell => ({
        text: boundText(cell == null ? '' : String(cell), 500),
        options: {
          color: pptxHex(ctx.palette.text),
          fill: rIdx % 2 === 1 ? { color: pptxHex(ctx.palette.surface) } : undefined,
        },
      }))
    ),
  ]

  slide.addTable(tableData, {
    x: ctx.region.bodyX,
    y: ctx.region.bodyY,
    w: ctx.region.bodyW,
    colW: Array<number>(headers.length).fill(ctx.region.bodyW / headers.length),
    fontSize: ctx.dims.width > 12 ? 12 : 10,
    border: { type: 'solid', pt: 0.5, color: pptxHex(ctx.palette.border) },
    autoPage: false,
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderKpisSlide(slide: any, spec: PptxSlideSpec, ctx: RenderCtx): void {
  addSlideTitle(slide, spec.title ?? '', ctx)
  const kpis = (spec.kpis ?? []).slice(0, 8)
  if (kpis.length === 0) return

  // Pick grid: 1 row for ≤4, 2 rows for ≤8.
  const cols = kpis.length <= 4 ? kpis.length : 4
  const rows = kpis.length <= 4 ? 1 : 2
  const gap = 0.2
  const cellW = (ctx.region.bodyW - gap * (cols - 1)) / cols
  const cellH = Math.min((ctx.region.bodyH - gap * (rows - 1)) / rows, 2.0)

  kpis.forEach((kpi, idx) => {
    const r = Math.floor(idx / cols)
    const c = idx % cols
    const x = ctx.region.bodyX + c * (cellW + gap)
    const y = ctx.region.bodyY + r * (cellH + gap)
    // Card background.
    slide.addShape(ctx.pptx.shapes?.ROUNDED_RECTANGLE ?? 'roundRect', {
      x,
      y,
      w: cellW,
      h: cellH,
      fill: { color: pptxHex(ctx.palette.surface) },
      line: { color: pptxHex(ctx.palette.border), width: 0.5 },
      rectRadius: 0.05,
    })
    // Label.
    slide.addText(boundText(kpi.label, 120), {
      x: x + 0.2,
      y: y + 0.15,
      w: cellW - 0.4,
      h: 0.35,
      fontSize: 11,
      color: pptxHex(ctx.palette.muted),
      bold: true,
      charSpacing: 1,
    })
    // Value.
    slide.addText(boundText(String(kpi.value ?? ''), 80), {
      x: x + 0.2,
      y: y + 0.5,
      w: cellW - 0.4,
      h: 0.7,
      fontSize: cols >= 3 ? 24 : 32,
      bold: true,
      color: pptxHex(ctx.palette.primary),
    })
    // Delta.
    if (kpi.delta) {
      const ds = deltaSpec(kpi.deltaDirection, ctx.palette)
      slide.addText(`${ds.glyph}${boundText(kpi.delta, 80)}`, {
        x: x + 0.2,
        y: y + cellH - 0.45,
        w: cellW - 0.4,
        h: 0.3,
        fontSize: 11,
        color: ds.color,
      })
    }
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderColumnContent(
  slide: any,
  col: PptxColumnContent,
  area: { x: number; y: number; w: number; h: number },
  ctx: RenderCtx
): void {
  if (col.type === 'bullets' && Array.isArray(col.bullets)) {
    const bullets = col.bullets.map(b => ({
      text: boundText(b, 1000),
      options: { bullet: { code: '25CF' } },
    }))
    if (bullets.length === 0) return
    slide.addText(bullets, {
      ...area,
      fontSize: 14,
      color: pptxHex(ctx.palette.text),
      paraSpaceAfter: 6,
    })
  } else if (col.type === 'narrative' && col.text) {
    slide.addText(boundText(col.text, 4000), {
      ...area,
      fontSize: 14,
      color: pptxHex(ctx.palette.text),
      paraSpaceAfter: 6,
    })
  } else if (col.type === 'image' && col.image) {
    const safe = loadSafeImage(col.image.path, ctx.outputDir)
    if (safe) {
      slide.addImage({
        path: safe,
        ...area,
        sizing: { type: 'contain', w: area.w, h: area.h },
        altText: col.image.caption ?? '',
      })
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderTwoColumnSlide(slide: any, spec: PptxSlideSpec, ctx: RenderCtx): void {
  addSlideTitle(slide, spec.title ?? '', ctx)
  const cols = spec.columns
  if (!cols || !cols.left || !cols.right) return

  const gap = 0.4
  const colW = (ctx.region.bodyW - gap) / 2
  const leftArea = { x: ctx.region.bodyX, y: ctx.region.bodyY, w: colW, h: ctx.region.bodyH }
  const rightArea = {
    x: ctx.region.bodyX + colW + gap,
    y: ctx.region.bodyY,
    w: colW,
    h: ctx.region.bodyH,
  }
  renderColumnContent(slide, cols.left, leftArea, ctx)
  renderColumnContent(slide, cols.right, rightArea, ctx)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderImageSlide(slide: any, spec: PptxSlideSpec, ctx: RenderCtx): void {
  addSlideTitle(slide, spec.title ?? '', ctx)
  const img = spec.image
  if (!img) return
  const safe = loadSafeImage(img.path, ctx.outputDir)
  if (!safe) return

  const captionH = img.caption ? 0.4 : 0
  const imgArea = {
    x: ctx.region.bodyX,
    y: ctx.region.bodyY,
    w: ctx.region.bodyW,
    h: ctx.region.bodyH - captionH,
  }
  // Honor explicit dimensions if both width and height provided; else
  // contain-fit into the body area.
  if (img.width && img.height) {
    slide.addImage({
      path: safe,
      x: imgArea.x + (imgArea.w - img.width) / 2,
      y: imgArea.y + (imgArea.h - img.height) / 2,
      w: img.width,
      h: img.height,
      altText: img.caption ?? '',
    })
  } else {
    slide.addImage({
      path: safe,
      ...imgArea,
      sizing: { type: 'contain', w: imgArea.w, h: imgArea.h },
      altText: img.caption ?? '',
    })
  }

  if (img.caption) {
    slide.addText(boundText(img.caption, 400), {
      x: ctx.region.bodyX,
      y: ctx.region.bodyY + ctx.region.bodyH - captionH,
      w: ctx.region.bodyW,
      h: captionH,
      fontSize: 11,
      italic: true,
      color: pptxHex(ctx.palette.muted),
      align: 'center',
    })
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderQuoteSlide(slide: any, spec: PptxSlideSpec, ctx: RenderCtx): void {
  const { dims, palette } = ctx
  const q = spec.quote
  if (!q) return
  // Big opening quote glyph.
  slide.addText('“', {
    x: ctx.region.marginX,
    y: dims.height * 0.18,
    w: 2,
    h: 2,
    fontSize: dims.width > 12 ? 120 : 90,
    color: pptxHex(palette.accent),
    bold: true,
  })
  slide.addText(boundText(q.text, 2000), {
    x: ctx.region.marginX + 1.0,
    y: dims.height * 0.32,
    w: dims.width - ctx.region.marginX * 2 - 1.0,
    h: dims.height * 0.4,
    fontSize: dims.width > 12 ? 28 : 22,
    italic: true,
    color: pptxHex(palette.text),
    paraSpaceAfter: 8,
  })
  if (q.attribution) {
    slide.addText(`— ${boundText(q.attribution, 200)}`, {
      x: ctx.region.marginX + 1.0,
      y: dims.height * 0.78,
      w: dims.width - ctx.region.marginX * 2 - 1.0,
      h: 0.5,
      fontSize: 14,
      bold: true,
      color: pptxHex(palette.muted),
    })
  }
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

/** All internal tools available to workflow steps. */
export const INTERNAL_TOOLS: InternalToolDefinition[] = [
  generateMarkdown,
  generatePdf,
  generateDocx,
  generateXlsx,
  generatePptxTool,
  generateChart,
  generateDashboardTool,
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
