/**
 * Migration 018 — one row per successful `memory_write`.
 *
 * A row says which file the memory tool wrote (`scope`, `relative_path`,
 * relative to that scope's root), for whom (`user_key`), how (`mode`) and the
 * sha256 of the content the write left in the file. A file whose sha256 equals
 * `content_sha256` of its latest row is exactly as the tool left it.
 *
 * Rows are inserted and never deleted; `id` is a plain rowid alias, so no
 * `sqlite_sequence` table is created. No index: nothing in the Host reads the
 * table.
 */
import type { Database } from 'better-sqlite3'

export const name = '018-memory-writes'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_writes (
      id             INTEGER PRIMARY KEY,
      user_key       TEXT NOT NULL,
      scope          TEXT NOT NULL CHECK (scope IN ('collective', 'user')),
      relative_path  TEXT NOT NULL,
      mode           TEXT NOT NULL CHECK (mode IN ('append', 'replace')),
      content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
      written_at     REAL NOT NULL
    );
  `)
}

export function down(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS memory_writes;`)
}
