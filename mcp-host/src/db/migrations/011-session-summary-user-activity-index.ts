/**
 * Migration 011 — align the session catalog index with its scoped sort.
 *
 * The original activity index did not lead with the authenticated user ID, so
 * SQLite preferred the session-key range index and sorted every matching row.
 * Leading with user_id lets a catalog page stream directly in activity order.
 */
import type { Database } from 'better-sqlite3'

export const name = '011-session-summary-user-activity-index'

export function up(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_sessions_summary_activity;
    CREATE INDEX idx_sessions_summary_activity
      ON sessions(user_id, COALESCE(last_activity_at, started_at) DESC, session_key ASC);
  `)
}

export function down(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_sessions_summary_activity;
    CREATE INDEX idx_sessions_summary_activity
      ON sessions(COALESCE(last_activity_at, started_at) DESC, session_key ASC);
  `)
}
