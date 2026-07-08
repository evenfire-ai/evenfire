/**
 * Canonical JSON serialization for deterministic hashing.
 *
 * Unlike JSON.stringify, this produces identical output regardless of key
 * insertion order. Object keys are sorted lexicographically at every depth,
 * and `undefined` values are dropped (matching JSON.stringify semantics).
 *
 * Used to derive payload_hash for the workflow approval idempotency guard:
 * two callers that submit the same Idempotency-Key with semantically-equal
 * payloads (even with re-ordered JSON keys) must resolve to the same hash.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'null' // mirror JSON.stringify top-level undefined handling
  const t = typeof value
  if (t === 'number') {
    return Number.isFinite(value as number) ? String(value) : 'null'
  }
  if (t === 'string' || t === 'boolean') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const items = value.map(item => (item === undefined ? 'null' : stableStringify(item)))
    return `[${items.join(',')}]`
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort()
    const body = keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')
    return `{${body}}`
  }
  // Unsupported types (functions, symbols, bigints): fall back to null to
  // stay JSON-compatible without throwing on malformed payloads.
  return 'null'
}
