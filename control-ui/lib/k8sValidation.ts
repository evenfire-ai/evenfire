/**
 * Shared K8s name validation for the control-ui.
 * RFC 1123 DNS label: lowercase alphanumeric and hyphens, max 63 chars,
 * must start and end with alphanumeric.
 */

const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export function isValidK8sName(name: string): boolean {
  return K8S_NAME_RE.test(name) && name.length <= 63
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
