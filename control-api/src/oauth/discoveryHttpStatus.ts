import type { DiscoveryError } from './discovery.js'

/**
 * Map a discovery failure to an HTTP status for the OAuth discovery admin endpoints
 * (remote `POST /admin/mcp-servers/remote/discover` and generic
 * `POST /admin/oauth/discover`). Extracted here (H-5) so both share ONE mapping.
 *
 * `fetch_failed` and `content_encoding_rejected` are upstream transport failures —
 * the AS never returned a usable HTTP response — so they surface as 502, the same
 * way the callback maps provider fetch failures (`provider_token_exchange_failed` /
 * `provider_response_invalid` → 502). Every other kind is either bad operator input
 * (`kernel_rejected`) or a reachable-but-incompatible/misconfigured AS: retrying will
 * not help, and the returned `detail.kind` tells the operator what to fix, so 400 is
 * the operator-actionable signal. The switch is exhaustive over `DiscoveryError` so a
 * newly added kind fails to compile until its status is decided here.
 */
export function discoveryHttpStatus(error: DiscoveryError): number {
  switch (error.kind) {
    case 'fetch_failed':
    case 'content_encoding_rejected':
      return 502
    case 'kernel_rejected':
    case 'invalid_metadata':
    case 'no_s256':
    case 'no_authorization_server':
    case 'redirect_blocked':
    case 'prm_resource_mismatch':
    case 'issuer_mismatch':
      return 400
    default: {
      const _exhaustive: never = error
      return 400
    }
  }
}
