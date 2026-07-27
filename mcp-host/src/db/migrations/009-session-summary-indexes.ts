/**
 * Migration 009 — indexes for paged session-summary catalogs.
 *
 * The desktop session catalog reads sessions by key prefix and projects
 * last-activity/turn-count summaries from messages. Existing databases need the
 * same supporting indexes fresh installs get from migration 001.
 */
import type { Database } from 'better-sqlite3'

export const name = '009-session-summary-indexes'

export function up(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp
      ON messages(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_session_turn_ordinal
      ON messages(session_id, turn_number, ordinal);
  `)
}

export function down(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_messages_session_timestamp;
    DROP INDEX IF EXISTS idx_messages_session_turn_ordinal;
  `)
}
