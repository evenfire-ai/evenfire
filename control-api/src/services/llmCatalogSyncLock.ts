import type { DbClient } from '../db.js'

/**
 * Advisory-lock key of the catalog sync. Every writer whose effect a sync run
 * must see all-or-nothing takes the same key: concurrent syncs (they would race
 * on INSERT) and the provider auto-enable policy toggle (a run must never read
 * the policy before a toggle and insert after it commits).
 *
 * Lives outside `llmCatalogSync.ts` so importing the key does not pull the sync
 * module (and its loaders) into every caller.
 */
export const SYNC_ADVISORY_LOCK_KEY = 'llm-catalog-sync-v1'

/**
 * Take the catalog-sync lock. Transaction-scoped: must run inside an open
 * transaction and is released on COMMIT/ROLLBACK. Waits for the holder; the
 * wait is bounded only by the session's statement_timeout.
 */
export async function acquireCatalogSyncLock(db: DbClient): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SYNC_ADVISORY_LOCK_KEY])
}
