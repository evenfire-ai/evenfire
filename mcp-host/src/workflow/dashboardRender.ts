/**
 * The HTML dashboard renderer (clerum__generate_dashboard): the page wrapper and
 * the tool entry. The stylesheet, the page parts and the templates are in
 * dashboardCss, dashboardComponents and dashboardTemplates.
 */
import {
  artifactResult,
  claimOutputFile,
  enforceQuota,
  ensureDir,
  outputFilename,
  replacedBytes,
  writeArtifact,
} from './artifactOutput'
import { loadChartJsBundle } from './dashboardChartJs'
import { DashboardCharts } from './dashboardCharts'
import {
  type DashRender,
  type DashboardBranding,
  dashText,
  isDashRecord,
  renderDashboardFooter,
} from './dashboardComponents'
import { buildDashboardCss } from './dashboardCss'
import { escapeHtml, safeJsonForScript } from './dashboardHtml'
import { dashboardScript } from './dashboardScript'
import { DASHBOARD_TEMPLATES, type DashData, ignoredDashboardFields } from './dashboardTemplates'
import { DASHBOARD_THEMES, type ThemeName } from './dashboardThemes'
import { DASHBOARD_TEMPLATE_NAMES, type DashboardTemplateName } from './dashboardVocabulary'
import { choose } from './ownEntry'
import { type InternalToolResult } from './types'

export {
  BLOCK_TYPES,
  CALLOUT_TONES,
  DASHBOARD_TEMPLATE_NAMES,
  HERO_STATUSES,
  SECTION_TYPES,
} from './dashboardVocabulary'
export { loadChartJsBundle } from './dashboardChartJs'

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
    aliased: [],
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
// ─── generate_dashboard tool definition ─────────────────────────────

export async function runGenerateDashboard(
  args: Record<string, unknown>,
  outputDir: string
): Promise<InternalToolResult> {
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
    const notes: string[] = []
    const template = choose(
      args.template,
      DASHBOARD_TEMPLATE_NAMES,
      'executive-brief',
      'template',
      notes
    )
    const theme = choose(
      args.theme,
      ['default', 'corporate', 'warm', 'alert'] as const,
      'default',
      'theme',
      notes
    )
    // Unset, the page follows the viewer's setting, so an unknown mode does too.
    let defaultThemeMode: 'light' | 'dark' | undefined
    if (args.defaultThemeMode !== undefined && args.defaultThemeMode !== null) {
      const mode = String(args.defaultThemeMode).trim().toLowerCase()
      if (mode === 'light' || mode === 'dark') defaultThemeMode = mode
      else {
        notes.push(
          `defaultThemeMode ${JSON.stringify(args.defaultThemeMode)} is not light or dark, so ` +
            "the page follows the viewer's setting."
        )
      }
    }
    const inlineChartJs = args.inlineChartJs !== false
    const { html, ctx } = renderDashboard({
      template,
      data,
      theme,
      defaultThemeMode,
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
      ...notes,
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
    writeArtifact(target, html)

    return { ...artifactResult(target, 'html', { warnings }), aliasedArguments: ctx.aliased }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
