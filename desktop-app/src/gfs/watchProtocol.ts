/**
 * Pure helpers and wire contract of the GFS watch client (main process).
 *
 * Every value that comes from another layer (the renderer's key list, a
 * session token, a response header, an NDJSON line) goes through exactly one
 * helper here before the watch client compares it or stores it. Each helper is
 * total: it returns the normalized value, `null` or `undefined`, and never
 * throws on foreign input.
 */

/** Relative to the external REST API base URL; GET opens the stream, PUT replaces its key set. */
export const GFS_WATCH_PATH = '/api/v1/me/gfs/watch'

/** Deadline of an open until its `ready`; it must exceed the server's own open deadline plus the edge. */
export const T_OPEN_MS = 20_000
/** Deadline of one PUT request until its HTTP answer. */
export const T_PUT_MS = 5_000
/**
 * The transport timeout of the PUT. `requestJson` always arms a timeout and
 * falls back to the app-wide `REQUEST_TIMEOUT_MS`, which may be shorter than
 * `T_PUT_MS`; passing this keeps `T_PUT_MS` the deadline that fires first.
 */
export const PUT_TRANSPORT_TIMEOUT_MS = T_PUT_MS + 1_000
/** From the PUT's 2xx until its `subscriptions` frame. */
export const T_ACK_MS = 15_000
/** Retries of one PUT episode (so 7 requests) before the stream is reopened. */
export const PUT_MAX_ATTEMPTS = 6
export const BACKOFF_CAP_MS = 15_000
export const SLOW_BACKOFF_MS = 60_000
export const DEFERRED_RETRY_CAP_MS = 60_000
/** Spread of the first reopen after an unannounced common failure (EOF, network, 502). */
export const FIRST_FAILURE_SPREAD_MS = 5_000
export const HEARTBEAT_MIN_MS = 5_000
export const HEARTBEAT_MAX_MS = 25_000
export const WATCHDOG_HEARTBEATS = 3
/** Longest line the reader buffers; anything longer is a broken stream, not a frame. */
export const MAX_FRAME_CHARS = 16 * 1024
/** The server's per-set ceiling: the GET line and the command NOTIFY are sized for it. */
export const MAX_KEYS = 64
export const RETRY_AFTER_CAP_MS = 5 * 60 * 1000
const FRAME_RETRY_AFTER_MAX_MS = 300_000

/**
 * Canonical subscription key, identical to control-api's `KEY_RE`. The
 * renderer already canonicalized with `parseGfsUri`; main only validates, so a
 * non-canonical value is dropped rather than rewritten.
 */
export const KEY_RE = /^(file|dir):gfs:\/\/([a-z0-9-]{1,63})\/([0-9a-f]{32})$/

export function canonicalKey(x: unknown): string | null {
  return typeof x === 'string' && KEY_RE.test(x) ? x : null
}

/** The renderer's list → canonical keys, deduplicated keeping the first occurrence and its order. */
export function canonList(xs: unknown): string[] {
  if (!Array.isArray(xs)) return []
  const out = new Set<string>()
  for (const x of xs) {
    const k = canonicalKey(x)
    if (k !== null) out.add(k)
  }
  return [...out]
}

export function trunc64(list: readonly string[]): string[] {
  return list.slice(0, MAX_KEYS)
}

/**
 * Owners' lists merged by rank: position `i` of every owner before position
 * `i + 1` of any, ties broken by registration order, no duplicates. Focus is
 * deliberately not a tie-breaker: it has no event, and with more than 64 keys
 * every alt-tab would change the sent set.
 */
export function fuse(owners: Iterable<{ regOrder: number; keys: readonly string[] }>): string[] {
  const ordered = [...owners].sort((a, b) => a.regOrder - b.regOrder)
  const out: string[] = []
  const seen = new Set<string>()
  const depth = ordered.reduce((max, o) => Math.max(max, o.keys.length), 0)
  for (let i = 0; i < depth; i++) {
    for (const o of ordered) {
      const k = o.keys[i]
      if (k !== undefined && !seen.has(k)) {
        seen.add(k)
        out.push(k)
      }
    }
  }
  return out
}

// ─── Session binding ─────────────────────────────────────────────────────────

const RID32_RE = /^[0-9a-fA-F]{32}$/
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Any value → the lowercase hyphenated uuid control-api compares user ids in, or null. */
export function normUid(x: unknown): string | null {
  if (typeof x !== 'string' || !(RID32_RE.test(x) || UUID_RE.test(x))) return null
  const r = x.replace(/-/g, '').toLowerCase()
  return `${r.slice(0, 8)}-${r.slice(8, 12)}-${r.slice(12, 16)}-${r.slice(16, 20)}-${r.slice(20, 32)}`
}

/**
 * Same normalizer control-api applies to `authGeneration`: a positive safe
 * integer given as a number or as canonical decimal text, nothing coerced.
 */
export function positiveGeneration(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
        ? Number(value)
        : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * The payload of a JWS, without verifying its signature: main has no key, and
 * the server verifies every request anyway. The binding read from it only
 * decides when main reopens or drops lists; it grants nothing.
 */
export function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null
  const segments = token.split('.')
  if (segments.length !== 3) return null
  try {
    const claims: unknown = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8'))
    return claims !== null && typeof claims === 'object' && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export type GfsWatchBinding = { userId: string; authGeneration: number }

/**
 * The server binds a watch connection to the token's user and authorization
 * generation. The team is not part of it: a team switch of the same user keeps
 * the stream. A token without both claims (opaque, or a V2 session) has no
 * binding, which compares different from every binding, null included.
 */
export function bindingOf(token: string | null | undefined): GfsWatchBinding | null {
  const claims = decodeJwtPayload(token)
  const userId = normUid(claims?.userId)
  const authGeneration = positiveGeneration(claims?.authGeneration)
  if (userId === null || authGeneration === null) return null
  return { userId, authGeneration }
}

/** Field comparison: every hop restores a new token object with the same claims. */
export function bindingChanged(
  a: GfsWatchBinding | null | undefined,
  b: GfsWatchBinding | null | undefined
): boolean {
  return a == null || b == null || a.userId !== b.userId || a.authGeneration !== b.authGeneration
}

// ─── Error responses ─────────────────────────────────────────────────────────

/**
 * `Retry-After` as seconds or an HTTP-date → milliseconds from `nowMs`, capped
 * at 5 minutes; anything unparsable is `undefined` (no server floor).
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number
): number | undefined {
  const retryAfter = value?.trim()
  if (!retryAfter) return undefined
  const seconds = Number(retryAfter)
  const retryAtMs =
    Number.isFinite(seconds) && seconds >= 0 ? nowMs + seconds * 1_000 : Date.parse(retryAfter)
  if (!Number.isFinite(retryAtMs)) return undefined
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, retryAtMs - nowMs))
}

/**
 * The watch error code, from the `x-watch-error` header of the GET (read
 * without awaiting the body) or from the `{error}` body `requestJson` already
 * read for the PUT. Anything outside the code alphabet is null, which selects
 * the "other" row of its status.
 */
export function errorCodeOf(source: {
  header?: string | null
  bodyText?: string | null
}): string | null {
  let code: unknown = source.header ?? null
  if (code === null && typeof source.bodyText === 'string') {
    try {
      code = (JSON.parse(source.bodyText) as { error?: unknown } | null)?.error
    } catch {
      code = null
    }
  }
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : null
}

// ─── Frames ──────────────────────────────────────────────────────────────────

export type DecisionFields = {
  accepted: string[]
  rejected: string[]
  deferred: string[]
  retryAfterMs?: number
}

export type GfsWatchFrame =
  | ({ type: 'ready'; connId: string; heartbeatMs: number } & DecisionFields)
  | ({ type: 'subscriptions'; seq: number } & DecisionFields)
  | { type: 'changed'; keys: string[] }
  | { type: 'heartbeat' }
  | { type: 'roots_changed' }
  | { type: 'stream.closing'; reason: string; retryAfterMs?: number }

/**
 * `invalid` is a stream error (a cut or corrupt line, a known frame with the
 * wrong shape); `unknown` is ignored for forward compatibility (another
 * schema version or a frame type this client does not know).
 */
export type ParsedLine =
  | { kind: 'frame'; frame: GfsWatchFrame }
  | { kind: 'unknown' }
  | { kind: 'invalid' }

const isStringArray = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every(item => typeof item === 'string')

/** Keys from the server are stored and forwarded to renderers; a non-canonical one is dropped. */
const canonicalOnly = (xs: string[]): string[] => xs.filter(x => canonicalKey(x) !== null)

const isFrameRetryAfter = (x: unknown): x is number | undefined =>
  x === undefined ||
  (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= FRAME_RETRY_AFTER_MAX_MS)

function decisionOf(f: Record<string, unknown>): DecisionFields | null {
  if (!isStringArray(f.accepted) || !isStringArray(f.rejected) || !isStringArray(f.deferred)) {
    return null
  }
  if (!isFrameRetryAfter(f.retryAfterMs)) return null
  return {
    accepted: canonicalOnly(f.accepted),
    rejected: canonicalOnly(f.rejected),
    deferred: canonicalOnly(f.deferred),
    ...(f.retryAfterMs === undefined ? {} : { retryAfterMs: f.retryAfterMs }),
  }
}

export function parseFrameLine(line: string): ParsedLine {
  if (line.length > MAX_FRAME_CHARS) return { kind: 'invalid' }
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { kind: 'invalid' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { kind: 'unknown' }
  const f = value as Record<string, unknown>
  if (f.schemaVersion !== 1) return { kind: 'unknown' }
  switch (f.type) {
    case 'ready': {
      const d = decisionOf(f)
      if (
        !d ||
        typeof f.connId !== 'string' ||
        f.connId === '' ||
        typeof f.heartbeatMs !== 'number'
      ) {
        return { kind: 'invalid' }
      }
      return {
        kind: 'frame',
        frame: { type: 'ready', connId: f.connId, heartbeatMs: f.heartbeatMs, ...d },
      }
    }
    case 'subscriptions': {
      const d = decisionOf(f)
      if (!d || !Number.isSafeInteger(f.seq) || (f.seq as number) < 1) return { kind: 'invalid' }
      return { kind: 'frame', frame: { type: 'subscriptions', seq: f.seq as number, ...d } }
    }
    case 'changed':
      return isStringArray(f.keys)
        ? { kind: 'frame', frame: { type: 'changed', keys: canonicalOnly(f.keys) } }
        : { kind: 'invalid' }
    case 'heartbeat':
      return { kind: 'frame', frame: { type: 'heartbeat' } }
    case 'roots_changed':
      return { kind: 'frame', frame: { type: 'roots_changed' } }
    case 'stream.closing':
      if (typeof f.reason !== 'string' || !isFrameRetryAfter(f.retryAfterMs))
        return { kind: 'invalid' }
      return {
        kind: 'frame',
        frame: {
          type: 'stream.closing',
          reason: f.reason,
          ...(f.retryAfterMs === undefined ? {} : { retryAfterMs: f.retryAfterMs }),
        },
      }
    default:
      return { kind: 'unknown' }
  }
}
