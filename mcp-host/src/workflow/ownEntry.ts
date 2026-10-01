/**
 * Lookups in fixed tables keyed by text the model sends. A plain object also
 * answers for the keys it inherits ("constructor", "toString", "__proto__"),
 * which would hand a function or a prototype to code expecting an entry.
 */

/** The entry `table` has for `key` itself, or undefined. */
export function own<T>(table: Partial<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}
