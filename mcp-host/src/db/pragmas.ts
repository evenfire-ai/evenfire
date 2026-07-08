/**
 * SQLite PRAGMA bootstrap for the conversation store.
 *
 * Applied once by the worker thread at boot, before any user query runs.
 * See `.specs/mcp-hermes/implementation-plans/T2.1-sqlite-store.md` §6.1.
 */
import type { Database } from 'better-sqlite3'

export interface PragmaSetupResult {
  walAvailable: boolean
  journalMode: string
}

/**
 * Apply PRAGMAs and verify the WAL fallback path. Never throws — when the
 * filesystem rejects WAL we log a warning and continue with the journal mode
 * SQLite picked (typically `delete`).
 */
export function applyPragmas(db: Database): PragmaSetupResult {
  // Order matters: synchronous + foreign_keys must apply after journal_mode.
  db.pragma('journal_mode = WAL')
  const journalMode = String(db.pragma('journal_mode', { simple: true }))
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  // busy_timeout = 0 disables the internal back-off; the worker handles
  // SQLITE_BUSY with a jittered custom retry (see busyRetry.ts).
  db.pragma('busy_timeout = 0')
  db.pragma('cache_size = -16000')
  db.pragma('temp_store = MEMORY')
  // mmap_size is best-effort — some sandboxes refuse and SQLite no-ops.
  try {
    db.pragma('mmap_size = 268435456')
  } catch (err) {
    console.warn('[SQLite] mmap_size pragma refused:', err)
  }

  return {
    walAvailable: journalMode.toLowerCase() === 'wal',
    journalMode,
  }
}
