/**
 * Migration 003 — partial index on `sessions.state` for the D.2 reaper.
 *
 * The boot-time processing reaper runs `SELECT ... FROM sessions WHERE
 * state = 'processing' LIMIT N` in a chunked loop. Without an index this is a
 * full table scan per chunk → O(N²/chunk) total, which (under a DoS spam of
 * processing sessions) could exhaust the pod's startupProbe budget and trigger
 * CrashLoopBackOff (security review D.2, P1).
 *
 * A PARTIAL index keyed on the reaper's exact predicate keeps the index tiny
 * (only the handful of rows actually in 'processing' at any moment) while
 * making each chunk SELECT an indexed lookup.
 */
import type { Database } from 'better-sqlite3'

export const name = '003-sessions-state-index'

export function up(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_processing
      ON sessions(state) WHERE state = 'processing';
  `)
}

export function down(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_sessions_processing;`)
}
