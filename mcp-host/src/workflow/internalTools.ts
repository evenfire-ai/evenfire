/**
 * Internal output tools for workflow steps and chat.
 *
 * Available to all workflows — no MCP server required. Each tool produces
 * a document artifact (markdown, PDF, DOCX, XLSX, PPTX, PNG chart, HTML
 * dashboard) and writes it to the output directory: the caller's own folder in
 * chat (workspace/callerOutputs.ts), getOutputDir in a workflow.
 *
 * This file lists them. Each schema is in toolSchemas/, and each generator is
 * its own module, loaded with its library on first use: pdfmake (PDF), docx
 * (DOCX), exceljs (XLSX), pptxgenjs (PPTX), chart.js (PNG charts), and the
 * dashboard renderer; markdown and the dashboard HTML are written as strings. No headless browser is involved,
 * but @napi-rs/canvas is native, and charts, PDFs and the measuring of DOCX
 * tables and slide text read the fonts the image installs (fonts.ts).
 */
import { CONTEXT_FILES_TOOLS, loadContextFilesMounts } from './contextFiles'
import { runGenerateMarkdown } from './markdownGenerator'
import { runGeneratePptx } from './pptxGenerator'
import { fromModule, nullsUnset, prepared } from './toolExecution'
import { CHART_TOOL } from './toolSchemas/chart'
import { DASHBOARD_TOOL } from './toolSchemas/dashboard'
import { DOCX_TOOL } from './toolSchemas/docx'
import { MARKDOWN_TOOL } from './toolSchemas/markdown'
import { PDF_TOOL } from './toolSchemas/pdf'
import { PPTX_TOOL } from './toolSchemas/pptx'
import { XLSX_TOOL } from './toolSchemas/xlsx'
import type { InternalToolDefinition, InternalToolResult } from './types'
import { listWorkflows, readWorkflow, triggerWorkflow } from './workflowTools'
import { runGenerateXlsx } from './xlsxGenerator'

export { enforceQuota, getDirectorySize } from './artifactOutput'
export { CHART_THEMES } from './chartThemes'
export type { ChartTheme } from './chartThemes'
export { escapeHtmlAttr, safeJsonForScript } from './dashboardHtml'
export { loadChartJsBundle } from './dashboardChartJs'
export { getOutputDir, setOutputDirHostAccessor, validateOutputPath } from './outputDirectory'

const generateChart: InternalToolDefinition = {
  ...CHART_TOOL,
  execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    return fromModule(
      () => import('./chartGenerator'),
      m => m.runGenerateChart(args, outputDir)
    )
  },
}

const generateMarkdown: InternalToolDefinition = { ...MARKDOWN_TOOL, execute: runGenerateMarkdown }

const generatePdf: InternalToolDefinition = {
  ...PDF_TOOL,
  execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    return fromModule(
      () => import('./pdfGenerator'),
      m => m.runGeneratePdf(args, outputDir)
    )
  },
}

const generateDocx: InternalToolDefinition = {
  ...DOCX_TOOL,
  execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    return fromModule(
      () => import('./docxGenerator'),
      m => m.runGenerateDocx(args, outputDir)
    )
  },
}

const generateXlsx: InternalToolDefinition = { ...XLSX_TOOL, execute: runGenerateXlsx }

const generateDashboardTool: InternalToolDefinition = {
  ...DASHBOARD_TOOL,
  execute(args: Record<string, unknown>, outputDir: string): Promise<InternalToolResult> {
    return fromModule(
      () => import('./dashboardRender'),
      m => m.runGenerateDashboard(args, outputDir)
    )
  },
}

const generatePptxTool: InternalToolDefinition = { ...PPTX_TOOL, execute: runGeneratePptx }

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
