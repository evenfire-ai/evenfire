/**
 * The names `clerum__generate_dashboard` accepts, apart from the renderer, so
 * its schema can list them without loading the renderer.
 */

/** Every chart type the dashboard draws, the same set clerum__generate_chart accepts. */
export const DASHBOARD_CHART_TYPES = [
  'line',
  'bar',
  'horizontalBar',
  'pie',
  'doughnut',
  'area',
  'radar',
  'polarArea',
  'scatter',
  'bubble',
  'stackedBar',
  'stackedArea',
  'mixedBarLine',
  'gauge',
  'waterfall',
  'funnel',
] as const

export const HERO_STATUSES = ['green', 'yellow', 'red', 'neutral'] as const

export const SECTION_TYPES = ['narrative', 'bullets', 'callout', 'code'] as const
export const CALLOUT_TONES = ['info', 'success', 'warning', 'danger'] as const

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

export const DASHBOARD_TEMPLATE_NAMES = [
  'executive-brief',
  'operations-pulse',
  'financial-review',
  'technical-report',
  'custom',
] as const

export type DashboardTemplateName = (typeof DASHBOARD_TEMPLATE_NAMES)[number]
