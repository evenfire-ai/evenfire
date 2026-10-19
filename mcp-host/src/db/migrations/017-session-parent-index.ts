/**
 * Migration 017 — index the self-referencing `sessions.parent_session_id`.
 *
 * With `foreign_keys = ON`, deleting a session row checks that no other
 * session names it as its parent. Without an index on the child key that
 * check scans the whole table for every deleted row, so one retention-sweep
 * batch grows with the size of `sessions` instead of with its `limit`.
 */
import type { Database } from 'better-sqlite3'

export const name = '017-session-parent-index'

export function up(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id
      ON sessions(parent_session_id);
  `)
}

export function down(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_sessions_parent_session_id;`)
}
