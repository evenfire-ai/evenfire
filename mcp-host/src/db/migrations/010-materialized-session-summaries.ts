/**
 * Migration 010 — materialize the fields used by the paged session catalog.
 *
 * Computing last activity, visible messages, and distinct turns from the
 * messages table made every catalog page proportional to the user's complete
 * transcript history. Backfill the summaries once, then maintain them on the
 * write path so catalog reads only scan session rows.
 */
import type { Database } from 'better-sqlite3'

export const name = '010-materialized-session-summaries'

export function up(db: Database): void {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN last_activity_at REAL;
    ALTER TABLE sessions ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;

    UPDATE sessions
       SET last_activity_at = MAX(
             started_at,
             COALESCE(
               (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = sessions.id),
               started_at
             )
           ),
           turn_count = (
             SELECT COUNT(DISTINCT m.turn_number)
               FROM messages m
              WHERE m.session_id = sessions.id
                AND m.turn_number IS NOT NULL
           ),
           message_count = (
             SELECT COUNT(*)
               FROM messages m
              WHERE m.session_id = sessions.id
                AND (
                  m.role = 'user'
                  OR (m.role = 'assistant' AND m.tool_calls IS NULL)
                )
           );

    CREATE INDEX IF NOT EXISTS idx_sessions_summary_activity
      ON sessions(COALESCE(last_activity_at, started_at) DESC, session_key ASC);
  `)
}

export function down(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_sessions_summary_activity;
    UPDATE sessions
       SET message_count = (
             SELECT COUNT(*)
               FROM messages m
              WHERE m.session_id = sessions.id
           );
    ALTER TABLE sessions DROP COLUMN turn_count;
    ALTER TABLE sessions DROP COLUMN last_activity_at;
  `)
}
