/**
 * HTML escaping for the dashboard. Every value that reaches the page from the
 * arguments goes through here or through a whitelist, because the file is
 * opened straight from disk in the user's browser.
 */

/** Escape text for an element body or a quoted attribute. */
export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#x2F;')
}

/** `value` when it is one of `allowed`, otherwise `fallback`. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}
