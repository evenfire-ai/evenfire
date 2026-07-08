/**
 * Trust level color mapping used across registry UI components.
 * Maps trust_level values to their foreground colors.
 */

const TRUST_COLORS: Record<string, string> = {
  high: '#22c55e',
  mid: '#eab308',
  low: '#f97316',
}

const TRUST_BG_COLORS: Record<string, string> = {
  high: '#22c55e22',
  mid: '#eab30822',
  low: '#f9731622',
}

export function trustColor(level: string): string {
  return TRUST_COLORS[level] ?? TRUST_COLORS.low
}

export function trustBgColor(level: string): string {
  return TRUST_BG_COLORS[level] ?? TRUST_BG_COLORS.low
}
