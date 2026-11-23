/**
 * Migration 019 — stored approval mode (`sessions.approval_mode`).
 *
 * A new or pre-existing session reads `manual`. The column stores `manual`,
 * `auto`, or `allow_all`; reconstruct maps any other value back to `manual`.
 * No index: reads and writes are by primary key.
 */
import type { Database } from 'better-sqlite3'

export const name = '019-sessions-approval-mode'

function hasColumn(db: Database): boolean {
  return (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).some(
    row => row.name === 'approval_mode'
  )
}

export function up(db: Database): void {
  if (!hasColumn(db)) {
    db.exec(`ALTER TABLE sessions ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'manual';`)
  }
}

export function down(db: Database): void {
  if (hasColumn(db)) {
    db.exec('ALTER TABLE sessions DROP COLUMN approval_mode;')
  }
}
