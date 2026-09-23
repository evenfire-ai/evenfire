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

/** Parse one NDJSON frame. Unknown versions/types fail safe into full invalidation. */
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
    return {
      schemaVersion: 1,
      type: 'resync_required',
      cursor: frame.cursor,
      scopes: ['gfs', 'authorization'],
    }
  }
  if (
    frame.type === 'resync_required' ||
    frame.type === 'scope.invalidated' ||
    frame.type === 'heartbeat' ||
    frame.type === 'stream.closing'
  ) {
    const scopes = Array.isArray(frame.scopes)
      ? frame.scopes.filter(
          (scope): scope is 'gfs' | 'authorization' => scope === 'gfs' || scope === 'authorization'
        )
      : undefined
    return {
      schemaVersion: 1,
      type: frame.type,
      cursor: frame.cursor,
      ...(scopes ? { scopes } : {}),
      ...(typeof frame.observedAt === 'string' ? { observedAt: frame.observedAt } : {}),
      ...(typeof frame.reason === 'string'
        ? { reason: frame.reason as EntityChangeFrame['reason'] }
        : {}),
    }
  }
  return {
    schemaVersion: 1,
    type: 'resync_required',
    cursor: frame.cursor,
    scopes: ['gfs', 'authorization'],
  }
}
