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
  /** Effective `PRAGMA synchronous` level: 'FULL' (barrier mode) or 'NORMAL'. */
  synchronous: 'FULL' | 'NORMAL'
}

export interface PragmaSetupOptions {
  /**
   * D3 (stateless-agents) — durability barrier. When true, `synchronous = FULL`
   * (per-commit WAL fsync) — durable against node/power loss: every WAL commit
   * fsyncs before the worker ACKs, so a host crash right after an acknowledged
   * turn-boundary write can no longer lose it. Enabled by the stateless
   * lifecycle (`CLERUM_STATELESS_LIFECYCLE=true`) or the explicit opt-in
   * `CLERUM_DB_BARRIER_MODE=full`.
   *
   * Durability comes SOLELY from `synchronous=FULL`. The WAL checkpoint stays
   * PASSIVE (WAL truncation only, NOT a durability mechanism) and its cadence
   * (`CLERUM_DB_CHECKPOINT_EVERY_WRITES`, default 100) is intentionally
   * unchanged — a per-turn PASSIVE checkpoint would add zero durability benefit.
   */
  barrierMode?: boolean
}

/**
 * Apply PRAGMAs and verify the WAL fallback path. Never throws — when the
 * filesystem rejects WAL we log a warning and continue with the journal mode
 * SQLite picked (typically `delete`).
 */
export function applyPragmas(db: Database, opts?: PragmaSetupOptions): PragmaSetupResult {
  const synchronous: 'FULL' | 'NORMAL' = opts?.barrierMode === true ? 'FULL' : 'NORMAL'
  // Order matters: synchronous + foreign_keys must apply after journal_mode.
  db.pragma('journal_mode = WAL')
  const journalMode = String(db.pragma('journal_mode', { simple: true }))
  db.pragma(`synchronous = ${synchronous}`)
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
    synchronous,
  }
}
