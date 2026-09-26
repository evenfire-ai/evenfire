import { pinnedFetch } from '../http/pinnedFetch.js'
import type { DcrDeps } from './dcr.js'

/**
 * Best-effort RFC 7592 client-delete at the AS's management endpoint (spec 02
 * C2/C4, DEC-18). Shared by the install saga's rollback paths (`remoteMcp.ts`) and
 * the uninstall teardown module (`mcpServerOAuthTeardown.ts`) — the reliable local
 * revocation is the store delete each caller runs; this is the courtesy cleanup.
 */

const DCR_DELETE_TIMEOUT_MS = 15_000

/**
 * Best-effort RFC 7592 client-delete against the AS's management endpoint, so a
 * dynamic client we minted does not linger at the AS after a local abort/uninstall.
 * Single-hop pinned DELETE (never re-resolves) with the registration bearer; any
 * failure is swallowed — the caller's local store delete is the reliable revocation,
 * this is courtesy cleanup. Never logs the bearer.
 */
export async function bestEffortRfc7592Delete(
  dcrDeps: DcrDeps,
  registrationClientUri: string,
  registrationAccessToken: string
): Promise<void> {
  try {
    await pinnedFetch(registrationClientUri, 'spec.oauth.registrationClientUri', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${registrationAccessToken}` },
      resolveDns: dcrDeps.resolveDns,
      transport: dcrDeps.transport,
      timeoutMs: DCR_DELETE_TIMEOUT_MS,
    })
  } catch {
    // Best-effort; the caller's local store delete is the reliable revocation.
  }
}
