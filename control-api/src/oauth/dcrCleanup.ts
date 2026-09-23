import type { DbClient } from '../db.js'
import { pinnedFetch } from '../http/pinnedFetch.js'
import type { DcrDeps } from './dcr.js'
import {
  type DynamicClientKey,
  deleteDynamicClient,
  getDynamicClient,
} from './dynamicClientStore.js'

/**
 * Shared DCR (RFC 7591/7592) client teardown (spec 02 C2/C4, DEC-18). Extracted
 * here once the compensation idiom reached a 4th call site (the mcp-server
 * uninstall) — the install saga's rollback paths (`remoteMcp.ts`) and the
 * uninstall now share ONE implementation (colateral DRY note of C2).
 */

const DCR_DELETE_TIMEOUT_MS = 15_000

/**
 * Best-effort RFC 7592 client-delete against the AS's management endpoint, so a
 * dynamic client we minted does not linger at the AS after a local abort/uninstall.
 * Single-hop pinned DELETE (never re-resolves) with the registration bearer; any
 * failure is swallowed — the local `deleteDynamicClient` is the reliable
 * revocation, this is courtesy cleanup. Never logs the bearer.
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
    // Best-effort; the local store delete is the reliable revocation.
  }
}

export interface DcrTeardownResult {
  /** Rows removed from `dynamic_clients` (0 ⇒ no DCR client for this server — already clean). */
  localRowsDeleted: number
  /** Whether a courtesy RFC 7592 DELETE was attempted (the row carried a management handle). */
  attemptedRemoteDelete: boolean
}

/**
 * Full DCR teardown for a server CR keyed per-server (`owner_kind/namespace/name`):
 * read the stored row, best-effort RFC 7592 DELETE at the AS (courtesy), then the
 * reliable local `deleteDynamicClient`. Idempotent — a server with no DCR client
 * (0 rows) is a clean no-op. Reads never mask the local delete: if the store read
 * throws (e.g. a decrypt error), the local delete still runs.
 */
export async function cleanupDynamicClientForServer(
  db: DbClient,
  encryptionKey: Buffer,
  dcrDeps: DcrDeps,
  key: DynamicClientKey
): Promise<DcrTeardownResult> {
  let registrationClientUri: string | undefined
  let registrationAccessToken: string | undefined
  try {
    const row = await getDynamicClient(db, encryptionKey, key)
    registrationClientUri = row?.registrationClientUri
    registrationAccessToken = row?.registrationAccessToken
  } catch {
    // Read failed — fall through to the reliable local delete below.
  }
  let attemptedRemoteDelete = false
  if (registrationClientUri && registrationAccessToken) {
    attemptedRemoteDelete = true
    await bestEffortRfc7592Delete(dcrDeps, registrationClientUri, registrationAccessToken)
  }
  const localRowsDeleted = await deleteDynamicClient(db, key)
  return { localRowsDeleted, attemptedRemoteDelete }
}
