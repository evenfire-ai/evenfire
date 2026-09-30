import { controlApiUrl } from './api'

export const ENTITY_CHANGE_CURSOR_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type EntityChangeFrame = {
  schemaVersion: 1
  type: 'resync_required' | 'scope.invalidated' | 'heartbeat' | 'stream.closing'
  cursor: string
  scopes?: Array<'gfs' | 'authorization'>
  observedAt?: string
  reason?: 'max_lifetime' | 'session_expired' | 'server_shutdown' | 'slow_consumer'
}

export function entityChangeStreamUrl(cursor?: string): string {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  return controlApiUrl(`/api/v1/gfs/entity-changes/stream${query}`)
}

const ENTITY_CHANGE_RETRY_AFTER_CAP_MS = 5 * 60 * 1000

/** Parse and bound a server Retry-After hint before it reaches a browser timer. */
export function parseEntityChangeRetryAfterMs(
  value: string | null,
  nowMs = Date.now()
): number | undefined {
  const retryAfter = value?.trim()
  if (!retryAfter) return undefined

  const seconds = Number(retryAfter)
  const retryAtMs =
    Number.isFinite(seconds) && seconds >= 0 ? nowMs + seconds * 1000 : Date.parse(retryAfter)
  if (!Number.isFinite(retryAtMs)) return undefined

  return Math.min(ENTITY_CHANGE_RETRY_AFTER_CAP_MS, Math.max(0, retryAtMs - nowMs))
}

/** Parse one NDJSON frame. Safe v1 extensions are skipped; unsupported schemas are rejected. */
export function parseEntityChangeFrame(line: string): EntityChangeFrame | null {
  if (!line.trim()) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error('Malformed entity-change frame')
  }
  if (!value || typeof value !== 'object') throw new Error('Malformed entity-change frame')
  const frame = value as Record<string, unknown>
  if (typeof frame.cursor !== 'string' || !ENTITY_CHANGE_CURSOR_RE.test(frame.cursor)) {
    throw new Error('Invalid entity-change cursor')
  }
  if (frame.schemaVersion !== 1 || typeof frame.type !== 'string') {
    throw new Error('Unsupported entity-change schema version')
  }
  if (frame.type === 'resync_required' || frame.type === 'scope.invalidated') {
    if (!Array.isArray(frame.scopes) || frame.scopes.length === 0) {
      throw new Error('Invalid entity-change scopes')
    }
    const scopes = frame.scopes.filter(
      (scope): scope is 'gfs' | 'authorization' => scope === 'gfs' || scope === 'authorization'
    )
    if (scopes.length === 0) return null
    return {
      schemaVersion: 1,
      type: frame.type,
      cursor: frame.cursor,
      scopes,
    }
  }
  if (frame.type === 'heartbeat') {
    if (typeof frame.observedAt !== 'string') throw new Error('Invalid entity-change heartbeat')
    return {
      schemaVersion: 1,
      type: 'heartbeat',
      cursor: frame.cursor,
      observedAt: frame.observedAt,
    }
  }
  if (frame.type === 'stream.closing') {
    const reasons = ['max_lifetime', 'session_expired', 'server_shutdown', 'slow_consumer']
    if (typeof frame.reason !== 'string' || !reasons.includes(frame.reason)) return null
    return {
      schemaVersion: 1,
      type: 'stream.closing',
      cursor: frame.cursor,
      reason: frame.reason as EntityChangeFrame['reason'],
    }
  }
  // Schema v1 extensions are defined to be safely ignorable by older clients.
  return null
}
