/**
 * Migration 018 — bytes of inline file attachments held for a model-step
 * continuation (#1043).
 *
 * A turn's inline uploaded files live only in process memory; a continuation
 * after a restart would otherwise answer `bytes_unavailable_after_restart`.
 * Rows are written only when a checkpoint becomes `resumable`, expire after a
 * short TTL (default 1 h, `expires_at`), and are deleted as soon as their
 * checkpoint leaves `resumable`/`claimed`. The bytes are the raw upload,
 * unredacted and unencrypted, which is why the TTL is short.
 */
import type { Database } from 'better-sqlite3'

export const name = '018-model-step-checkpoint-attachments'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_step_checkpoint_attachments (
      checkpoint_id  TEXT NOT NULL
                       REFERENCES model_step_checkpoints(checkpoint_id) ON DELETE CASCADE,
      attachment_id  TEXT NOT NULL,
      digest_hex     TEXT NOT NULL,
      size_bytes     INTEGER NOT NULL,
      bytes          BLOB NOT NULL,
      expires_at     INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id, attachment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_model_step_checkpoint_attachments_expires
      ON model_step_checkpoint_attachments(expires_at);
  `)
}

export function down(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_model_step_checkpoint_attachments_expires;
    DROP TABLE IF EXISTS model_step_checkpoint_attachments;
  `)
}
