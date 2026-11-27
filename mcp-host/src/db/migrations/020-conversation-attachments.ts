/**
 * Migration 020 — conversation_attachments table, partial active-session unique
 * index (`WHERE state != 'ended'`), and nullable `sessions.linked_user_id`.
 *
 * Issue #1640 (`X2`):
 * - `conversation_attachments` is keyed by `(session_key, linked_user_id)` with
 *   NO `NOT NULL` foreign key to `sessions(id)` so Turn-1 `/ingest` succeeds
 *   under `PRAGMA foreign_keys = ON` before any `sessions` row exists (`S24`).
 * - Replaces unconditional `idx_sessions_session_key` with partial unique index
 *   `idx_sessions_active_session_key ON sessions(session_key) WHERE state != 'ended'`
 *   so identity-change session rotation can end User A's session and insert
 *   User B's fresh active session under the same `session_key` (`S71`), while
 *   preserving live `state = 'idle'` chats after cancel-during-approval (`S77`).
 * - Adds nullable `sessions.linked_user_id TEXT` + partial index for external
 *   channel session ownership and linked-user FTS isolation (`S68`, `S83`).
 */
import type { Database } from 'better-sqlite3'

export const name = '020-conversation-attachments'

function hasLinkedUserIdColumn(db: Database): boolean {
  return (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).some(
    row => row.name === 'linked_user_id'
  )
}

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_attachments (
      attachment_id          TEXT PRIMARY KEY,
      session_key            TEXT NOT NULL,
      linked_user_id         TEXT NOT NULL,
      provider_event_id      TEXT NOT NULL,
      provider_attachment_id TEXT NOT NULL,
      storage_rel_path       TEXT NOT NULL,
      sha256                 TEXT NOT NULL,
      byte_length            INTEGER NOT NULL,
      file_reference_json    TEXT NOT NULL,
      width                  INTEGER,
      height                 INTEGER,
      visual_valid           INTEGER NOT NULL DEFAULT 0 CHECK (visual_valid IN (0, 1)),
      created_at             REAL NOT NULL,
      expires_at             REAL NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'expired', 'deleted'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_attachments_idempotency
      ON conversation_attachments(session_key, linked_user_id, provider_event_id, provider_attachment_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_attachments_owner
      ON conversation_attachments(session_key, linked_user_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_attachments_expires
      ON conversation_attachments(status, expires_at);

    DROP INDEX IF EXISTS idx_sessions_session_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_session_key
      ON sessions(session_key) WHERE state != 'ended';
  `)

  if (!hasLinkedUserIdColumn(db)) {
    db.exec(`ALTER TABLE sessions ADD COLUMN linked_user_id TEXT;`)
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_linked_user_id
      ON sessions(linked_user_id) WHERE linked_user_id IS NOT NULL;
  `)
}

export function down(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_sessions_linked_user_id;
    DROP INDEX IF EXISTS idx_sessions_active_session_key;

    -- Deduplicate rotated rows sharing a session_key before restoring the
    -- unconditional unique index, clearing parent_session_id references first
    -- so PRAGMA foreign_keys = ON cannot fail with a FK violation.
    WITH ranked_sessions AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY session_key
               ORDER BY CASE WHEN state != 'ended' THEN 0 ELSE 1 END,
                        started_at DESC,
                        rowid DESC
             ) AS rn
        FROM sessions
    ),
    duplicate_sessions AS (
      SELECT id FROM ranked_sessions WHERE rn > 1
    )
    UPDATE sessions
       SET parent_session_id = NULL
     WHERE parent_session_id IN (SELECT id FROM duplicate_sessions);

    WITH ranked_sessions AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY session_key
               ORDER BY CASE WHEN state != 'ended' THEN 0 ELSE 1 END,
                        started_at DESC,
                        rowid DESC
             ) AS rn
        FROM sessions
    )
    DELETE FROM sessions
     WHERE id IN (SELECT id FROM ranked_sessions WHERE rn > 1);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_key
      ON sessions(session_key);
    DROP TABLE IF EXISTS conversation_attachments;
  `)
  if (hasLinkedUserIdColumn(db)) {
    db.exec('ALTER TABLE sessions DROP COLUMN linked_user_id;')
  }
}
