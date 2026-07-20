import type { DirectRunBindingOrigin } from './directRunAttributionBindingService.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ORIGINS = new Set<DirectRunBindingOrigin>(['direct_chat', 'channel_event', 'api'])

export type ParsedDirectRunBindingRequest = {
  runId: string
  sessionId: string
  origin: DirectRunBindingOrigin
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= max && !normalized.includes('\u0000')
    ? normalized
    : null
}

export function parseDirectRunBindingRequest(body: unknown): ParsedDirectRunBindingRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const expectedKeys = new Set(['runId', 'sessionId', 'origin'])
  const actualKeys = Object.keys(record)
  if (actualKeys.length !== expectedKeys.size || actualKeys.some(key => !expectedKeys.has(key))) {
    return null
  }

  const runId = boundedString(record.runId, 36)
  const sessionId = boundedString(record.sessionId, 256)
  const origin = record.origin
  if (
    !runId ||
    !UUID_RE.test(runId) ||
    !sessionId ||
    typeof origin !== 'string' ||
    !ORIGINS.has(origin as DirectRunBindingOrigin)
  ) {
    return null
  }

  return {
    runId,
    sessionId,
    origin: origin as DirectRunBindingOrigin,
  }
}
