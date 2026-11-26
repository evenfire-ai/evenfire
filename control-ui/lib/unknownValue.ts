/**
 * Readers for values whose type the code does not know: parsed JSON (a Host
 * read, a request body, an annotation) and thrown values.
 */

/** A non-null object that is not an array: a JSON object, or any record. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A thrown value's message: its `message` when that is a non-empty string,
 * otherwise the value as text. A DOMException is not an `Error` in every
 * realm, so the message is read from any object, not only an `Error`.
 */
export function messageOf(error: unknown): string {
  const message = isPlainObject(error) ? error.message : undefined
  return typeof message === 'string' && message.length > 0 ? message : String(error)
}
