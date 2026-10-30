/** The PDF color palettes. */

export interface PdfPalette {
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

export const PDF_PALETTES: Record<string, PdfPalette> = {
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

export function statusColorFromPalette(palette: PdfPalette, status?: string): string | undefined {
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
