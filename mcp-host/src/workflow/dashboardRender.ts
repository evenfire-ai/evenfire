/** The HTML dashboard renderer (clerum__generate_dashboard): templates, blocks, CSS and the page wrapper. */
import * as fs from 'fs'
import * as path from 'path'
import {
  artifactResult,
  claimOutputFile,
  enforceQuota,
  ensureDir,
  outputFilename,
  replacedBytes,
} from './artifactOutput'
import { coerceNumber } from './chartData'
import { DashboardCharts } from './dashboardCharts'
import { escapeHtml, escapeHtmlAttr, oneOf, safeJsonForScript } from './dashboardHtml'
import { dashboardScript } from './dashboardScript'
import {
  DASHBOARD_THEMES,
  type DashboardTheme,
  type DashboardThemeColors,
  type ThemeName,
} from './dashboardThemes'
import { inlineSpans } from './inlineMarkup'
import { choose, own } from './ownEntry'
import { headerText, normalizeTableRows } from './tableRows'
import type { InternalToolResult } from './types'

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
  grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
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
  grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr));
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
  grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));
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

export const HERO_STATUSES = ['green', 'yellow', 'red', 'neutral'] as const

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

function renderChartCards(charts: unknown, where: string, ctx: DashRender, title?: string): string {
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

function renderTableHtml(t: unknown, where: string, ctx: DashRender, title?: string): string {
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

export const SECTION_TYPES = ['narrative', 'bullets', 'callout', 'code'] as const
export const CALLOUT_TONES = ['info', 'success', 'warning', 'danger'] as const

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

// The fields are named rather than spread: a spread reads every key, which
// would hide the ones nothing draws from the "Ignored arguments" note.
function heroOf(data: DashData, eyebrowFallback?: unknown): string {
  return renderHero({
    title: data.title,
    headline: data.headline,
    status: data.status,
    statusLabel: data.statusLabel,
    eyebrow: data.eyebrow ?? eyebrowFallback,
  })
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

export const BLOCK_TYPES = [
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
  const list = own(BLOCK_LISTS, String(block.type))
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
  const { field, alias, noun } = own(BLOCK_LISTS, String(block.type))!
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
        return renderSectionHtml(
          {
            type: block.type,
            content: block.content,
            language: block.language,
            tone: block.tone,
            title,
          },
          where
        )
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
    fs.writeFileSync(target.filePath, html, 'utf-8')

    return artifactResult(target, 'html', { warnings })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const DASHBOARD_TEMPLATE_NAMES = [
  'executive-brief',
  'operations-pulse',
  'financial-review',
  'technical-report',
  'custom',
] as const
