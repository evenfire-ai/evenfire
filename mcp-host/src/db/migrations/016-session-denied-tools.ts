/**
 * Migration 016 — durable tool denials (`sessions.denied_tools`).
 *
 * A denial used to live only on the in-memory conversation. After deny() the
 * session is Idle with no pending approval, so the LRU may evict it, and a
 * pod restart reconstructed the chat without the block. A native tool whose
 * approval override is false then ran with no card.
 *
 * The column is a JSON array of `{ tool, userId }`. NULL means no denials.
 * Existing rows stay NULL. No index: reads and writes are by primary key.
 */
import type { Database } from 'better-sqlite3'

export const name = '016-session-denied-tools'

function hasColumn(db: Database): boolean {
  return (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).some(
    row => row.name === 'denied_tools'
  )
}

export function up(db: Database): void {
  if (!hasColumn(db)) {
    db.exec(`ALTER TABLE sessions ADD COLUMN denied_tools TEXT;`)
  }
}

export function down(db: Database): void {
  if (hasColumn(db)) {
    db.exec('ALTER TABLE sessions DROP COLUMN denied_tools;')
  }
}
