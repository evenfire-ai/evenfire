import type { ExternalGfsAuthority } from '../../gfs/externalAuthority.js'

/**
 * Normalizers and subscription-key helpers for the GFS watch.
 *
 * Every value that comes from another layer (Postgres text, a NOTIFY payload,
 * a query string, a gfsc view) goes through exactly one helper here before it
 * is compared or used as an index key. Each helper is total: it returns the
 * normalized value or null and never throws on foreign input.
 *
 * The branded types make the domain of each argument explicit, so a helper
 * that takes a rid32 cannot silently receive a subscription key.
 */

/** 32 lowercase hex characters: a resource id without hyphens. */
export type Rid32 = string & { readonly __domain: 'Rid32' }
/** A lowercase, hyphenated UUID: the form Postgres prints for `uuid::text`. */
export type Uuid = string & { readonly __domain: 'Uuid' }
/** A canonical subscription key: `file:gfs://<drive>/<rid32>` or `dir:gfs://<drive>/<rid32>`. */
export type GfsKey = string & { readonly __domain: 'GfsKey' }
export type GfsKeyKind = 'file' | 'dir'
export type ParsedGfsKey = { kind: GfsKeyKind; drive: string; rid32: Rid32 }

/**
 * Drive names follow the DNS-label shape used for GFS_DRIVE_NAME, so a key for
 * a correctly configured drive passes and an invented one is a 400. This check
 * stands on its own: it does not rely on gfsc having validated the name.
 */
export const DRIVE_NAME_RE = /^[a-z0-9-]{1,63}$/

/**
 * The NOTIFY that carries a key set must stay under Postgres' 8000-byte limit
 * and the GET that carries it under nginx's default 8 KB request line; both
 * bounds are computed for these two ceilings.
 */
export const MAX_KEYS_PER_SET = 64
export const MAX_DRIVES_PER_SET = 2

const RID32_RE = /^[0-9a-fA-F]{32}$/
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const KEY_RE = /^(file|dir):gfs:\/\/([a-z0-9-]{1,63})\/([0-9a-f]{32})$/
const ENCODED_KEY_RE = /^[fd][0-9a-f]{32}$/

/** Any string → rid32, accepting a uuid with or without hyphens in either case. */
export function toRid32(x: unknown): Rid32 | null {
  if (typeof x !== 'string' || !(RID32_RE.test(x) || UUID_RE.test(x))) return null
  // Every hyphen, not just the first: a uuid carries four.
  return x.replace(/-/g, '').toLowerCase() as Rid32
}

/** rid32 → uuid, for parameters that Postgres binds as `uuid`. */
export function uuidOf(r32: Rid32): Uuid {
  return `${r32.slice(0, 8)}-${r32.slice(8, 12)}-${r32.slice(12, 16)}-${r32.slice(16, 20)}-${r32.slice(20, 32)}` as Uuid
}

/** Any string → the `id::text` form of a user id (lowercase, hyphenated). */
export function normUid(x: unknown): Uuid | null {
  const r32 = toRid32(x)
  return r32 === null ? null : uuidOf(r32)
}

/** Canonical key → its rid32. Only for keys that already passed `parseKeys`/`decodeKeys`. */
export function rid(k: GfsKey): Rid32 {
  return k.slice(k.lastIndexOf('/') + 1) as Rid32
}

/** Set of rid32 → uuid[] for a `$1::uuid[]` parameter. Never takes keys. */
export function rids(set: Iterable<Rid32>): Uuid[] {
  return Array.from(set, uuidOf)
}

/**
 * The trigger writes '' for "no parent" (INSERT's old side, DELETE's new side,
 * a drive root). That is a valid value, distinct from null, which means the
 * field did not parse.
 */
export const NO_PARENT: unique symbol = Symbol('NO_PARENT')
export function parentOf(x: unknown): Rid32 | typeof NO_PARENT | null {
  return x === '' ? NO_PARENT : toRid32(x)
}

/** '0' / '1' text flags → numeric 0 / 1, so callers compare with `=== 1`. */
export function bit01(x: unknown): 0 | 1 | null {
  return x === '0' ? 0 : x === '1' ? 1 : null
}

/** Decimal text of a non-negative safe integer → number. */
export function natural(x: unknown): number | null {
  return typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x) && Number.isSafeInteger(Number(x))
    ? Number(x)
    : null
}

/**
 * Port of gfs-controller's subject-resolver normalizer. node-postgres returns
 * BIGINT columns as strings (control-api registers no type parser) while JWT
 * claims arrive as numbers, so generations compare on the validated numeric
 * value. Decimals, signs, whitespace and unsafe magnitudes are rejected rather
 * than coerced.
 */
export function positiveGeneration(value: unknown): number | null {
  const normalized =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
        ? Number(value)
        : Number.NaN
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null
}

/** A gfsc resource view's `kind` → the key kind it satisfies. gfsc says 'directory'. */
export function kindOf(viewKind: unknown): GfsKeyKind | null {
  return viewKind === 'directory' ? 'dir' : viewKind === 'file' ? 'file' : null
}

export type WatchPrincipalKind = 'linked_operator' | 'user'

/** The watch authority's kind → the principal it reads gfsc as. Unrelated to `kindOf`. */
export function principalOf(
  authority: Pick<ExternalGfsAuthority, 'kind'> | null | undefined
): WatchPrincipalKind | null {
  return authority?.kind === 'linked-admin'
    ? 'linked_operator'
    : authority?.kind === 'user-session'
      ? 'user'
      : null
}

/** Any value → a canonical key decomposed, or null if it is not exactly canonical. */
export function parseKey(x: unknown): ParsedGfsKey | null {
  if (typeof x !== 'string') return null
  const m = KEY_RE.exec(x)
  return m ? { kind: m[1] as GfsKeyKind, drive: m[2]!, rid32: m[3] as Rid32 } : null
}

// keyKind / keyDrive take keys that already passed validation; the cast only
// restates that the brand guarantees a match.
export function keyKind(k: GfsKey): GfsKeyKind {
  return (parseKey(k) as ParsedGfsKey).kind
}

export function keyDrive(k: GfsKey): string {
  return (parseKey(k) as ParsedGfsKey).drive
}

export function drivesOf(set: Iterable<GfsKey>): Set<string> {
  return new Set(Array.from(set, keyDrive))
}

/**
 * The `k` query parameter as qs delivers it (absent, a string, or an array) →
 * a deduplicated key set, or null for any non-canonical entry or a set over
 * the key or drive ceilings. Canonical keys are unique per resource, so exact
 * string equality is the right dedupe.
 */
export function parseKeys(q: unknown): Set<GfsKey> | null {
  const xs: unknown[] = q === undefined ? [] : Array.isArray(q) ? q : [q]
  if (xs.some(x => parseKey(x) === null)) return null
  const set = new Set(xs as GfsKey[])
  return set.size <= MAX_KEYS_PER_SET && drivesOf(set).size <= MAX_DRIVES_PER_SET ? set : null
}

export type EncodedKeys = Record<string, string[]>

/**
 * Key set → `{drive: ["f"|"d" + rid32, ...]}`, the compact form of the
 * command payload. The object has no prototype: drive names such as
 * `constructor` or `valueof` pass the drive rule and would otherwise resolve
 * to inherited members instead of a fresh array.
 */
export function encodeKeys(set: Iterable<GfsKey>): EncodedKeys {
  const encoded = Object.create(null) as EncodedKeys
  for (const k of set) {
    const drive = keyDrive(k)
    ;(encoded[drive] ??= []).push((keyKind(k) === 'file' ? 'f' : 'd') + rid(k))
  }
  return encoded
}

/**
 * A parsed JSON value → the key set `encodeKeys` produced, or null. Reads own
 * keys only, so a `__proto__` member from JSON.parse is seen (and rejected by
 * the drive rule) instead of skipped.
 */
export function decodeKeys(o: unknown): Set<GfsKey> | null {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null
  const record = o as Record<string, unknown>
  const set = new Set<GfsKey>()
  for (const drive of Object.keys(record)) {
    const entries = record[drive]
    if (!DRIVE_NAME_RE.test(drive) || !Array.isArray(entries)) return null
    for (const entry of entries) {
      if (typeof entry !== 'string' || !ENCODED_KEY_RE.test(entry)) return null
      set.add(`${entry[0] === 'f' ? 'file' : 'dir'}:gfs://${drive}/${entry.slice(1)}` as GfsKey)
    }
  }
  return set
}

/**
 * Rows → Map from a normalized key to the normalized values, in row order.
 * Rows whose key or value normalizes to null are dropped. A pg `Result` is
 * never indexed directly: its row keys keep the other layer's representation.
 */
export function groupBy<R, K, V>(
  rows: Iterable<R>,
  keyFn: (row: R) => K | null,
  valueFn: (row: R) => V | null
): Map<K, V[]> {
  const grouped = new Map<K, V[]>()
  for (const row of rows) {
    const key = keyFn(row)
    const value = valueFn(row)
    if (key === null || value === null) continue
    const bucket = grouped.get(key)
    if (bucket) bucket.push(value)
    else grouped.set(key, [value])
  }
  return grouped
}

/** Rows → Map from a normalized key to its first row; rows with a null key are dropped. */
export function byKey<R, K>(rows: Iterable<R>, keyFn: (row: R) => K | null): Map<K, R> {
  const indexed = new Map<K, R>()
  for (const row of rows) {
    const key = keyFn(row)
    if (key === null || indexed.has(key)) continue
    indexed.set(key, row)
  }
  return indexed
}
