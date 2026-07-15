import type { HostMessageResponse, SessionTokensLite } from '../../../src/types'
import type { AppErrorKind } from '../uiTypes'

export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatChatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * Compact token-count label for the session indicator: `950`, `12.4k`, `1.2M`.
 * Decimal (1000-based) since token counts are reported as decimal integers.
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.trunc(n))
  const units = ['k', 'M', 'B', 'T']
  const render = (value: number): string =>
    value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
  let value = n
  let unitIndex = -1
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000
    unitIndex += 1
  }
  // Rounding to display precision can carry into the next unit (e.g.
  // 999_950 → 999.95 → rounds to "1000" → must read "1M", not "1000k").
  if (Number(render(value)) >= 1000 && unitIndex < units.length - 1) {
    value /= 1000
    unitIndex += 1
  }
  return `${render(value)}${units[unitIndex]}`
}

/**
 * Compact `N/M (P%)` label for the context-window chip — e.g. `32.9k/100k (33%)`.
 * Reuses `formatTokenCount` for the k/M scaling so the chip matches the lifetime
 * token indicators. `fillRatio` is the authoritative server-computed ratio.
 */
export function formatContextFill(
  totalInputTokens: number,
  maxTokens: number,
  fillRatio: number
): string {
  const pct = Math.round((Number.isFinite(fillRatio) ? fillRatio : 0) * 100)
  return `${formatTokenCount(totalInputTokens)}/${formatTokenCount(maxTokens)} (${pct}%)`
}

/** One-decimal percentage label for a context-breakdown bucket — e.g. `53.7%`. */
export function formatBucketPercent(fraction: number): string {
  const value = Number.isFinite(fraction) ? fraction * 100 : 0
  return `${value.toFixed(1)}%`
}

/**
 * Full token breakdown for a tooltip: `Input 1,234 · Output 567` plus
 * `· Cache read X · Cache write Y` when the model reported cache (cacheRead/
 * cacheWrite present). Exact figures (toLocaleString), unlike the compact label.
 */
export function formatTokenBreakdown(tokens: SessionTokensLite): string {
  const parts = [
    `Input ${tokens.input.toLocaleString()}`,
    `Output ${tokens.output.toLocaleString()}`,
  ]
  if (tokens.cacheRead !== undefined || tokens.cacheWrite !== undefined) {
    parts.push(
      `Cache read ${(tokens.cacheRead ?? 0).toLocaleString()}`,
      `Cache write ${(tokens.cacheWrite ?? 0).toLocaleString()}`
    )
  }
  return parts.join(' · ')
}

export function looksLikeJson(content: string): boolean {
  const value = content.trim()
  return (
    (value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))
  )
}

export function extractHtmlVisualization(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  const fencedMatch = trimmed.match(/```(?:html|htm)\s*[\r\n]+([\s\S]*?)```/i)
  if (fencedMatch?.[1]?.trim()) {
    return fencedMatch[1].trim()
  }

  const lower = trimmed.toLowerCase()
  const looksLikeDocument =
    lower.startsWith('<!doctype html') ||
    lower.startsWith('<html') ||
    (lower.includes('<html') && lower.includes('</html>')) ||
    (lower.includes('<body') && lower.includes('</body>'))
  if (looksLikeDocument) {
    return trimmed
  }

  return null
}

export function extractAssistantReply(response: HostMessageResponse): string {
  const error = response.error
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error !== 'string' && error.message.trim()) return error.message
  const content = response.content
  const message = response.message
  const text = response.text
  const reply = response.response
  const output = response.output
  if (typeof content === 'string' && content.trim()) return content
  if (typeof message === 'string' && message.trim()) return message
  if (typeof text === 'string' && text.trim()) return text
  if (typeof reply === 'string' && reply.trim()) return reply
  if (typeof output === 'string' && output.trim()) return output
  if (response.success === false) {
    return 'Message failed'
  }
  return toPrettyJson(response)
}

export function classifyErrorKind(message: string): AppErrorKind {
  const value = message.toLowerCase()
  // Structured host-availability codes from rpc-proxy (host_waking) and the
  // mcp-host DRAINING fence (host_draining): the host is coming up, not broken.
  if (value.includes('host_waking') || value.includes('host_draining')) return 'waking'
  if (value.includes('timeout') || value.includes('gateway') || value.includes('network'))
    return 'network'
  if (
    value.includes('401') ||
    value.includes('403') ||
    value.includes('unauthorized') ||
    value.includes('forbidden')
  )
    return 'auth'
  if (value.includes('invalid') || value.includes('required') || value.includes('json'))
    return 'validation'
  if (value.includes('500') || value.includes('upstream') || value.includes('rpc'))
    return 'upstream'
  return 'unknown'
}

/** Normalize an unknown thrown value to a lowercased message string. */
function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).toLowerCase()
}

/**
 * True when an error reflects an HTTP 404 (the server doesn't know a chat the
 * local cache references). Used by the D.4 reconcile to evict a stale local
 * chat — which is destructive, so we require the 404 status token specifically
 * rather than a generic "not found" substring (a "host/agent not found"
 * transport error must NOT evict the user's cache).
 */
export function isHttp404(err: unknown): boolean {
  const value = errorText(err)
  return (
    /\b404\b/.test(value) || value.includes('chat not found') || value.includes('session not found')
  )
}

/**
 * True when an error reflects a transport/connectivity failure rather than a
 * server-side rejection. The D.4 reconcile stays in offline mode on these.
 */
export function isNetworkError(err: unknown): boolean {
  const value = errorText(err)
  return (
    value.includes('timeout') ||
    value.includes('gateway') ||
    value.includes('network') ||
    value.includes('fetch failed') ||
    value.includes('econnrefused') ||
    value.includes('failed to fetch')
  )
}

export function errorRecoveryHint(kind: AppErrorKind): string {
  if (kind === 'waking')
    return 'The agent host is starting up. Retry in a few seconds — no message was delivered.'
  if (kind === 'network')
    return 'Temporary connectivity issue. Retry in a few seconds or check backend health.'
  if (kind === 'auth')
    return 'Authentication/permission issue. Re-authenticate or switch team/access scope.'
  if (kind === 'validation') return 'Request format issue. Review payload and required fields.'
  if (kind === 'upstream') return 'Upstream service failed. Retry or check server/runtime health.'
  return 'Unexpected failure. Retry and check server health if it persists.'
}

function toTimestampMs(value?: number | string | Date | null): number | null {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const parsed = value.getTime()
  return Number.isFinite(parsed) ? parsed : null
}

export function formatRelativeTime(timestamp?: number | string | Date | null): string {
  const resolvedTimestamp = toTimestampMs(timestamp)
  if (resolvedTimestamp == null) return 'No activity yet'
  const diff = Date.now() - resolvedTimestamp
  if (!Number.isFinite(diff)) return 'No activity yet'
  if (diff < 0) return 'Just now'
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const days = Math.floor(diff / 86_400_000)
  if (days === 1) return 'Yesterday'
  return `${days}d ago`
}

export function formatMcpServerDisplayName(name: string): string {
  const trimmed = String(name || '').trim()
  if (!trimmed) return ''
  let normalized = trimmed
  if (normalized.toLowerCase().startsWith('mcp-')) {
    normalized = normalized.slice(4)
  }
  if (normalized.toLowerCase().endsWith('-remote')) {
    normalized = normalized.slice(0, -'-remote'.length)
  }
  const cleaned = normalized.trim()
  return cleaned || trimmed
}

export function formatMcpServerAcronym(name: string): string {
  const displayName = formatMcpServerDisplayName(name)
  if (!displayName) return '?'
  const token = displayName
    .split(/[^a-zA-Z0-9]+/)
    .map(part => part.trim())
    .find(Boolean)
  if (!token) return displayName.slice(0, 2).toUpperCase()
  return token.slice(0, 2).toUpperCase()
}
