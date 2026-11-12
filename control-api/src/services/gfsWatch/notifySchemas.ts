import {
  type GfsKey,
  MAX_DRIVES_PER_SET,
  MAX_KEYS_PER_SET,
  NO_PARENT,
  type Rid32,
  type Uuid,
  bit01,
  decodeKeys,
  drivesOf,
  encodeKeys,
  natural,
  normUid,
  parentOf,
  positiveGeneration,
  toRid32,
} from './keys.js'

/**
 * Wire schemas of the GFS watch NOTIFY channels. LISTEN/NOTIFY need no
 * privilege, so every payload is untrusted input: each parser is total and
 * returns null for a payload outside its schema.
 *
 * A schema may accept somewhat more than its producer emits today (for
 * example a rid32 without hyphens where the trigger prints a uuid). That is
 * deliberate on the revocation channels: an invalid payload there fails
 * closed and reopens every stream, so a stricter parser would turn any
 * harmless change of the trigger's formatting into replica-wide reopens.
 */

export const GFS_RESOURCE_CHANGED_CHANNEL = 'gfs_resource_changed'
export const GFS_AUTHZ_CHANGED_CHANNEL = 'gfs_authz_changed'
export const GFS_WATCH_SESSION_CHANNEL = 'gfs_watch_session'
export const GFS_WATCH_PING_CHANNEL = 'gfs_watch_ping'
export const GFS_WATCH_CMD_CHANNEL = 'gfs_watch_cmd'

/**
 * Channels that can carry a revocation. A payload on one of them that fails
 * its schema may be exactly the revocation the registry could not read, so it
 * must fail closed rather than be dropped.
 */
export const REVOCATION_CHANNELS = Object.freeze([
  GFS_RESOURCE_CHANGED_CHANNEL,
  GFS_AUTHZ_CHANGED_CHANNEL,
  GFS_WATCH_SESSION_CHANNEL,
] as const)

// A function over a frozen tuple rather than an exported Set: Object.freeze
// does not stop Set#add, so a shared Set could be widened or emptied at runtime.
export function isRevocationChannel(channel: string): boolean {
  return (REVOCATION_CHANNELS as readonly string[]).includes(channel)
}

export type ResourceChangeOp = 'i' | 'u' | 'd'

/**
 * Field names avoid the helper names (`rid`) and reserved words (`new`): a
 * destructured `rid` would shadow the helper of the same name.
 */
export type ResourceChanged = {
  rid32: Rid32
  oldParent: Rid32 | null
  newParent: Rid32 | null
  /** 1 when the change is visible to a root listing. */
  h: 0 | 1
  /** 1 when ancestry or existence changed (move, soft delete, restore, DELETE). */
  a: 0 | 1
  op: ResourceChangeOp
}

/** `gfs_resource_changed` payload: "rid,old_parent,new_parent,h,a,op", one per row. */
export function parseResourceChanged(payload: unknown): ResourceChanged | null {
  if (typeof payload !== 'string') return null
  const fields = payload.split(',')
  if (fields.length !== 6) return null
  const r32 = toRid32(fields[0])
  const oldParent = parentOf(fields[1])
  const newParent = parentOf(fields[2])
  const h = bit01(fields[3])
  const a = bit01(fields[4])
  const op = fields[5] === 'i' || fields[5] === 'u' || fields[5] === 'd' ? fields[5] : null
  if (
    r32 === null ||
    oldParent === null ||
    newParent === null ||
    h === null ||
    a === null ||
    op === null
  ) {
    return null
  }
  return {
    rid32: r32,
    oldParent: oldParent === NO_PARENT ? null : oldParent,
    newParent: newParent === NO_PARENT ? null : newParent,
    h,
    a,
    op,
  }
}

export type WatchPing = { instanceId: string; epoch: number; n: number }

const INSTANCE_ID_RE = /^[0-9a-f]{32}$/

/**
 * `gfs_watch_ping` payload: "<instanceId>:<epoch>:<n>". The instance id is 16
 * random bytes as lowercase hex; any other form is not this process's echo.
 */
export function parsePing(payload: unknown): WatchPing | null {
  if (typeof payload !== 'string') return null
  const fields = payload.split(':')
  if (fields.length !== 3) return null
  const instanceId = INSTANCE_ID_RE.test(fields[0]!) ? fields[0]! : null
  const epoch = positiveGeneration(fields[1])
  const n = natural(fields[2])
  if (instanceId === null || epoch === null || n === null) return null
  return { instanceId, epoch, n }
}

/** Postgres rejects a NOTIFY payload of 8000 bytes or more; this keeps a margin. */
export const WATCH_CMD_PAYLOAD_LIMIT_BYTES = 7900

/**
 * A subscription-set command routed to the replica that owns the connection.
 * `c` connection id, `s` sequence, `u` user id, `g` authorization generation,
 * `r` request id of the PUT that issued it.
 */
export type WatchCmd = {
  c: string
  s: number
  u: Uuid
  g: number
  r: Uuid
  keys: ReadonlySet<GfsKey>
}

const CONN_ID_RE = /^[0-9a-f]{32}$/

/** The one producer of `gfs_watch_cmd` payloads. */
export function serializeWatchCmd(cmd: WatchCmd): string {
  return JSON.stringify({
    c: cmd.c,
    s: cmd.s,
    u: cmd.u,
    g: cmd.g,
    r: cmd.r,
    k: encodeKeys(cmd.keys),
  })
}

/**
 * `gfs_watch_cmd` payload → command, or null. A `t` member sent by replicas of
 * an earlier version is ignored: the team no longer travels in the command.
 */
export function parseWatchCmd(payload: unknown): WatchCmd | null {
  if (typeof payload !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.c !== 'string' || !CONN_ID_RE.test(v.c)) return null
  if (typeof v.s !== 'number' || !Number.isSafeInteger(v.s) || v.s <= 0) return null
  const u = normUid(v.u)
  const g = positiveGeneration(v.g)
  const r = normUid(v.r)
  if (u === null || g === null || r === null) return null
  const keys = decodeKeys(v.k)
  if (keys === null || keys.size > MAX_KEYS_PER_SET || drivesOf(keys).size > MAX_DRIVES_PER_SET) {
    return null
  }
  return { c: v.c, s: v.s, u, g, r, keys }
}
