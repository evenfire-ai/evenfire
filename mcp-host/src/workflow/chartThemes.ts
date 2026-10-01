/** Chart colour themes shared by the chart tool, the dashboard and the tool schemas. */

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
