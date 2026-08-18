/**
 * Shared K8s name validation for the control-ui.
 * RFC 1123 DNS label: lowercase alphanumeric and hyphens, max 63 chars,
 * must start and end with alphanumeric.
 */

const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

// RFC1123 DNS-label max length, mirrored by the server (`invalid_name`).
export const RFC1123_MAX_LENGTH = 63

export function isValidK8sName(name: string): boolean {
  return K8S_NAME_RE.test(name) && name.length <= RFC1123_MAX_LENGTH
}

// RFC1123 DNS-SUBDOMAIN max length. K8s Secret names are validated as DNS
// subdomains (≤253), NOT the stricter ≤63 DNS label used for hosts/contexts/
// channels. Mirrors the server's `isValidDNSSubdomain`
// (control-api/src/http/rfc1123.ts).
export const DNS_SUBDOMAIN_MAX_LENGTH = 253

// Same charset as a DNS label but up to 253 chars. Regex mirrors the server's
// DNS_SUBDOMAIN_RE (control-api/src/http/rfc1123.ts) exactly.
const DNS_SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/

/**
 * Validate a name as an RFC1123 DNS subdomain (lowercase alphanumeric + interior
 * hyphens, ≤253 chars, no leading/trailing hyphen). Client-side mirror of the
 * control-api `isValidDNSSubdomain` used to validate K8s Secret names. Returns
 * false for the empty string. Use this — not `isValidK8sName` — for Secret
 * names, which the server accepts up to 253 chars.
 */
export function isValidDNSSubdomain(name: string): boolean {
  return DNS_SUBDOMAIN_RE.test(name)
}

/**
 * Sanitize an arbitrary string into a valid RFC 1123 DNS label for use as a
 * default K8s resource name: lowercase, runs of non-`[a-z0-9-]` collapsed to a
 * single hyphen, leading/trailing hyphens trimmed, capped at 63 chars. Used to
 * derive an install "server name" default from a scoped registry entry name —
 * e.g. `@test-oss-jose/helloo` → `test-oss-jose-helloo`. May return `""` when
 * the input has no usable characters (the caller then leaves the field empty).
 */
export function toK8sName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-') // non-label chars (@, /, …) → single hyphen
    .replace(/-+/g, '-') // collapse runs
    .replace(/^-+|-+$/g, '') // trim edges (labels must start/end alphanumeric)
    .slice(0, 63)
    .replace(/-+$/g, '') // re-trim if the 63-cap left a trailing hyphen
}

/**
 * Validate an agent name (RFC 1123 DNS label plus a 3-char minimum). Returns
 * an empty string when the name is acceptable, or a human-readable error
 * otherwise. Used by the create-agent wizard to surface inline validation.
 */
export function getAgentNameError(name: string): string {
  if (!name.trim()) return 'Agent name is required.'
  if (!/^[a-z0-9-]+$/.test(name))
    return 'Agent name may only use lowercase letters, numbers, and hyphens.'
  if (!/^[a-z]/.test(name)) return 'Agent name must start with a letter.'
  if (!/[a-z0-9]$/.test(name)) return 'Agent name must end with a letter or number.'
  if (name.length > 63) return 'Agent name must be 63 characters or fewer.'
  if (name.length < 3) return 'Agent name must be at least 3 characters long.'
  return ''
}
