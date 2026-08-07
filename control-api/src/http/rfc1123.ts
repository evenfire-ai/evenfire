/**
 * RFC 1123 DNS label and subdomain validation.
 *
 * Shared across admin route handlers that validate resource names
 * (hosts, recipes, contexts, secrets, etc.) against K8s naming conventions.
 *
 * Two variants:
 *   - DNS Label:    1-63 chars (for pod names, resource names)
 *   - DNS Subdomain: 1-253 chars (for secret names, fully-qualified names)
 */

/** DNS label: lowercase alphanumeric + hyphens, 1-63 chars, no leading/trailing hyphens. */
export const RFC1123_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** DNS subdomain: same charset, up to 253 chars. */
const DNS_SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/;

/** Validate a K8s resource name as a DNS subdomain (max 253 chars). */
export function isValidDNSSubdomain(name: string): boolean {
  return DNS_SUBDOMAIN_RE.test(name);
}

