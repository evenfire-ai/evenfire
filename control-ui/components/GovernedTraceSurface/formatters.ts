export function formatTraceTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
    : value
}

export function displayTraceValue(value: string | null | undefined): string {
  return value?.trim() || 'Unavailable'
}

export function formatTraceLabel(value: string | null | undefined): string {
  const normalized = value?.trim().replace(/[_-]+/g, ' ')
  return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : 'Unavailable'
}
