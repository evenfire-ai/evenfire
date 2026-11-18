// Stricter than Postgres' `::uuid` cast (which also accepts braces and no
// hyphens): anything that passes here is guaranteed to cast, so a channel
// provider id or a test sender is a definitive denial, never a DB error.
const CANONICAL_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID_RE.test(value)
}
