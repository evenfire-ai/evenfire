/**
 * Migration 009 — indexes for paged session-summary catalogs.
 *
 * The desktop session catalog reads sessions by key prefix and projects
 * last-activity/turn-count summaries from messages. This migration adds the
 * supporting indexes without changing the already-shipped initial schema.
 */
import type { Database } from 'better-sqlite3'

export const name = '009-session-summary-indexes'

export function up(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp
      ON messages(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_session_turn_ordinal
      ON messages(session_id, turn_number, ordinal);
    DROP INDEX IF EXISTS idx_messages_turn;
  `)
}

export function down(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_messages_session_timestamp;
    DROP INDEX IF EXISTS idx_messages_session_turn_ordinal;
    CREATE INDEX IF NOT EXISTS idx_messages_turn
      ON messages(session_id, turn_number);
  `)
}
