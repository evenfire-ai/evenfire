/**
 * Lookups in fixed tables keyed by text the model sends. A plain object also
 * answers for the keys it inherits ("constructor", "toString", "__proto__"),
 * which would hand a function or a prototype to code expecting an entry.
 */

/** The entry `table` has for `key` itself, or undefined. */
export function own<T>(table: Partial<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/**
 * `value` as one of `allowed`, read without regard to case; `fallback` when it
 * is unset, and also when it names none of them, which `warnings` records so
 * the model learns its choice was not used.
 */
export function choose<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
  warnings: string[]
): T {
  if (value === undefined || value === null || value === '') return fallback
  const text = String(value).trim().toLowerCase()
  const hit = allowed.find(name => name.toLowerCase() === text)
  if (hit !== undefined) return hit
  warnings.push(
    `${field} ${JSON.stringify(value)} is not one of ${allowed.join(', ')}; "${fallback}" was used.`
  )
  return fallback
}
