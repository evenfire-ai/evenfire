/**
 * Migration 004 — partial index on `sessions.state` for the D.8 awaiting-approval
 * reaper.
 *
 * The boot-time awaiting-approval reaper (F7 closure) runs
 * `SELECT ... FROM sessions WHERE state = 'awaiting_approval' AND NOT EXISTS
 * (live approval) LIMIT N` in a chunked loop. The D.2 partial index
 * (`idx_sessions_processing`) only covers `state = 'processing'`, so this query
 * would otherwise full-table-scan per chunk. A separate PARTIAL index keyed on
 * `state = 'awaiting_approval'` keeps it tiny (only sessions currently awaiting
 * approval) while making each chunk SELECT an indexed lookup — same anti-DoS
 * rationale as migration 003.
 *
 * The `NOT EXISTS` sub-select on `pending_approvals(session_id, expires_at)` is
 * already served by `idx_pending_approvals_session` / `idx_pending_approvals_expires`
 * from 001-initial-schema.
 */
import type { Database } from 'better-sqlite3'

export const name = '004-sessions-awaiting-approval-index'

export function up(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_awaiting_approval
      ON sessions(state) WHERE state = 'awaiting_approval';
  `)
}

export function down(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_sessions_awaiting_approval;`)
}
