import type { DbClient } from '../db.js'
import type { Logger } from '../observability/logger.js'
import { mcpServerUninstallTeardownFailuresTotal } from '../observability/metrics.js'
import type { DcrDeps } from './dcr.js'
import { bestEffortRfc7592Delete } from './dcrCleanup.js'
import { claimDeleteDynamicClientForResource } from './dynamicClientStore.js'
import { deleteOAuthGrantsForServer } from './store.js'

/**
 * Shared OAuth teardown for a mcp-server uninstall, fenced by the uninstalled CR's
 * `metadata.uid` (R3-H5). Replaces the previous name-only pair — `dcrCleanup`'s
 * `cleanupDynamicClientForServer` and the loose `deleteOAuthGrantsForServer` call in
 * the uninstall route — so a same-name REINSTALL's state is never torn down or revoked
 * by the uninstall of a previous installation.
 *
 * Two race windows the uid fence + the single-statement claim close:
 *   - B: the reinstall wrote its row before the old teardown ran → the old name-only
 *     read+revoke would revoke the NEW client. Here the DELETE…RETURNING only revokes
 *     the client of the row it actually removed (this uid's, or a legacy row's).
 *   - C: the old read→await(7592)→delete gap let a reinstall slip a new row in between.
 *     Here there is no gap: the claim is one statement.
 *
 * Runs while the CR still exists (see mcpServerUninstall.ts) and never throws: a
 * throw is caught, counted (metric, per stage) and logged (names-only), and reported
 * as `'failed'` so the caller can keep the CR and answer "repair required" — the
 * retry reuses the same uid.
 */
export type TeardownStageResult = 'done' | 'none' | 'failed'

export interface McpServerOAuthTeardownResult {
  /** 'done' = a DCR row was removed, 'none' = none matched (clean), 'failed' = threw. */
  dynamicClient: TeardownStageResult
  /** 'done' = grant rows were purged, 'none' = none matched (clean), 'failed' = threw. */
  grants: TeardownStageResult
}

export async function teardownMcpServerOAuthState(
  db: DbClient,
  encryptionKey: Buffer,
  dcrDeps: DcrDeps,
  input: { namespace: string; name: string; crUid: string },
  logger: Logger
): Promise<McpServerOAuthTeardownResult> {
  const { namespace, name, crUid } = input
  const result: McpServerOAuthTeardownResult = { dynamicClient: 'none', grants: 'none' }

  // DCR: single-statement claim+read. Deletes the row bound to this uid (or a legacy
  // row) and returns its RFC 7592 handle; a pending row or a row bound to a different
  // uid (a reinstall) is left intact. Only the actually-deleted row's client is revoked.
  try {
    const claimed = await claimDeleteDynamicClientForResource(
      db,
      encryptionKey,
      { ownerKind: 'mcpserver', serverNamespace: namespace, serverName: name },
      crUid
    )
    if (claimed.deleted) {
      result.dynamicClient = 'done'
      if (claimed.handle) {
        await bestEffortRfc7592Delete(
          dcrDeps,
          claimed.handle.registrationClientUri,
          claimed.handle.registrationAccessToken
        )
      }
      logger.info(
        { serverName: name, namespace, attemptedRemoteDelete: Boolean(claimed.handle) },
        'Revoked remote OAuth dynamic client on uninstall'
      )
    }
  } catch (err) {
    result.dynamicClient = 'failed'
    mcpServerUninstallTeardownFailuresTotal.inc({ stage: 'dynamic_client' })
    logger.error({ serverName: name, namespace, err }, 'Dynamic client cleanup failed on uninstall')
  }

  // Grants: purge this installation's rows (fenced by cr_uid + legacy). A reinstall's
  // grant (a different uid) survives.
  try {
    const purged = await deleteOAuthGrantsForServer(db, {
      recipeNamespace: namespace,
      recipeName: name,
      crUid,
    })
    if (purged > 0) {
      result.grants = 'done'
      logger.info(
        { serverName: name, namespace, count: purged },
        'Purged OAuth grants on uninstall'
      )
    }
  } catch (err) {
    result.grants = 'failed'
    mcpServerUninstallTeardownFailuresTotal.inc({ stage: 'oauth_grants' })
    logger.error({ serverName: name, namespace, err }, 'OAuth grants purge failed on uninstall')
  }

  return result
}
