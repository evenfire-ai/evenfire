/**
 * Migration 017 — durable model-step checkpoints (#1043).
 *
 * `model_step_checkpoints` is one header per tool-use turn; its entries are
 * append-only in `model_step_checkpoint_entries` so a long turn never rewrites
 * its transcript. At most one non-terminal header exists per session. A final
 * assistant message written by a continuation carries the checkpoint id in
 * `messages.model_step_checkpoint_id`.
 */
import type { Database } from 'better-sqlite3'

export const name = '017-model-step-checkpoints'

function hasMessagesColumn(db: Database): boolean {
  return (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).some(
    row => row.name === 'model_step_checkpoint_id'
  )
}

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_step_checkpoints (
      checkpoint_id         TEXT PRIMARY KEY,
      session_key           TEXT NOT NULL,
      origin_turn_number    INTEGER NOT NULL,
      origin_task_id        TEXT NOT NULL,
      continuation_task_id  TEXT,
      version               INTEGER NOT NULL,
      status                TEXT NOT NULL CHECK (status IN
                              ('open','resumable','claimed','blocked','completed','abandoned')),
      provider              TEXT NOT NULL,
      model                 TEXT NOT NULL,
      host_id               TEXT NOT NULL,
      principal             TEXT NOT NULL,
      loop_state            TEXT,
      task_budget           TEXT,
      source_message        TEXT,
      claim_owner          TEXT NOT NULL,
      claim_generation      INTEGER NOT NULL,
      claim_expires_at      INTEGER,
      blocked_reason        TEXT,
      failed_at             INTEGER,
      expires_at            INTEGER,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_step_checkpoints_live_session
      ON model_step_checkpoints(session_key)
      WHERE status IN ('open','resumable','claimed','blocked');
    CREATE INDEX IF NOT EXISTS idx_model_step_checkpoints_status
      ON model_step_checkpoints(status, updated_at);

    CREATE TABLE IF NOT EXISTS model_step_checkpoint_entries (
      checkpoint_id  TEXT NOT NULL
                       REFERENCES model_step_checkpoints(checkpoint_id) ON DELETE CASCADE,
      seq            INTEGER NOT NULL,
      kind           TEXT NOT NULL CHECK (kind IN ('message','tool_dispatch','tool_result')),
      tool_call_id   TEXT,
      payload        TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id, seq)
    );
  `)
  if (!hasMessagesColumn(db)) {
    db.exec('ALTER TABLE messages ADD COLUMN model_step_checkpoint_id TEXT;')
  }
}

export function down(db: Database): void {
  if (hasMessagesColumn(db)) {
    db.exec('ALTER TABLE messages DROP COLUMN model_step_checkpoint_id;')
  }
  db.exec(`
    DROP TABLE IF EXISTS model_step_checkpoint_entries;
    DROP INDEX IF EXISTS idx_model_step_checkpoints_status;
    DROP INDEX IF EXISTS idx_model_step_checkpoints_live_session;
    DROP TABLE IF EXISTS model_step_checkpoints;
  `)
}
