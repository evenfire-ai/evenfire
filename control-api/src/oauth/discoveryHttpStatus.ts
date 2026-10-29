import type { DiscoveryError } from './discovery.js'

/**
 * Map a discovery failure to an HTTP status for the OAuth discovery admin endpoints
 * (remote `POST /admin/mcp-servers/remote/discover` and generic
 * `POST /admin/oauth/discover`) and for the remote install's own discovery. Extracted
 * here (H-5) so all of them share ONE mapping.
 *
 * `fetch_failed` and `content_encoding_rejected` mean a dependency failed — the AS or
 * the remote server never returned a usable response (an unknown Entra tenant answers
 * its well-known with a 400, for instance) — so they surface as 424 Failed Dependency.
 * Not a 5xx: the edge proxy (Cloudflare) replaces an origin 5xx with its own page, and
 * the wizard would lose the typed `detail` that says which dependency failed. Every
 * other kind is either bad operator input (`kernel_rejected`) or a reachable but
 * incompatible/misconfigured AS: retrying will not help, and `detail.kind` tells the
 * operator what to fix, so 400. No kind maps to a 5xx. The switch is exhaustive over
 * `DiscoveryError` so a newly added kind fails to compile until its status is decided here.
 */
export function discoveryHttpStatus(error: DiscoveryError): number {
  switch (error.kind) {
    case 'fetch_failed':
    case 'content_encoding_rejected':
      return 424
    case 'kernel_rejected':
    case 'invalid_metadata':
    case 'no_s256':
    case 'no_authorization_server':
    case 'redirect_blocked':
    case 'prm_resource_mismatch':
    case 'issuer_mismatch':
    case 'as_endpoints_cross_site':
    case 'tenant_required':
    case 'authorization_server_override_rejected':
      return 400
    default: {
      const _exhaustive: never = error
      return 400
    }
  }
}
