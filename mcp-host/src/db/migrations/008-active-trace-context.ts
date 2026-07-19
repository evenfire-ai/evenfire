/**
 * Migration 008 — durable correlation context for active turns and approvals.
 *
 * Context is nullable for existing rows and is deliberately absent from the
 * message history. Runtime persistence reads and writes both columns explicitly.
 * The data update repairs the historical request_id/task_id confusion wherever
 * the owning session still records its active task.
 */
import type { Database } from 'better-sqlite3'

export const name = '008-active-trace-context'

function hasColumn(db: Database, table: 'sessions' | 'pending_approvals', column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return columns.some(entry => entry.name === column)
}

export function up(db: Database): void {
  if (!hasColumn(db, 'sessions', 'active_trace_context')) {
    db.exec('ALTER TABLE sessions ADD COLUMN active_trace_context TEXT;')
  }
  if (!hasColumn(db, 'pending_approvals', 'trace_context')) {
    db.exec('ALTER TABLE pending_approvals ADD COLUMN trace_context TEXT;')
  }
  db.exec(`
    UPDATE pending_approvals
       SET task_id = (
         SELECT sessions.active_task_id
           FROM sessions
          WHERE sessions.id = pending_approvals.session_id
       )
     WHERE EXISTS (
       SELECT 1
         FROM sessions
        WHERE sessions.id = pending_approvals.session_id
          AND sessions.active_task_id IS NOT NULL
     );
  `)
}

export function down(db: Database): void {
  if (hasColumn(db, 'pending_approvals', 'trace_context')) {
    db.exec('ALTER TABLE pending_approvals DROP COLUMN trace_context;')
  }
  if (hasColumn(db, 'sessions', 'active_trace_context')) {
    db.exec('ALTER TABLE sessions DROP COLUMN active_trace_context;')
  }
}
