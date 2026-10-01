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

/**
 * JSON.stringify with HTML-sensitive characters escaped, safe to embed
 * inside a `<script>` block. Prevents `</script>...<script>alert(1)...`
 * breakouts via attacker-controlled string content.
 */
export function safeJsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * Escape a value for use inside an HTML attribute (single OR double
 * quoted). Defends against attribute-breakout XSS like
 * `data-foo='${val}'` where `val` contains `'`.
 */
export function escapeHtmlAttr(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
