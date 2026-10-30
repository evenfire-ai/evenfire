/**
 * The pptx tool's vocabulary, shared by its schema and the deck builder: palettes,
 * aspect ratios, templates, slide layouts, statuses, severities and native chart
 * types. Plain data, so the schema can name them without loading pptxgenjs.
 */

export interface PptxPalette {
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

export const PPTX_PALETTES: Record<string, PptxPalette> = {
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

export const PPTX_ASPECT_RATIOS: Record<string, { name: string; width: number; height: number }> = {
  wide: { name: 'LAYOUT_WIDE', width: 13.333, height: 7.5 },
  '16x9': { name: 'LAYOUT_16x9', width: 10, height: 5.625 },
  '16x10': { name: 'LAYOUT_16x10', width: 10, height: 6.25 },
  '4x3': { name: 'LAYOUT_4x3', width: 10, height: 7.5 },
}

export const PPTX_TEMPLATES = [
  'executive-brief',
  'quarterly-review',
  'incident-review',
  'pitch-deck',
] as const

export const SLIDE_LAYOUTS = [
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

export const STATUSES = ['green', 'yellow', 'red'] as const

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const

/** Types drawn as native charts; the stacked ones are bar and area charts with stacked grouping. */
export const NATIVE_CHART_TYPES = [
  'line',
  'bar',
  'horizontalBar',
  'pie',
  'doughnut',
  'area',
  'stackedBar',
  'stackedArea',
] as const
