/**
 * Shared K8s name validation for the control-ui.
 * RFC 1123 DNS label: lowercase alphanumeric and hyphens, max 63 chars,
 * must start and end with alphanumeric.
 */

const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export function isValidK8sName(name: string): boolean {
  return K8S_NAME_RE.test(name) && name.length <= 63
}
