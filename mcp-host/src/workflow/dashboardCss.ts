/** The dashboard stylesheet, built from a theme. */
import { type DashboardTheme, type DashboardThemeColors } from './dashboardThemes'

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
export function buildDashboardCss(theme: DashboardTheme, mode?: 'light' | 'dark'): string {
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
.kpi-card__sparkline-note {
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.4;
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
