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
import * as fs from 'fs'
import * as path from 'path'
import { config } from '../config'
import { WorkflowListTool, WorkflowStatusTool } from '../core/tools/workflowReadTools'
import { WorkflowTriggerTool } from '../core/tools/workflowTriggerTool'
import {
  artifactResult,
  claimOutputFile,
  enforceQuota,
  ensureDir,
  outputFilename,
  replacedBytes,
} from './artifactOutput'
import {
  DEFAULT_CHART_HEIGHT,
  DEFAULT_CHART_WIDTH,
  MAX_CHART_DIMENSION,
  MIN_CHART_DIMENSION,
} from './chartThemes'
import { CONTEXT_FILES_TOOLS, loadContextFilesMounts } from './contextFiles'
import { DASHBOARD_CHART_TYPES } from './dashboardCharts'
import {
  BLOCK_TYPES,
  CALLOUT_TONES,
  DASHBOARD_TEMPLATE_NAMES,
  HERO_STATUSES,
  SECTION_TYPES,
  runGenerateDashboard,
} from './dashboardRender'
import {
  DOCX_IMAGE_FILE_DESCRIPTION,
  IMAGE_FILE_DESCRIPTION,
  PDF_MAX_FOOTER_LINES,
} from './documentSchema'
import {
  NATIVE_CHART_TYPES,
  PPTX_ASPECT_RATIOS,
  PPTX_PALETTES,
  PPTX_TEMPLATES,
  SEVERITIES,
  SLIDE_LAYOUTS,
  STATUSES,
} from './pptxVocabulary'
import { watchUnknownArguments, withoutUnsetNulls } from './schemaArguments'
import { cleanToolArgs } from './toolText'
import type { InternalToolDefinition, InternalToolResult } from './types'

export { enforceQuota, getDirectorySize } from './artifactOutput'
export { CHART_THEMES } from './chartThemes'
export type { ChartTheme } from './chartThemes'
export { escapeHtmlAttr, safeJsonForScript } from './dashboardHtml'
export { loadChartJsBundle } from './dashboardRender'

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

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * The types of a table or sheet cell: text, a number, true/false, or null for
 * an empty cell. Each runtime stringifies or formats what arrives.
 */
const CELL_TYPES = ['string', 'number', 'boolean', 'null']

/**
 * A row sent as a {header: cell} record, which every runtime reads by header
 * name. Gemini rejects an object schema with no properties, so it declares one
 * example key; additionalProperties keeps the others valid. The example is a
 * column index, which the runtime reads as that column.
 */
const RECORD_ROW_SCHEMA = {
  type: 'object',
  properties: { '0': { type: CELL_TYPES, description: 'Column 0, or a header.' } },
  additionalProperties: { type: CELL_TYPES },
}

/** One row of cells, left to right in header order, or a record. */
const ROW_SCHEMA = { anyOf: [{ type: 'array', items: { type: CELL_TYPES } }, RECORD_ROW_SCHEMA] }

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
 * gap, {x, y[, r]} or [x, y[, r]] for scatter and bubble, {x, y} with a
 * category x, and {label, value} records or [label, value] pairs.
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
        x: { type: ['number', 'string'], description: 'X value.' },
        y: { type: 'number', description: 'Y value.' },
        r: { type: 'number', description: 'Bubble radius (px).' },
        label: { type: 'string', description: 'Category.' },
        value: { type: ['number', 'string'], description: 'Value.' },
      },
    },
  ],
  description: 'A number, null for a gap, or {x, y} / {x, y, r} or [x, y] for scatter / bubble.',
}

/**
 * Runs a generator from its own module, loaded on first use so that starting
 * the host loads no document library. A module that fails to load fails the
 * call the way a generator error does.
 */
async function fromModule<M>(
  load: () => Promise<M>,
  run: (loaded: M) => Promise<InternalToolResult>
): Promise<InternalToolResult> {
  let loaded: M
  try {
    loaded = await load()
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
  return run(loaded)
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
  execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    return fromModule(
      () => import('./chartGenerator'),
      m => m.runGenerateChart(args, outputDir)
    )
  },
}

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

/** Drawn size for a spreadsheet image, in pixels. */
const XLSX_MAX_IMAGE_WIDTH = 640
const XLSX_MAX_IMAGE_HEIGHT = 400

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
  execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    return fromModule(
      () => import('./pdfGenerator'),
      m => m.runGeneratePdf(args, outputDir)
    )
  },
}

// ─── generate_docx ───────────────────────────────────────────────────

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
  execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    return fromModule(
      () => import('./docxGenerator'),
      m => m.runGenerateDocx(args, outputDir)
    )
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
                anyOf: [
                  {
                    type: 'array',
                    description: 'One row, left to right.',
                    items: XLSX_CELL_SCHEMA,
                  },
                  RECORD_ROW_SCHEMA,
                ],
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
      const { buildXlsxWorkbook } = await import('./xlsxWorkbook')
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
  x: { type: ['number', 'string'], description: 'X.' },
  y: { type: 'number', description: 'Y.' },
  r: { type: 'number', description: 'Radius (px).' },
}

/**
 * One chart value: a number, text such as "1,200", null for a gap, an [x, y]
 * or [label, value] pair, or an object.
 */
function dashPoint(objectProperties: Record<string, unknown>): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'number' },
      { type: 'string' },
      { type: 'null' },
      { type: 'array', items: { type: ['number', 'string'] } },
      { type: 'object', properties: objectProperties },
    ],
  }
}

/** normalizeChartData also reads {label, value} records. */
const DASH_POINT_SCHEMA = dashPoint({
  ...XYR_PROPERTIES,
  label: { type: 'string', description: 'Category.' },
  value: { type: ['number', 'string'], description: 'Value.' },
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
        '0': { type: 'string', description: 'Column 0: plain, severity, priority or status.' },
      },
      // A plain string, not an enum: an unknown type shows the column as plain
      // text with a note, the same on every path, as it did before types were listed.
      additionalProperties: { type: 'string' },
      description:
        'Badge columns: header or 0-based index to plain, severity, priority or status, e.g. ' +
        '{"Status": "severity"}. Values such as critical, high, medium, low, info, p0-p2, ' +
        'healthy, degraded, down then show as colored badges.',
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
                      items: ROW_SCHEMA,
                      description: 'As data.tables[].',
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
  execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    return runGenerateDashboard(args, outputDir)
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
  "Image file name in the output folder, e.g. from clerum__generate_chart ('sales.png'). " +
  'PNG, JPEG, GIF, WebP or SVG.'

const PPTX_PATH_SHORT = 'File name from clerum__generate_chart.'

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
      rows: { type: 'array', items: ROW_SCHEMA, description: rows },
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
        value: { type: ['number', 'string'], description: 'Value.' },
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
        "Chart image file name from clerum__generate_chart (e.g. 'sales.png'), for " +
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
 * A template chart. Its fields are those of slides[].chart, which the schema
 * spells out once: every model request carries the schema, and the deck
 * builder checks a template chart as it checks a slide's (readNativeChart, then
 * the chart normalizer), naming the field it cannot use.
 */
function pptxTemplateChart(description: string): Record<string, unknown> {
  return {
    type: 'object',
    description: `${description} Same fields as slides[].chart.`,
    properties: {
      type: { type: 'string', enum: [...NATIVE_CHART_TYPES], description: 'Chart type.' },
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
    'line. Text is plain: markdown is not read. Lists, tables and KPI cards that do not fit ' +
    'continue on further slides and long text is set smaller; the result says when.',
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
      const { buildPptxDeck } = await import('./pptxDeck')
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
      let release: () => void
      try {
        clean = withoutUnsetNulls(tool.parameters, cleanToolArgs(args ?? {})) as Record<
          string,
          unknown
        >
        const { predecodeImages } = await import('./embeddedImages')
        release = await predecodeImages(clean, outputDir)
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
      const unknown = watchUnknownArguments(tool.parameters, clean)
      let result: InternalToolResult
      try {
        result = await tool.execute(clean, outputDir)
      } finally {
        release()
      }
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

/**
 * A tool that reads a null sent for an optional argument as unset, as the
 * generators do, so a call means the same from chat and from a workflow step.
 */
function nullsUnset(tool: InternalToolDefinition): InternalToolDefinition {
  return {
    ...tool,
    execute: (args, outputDir, options) =>
      tool.execute(
        withoutUnsetNulls(tool.parameters, args ?? {}) as Record<string, unknown>,
        outputDir,
        options
      ),
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
  ...[listWorkflows, readWorkflow, triggerWorkflow, ...CONTEXT_FILES_TOOLS].map(nullsUnset),
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
