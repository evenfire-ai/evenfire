/**
 * Migration 002 — add `active_task_id` to `sessions` (D.1).
 *
 * Lets the desktop client learn, from a single `GET /v1/runtime/sessions`
 * call, which task is currently in flight for a chat (to re-subscribe its
 * progress stream). The column is the durable mirror of the in-RAM
 * `Conversation.activeTaskId`; it is set on turn start and cleared on any
 * terminal transition (complete/fail/cancel).
 *
 * See `.specs/feat-feedback-fire-forget-comeback/implementation-plans/D1-sessions-active-task-id.md`.
 */
import type { Database } from 'better-sqlite3'

export const name = '002-active-task-id'

export function up(db: Database): void {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN active_task_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_sessions_active_task
      ON sessions(active_task_id) WHERE active_task_id IS NOT NULL;
  `)
}

export function down(db: Database): void {
  // better-sqlite3 v11 ships SQLite 3.42+, where DROP COLUMN is supported.
  // The index must be dropped first. No FTS triggers reference sessions, so
  // the column drop is safe (verified in 001-initial-schema).
  db.exec(`
    DROP INDEX IF EXISTS idx_sessions_active_task;
    ALTER TABLE sessions DROP COLUMN active_task_id;
  `)
}
