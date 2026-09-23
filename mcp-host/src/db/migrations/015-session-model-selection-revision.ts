/**
 * Migration 015 — durable revision counter for the per-session model selection
 * (`sessions.model_selection_revision`, issue #654 §4.4).
 *
 * The selection itself lives in `model_selections` (migration 007). This column
 * is the monotonic revision of that row and exists to make the selection write a
 * compare-and-swap: `POST /v1/runtime/model` may carry `expectedRevision`, and
 * the write lands only while the stored revision still equals it. A write that
 * was ordered behind a newer one — a retry after a client timeout, two replicas,
 * a second device on the same chat — is then rejected with
 * `model_selection_conflict` instead of silently overwriting the winner.
 *
 * A counter, not a hash or a timestamp: the writer only compares equality, so
 * the value merely has to change on every accepted write. EVERY write bumps it,
 * including the legacy unconditional path (no `expectedRevision`), which is what
 * makes a straggler detectable by the time it arrives.
 *
 * `INTEGER NOT NULL DEFAULT 0` is a metadata-only change for SQLite: every
 * existing row reads 0, which is the base revision of that session's first CAS
 * write. No backfill and no index — the CAS reads and writes the row by primary
 * key, so no query here filters on the revision.
 */
import type { Database } from 'better-sqlite3'

export const name = '015-session-model-selection-revision'

function hasColumn(db: Database): boolean {
  return (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).some(
    row => row.name === 'model_selection_revision'
  )
}

export function up(db: Database): void {
  // SQLite has no `ADD COLUMN IF NOT EXISTS`; the guard keeps a re-run (a
  // half-applied manual repair, or a test that calls `up()` twice) idempotent
  // instead of throwing "duplicate column name".
  if (!hasColumn(db)) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN model_selection_revision INTEGER NOT NULL DEFAULT 0;
    `)
  }
}

export function down(db: Database): void {
  if (hasColumn(db)) {
    // better-sqlite3 v11 ships SQLite 3.42+, where DROP COLUMN is supported.
    // No index or trigger references model_selection_revision.
    db.exec('ALTER TABLE sessions DROP COLUMN model_selection_revision;')
  }
}
