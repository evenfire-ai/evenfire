/**
 * Migration 001 — initial schema for the SQLite ConversationStore.
 *
 * Layout follows the Hermes `hermes_state.py` reference adapted to mcp-host's
 * Conversation/Turn/PendingApproval model. See
 * `.specs/mcp-hermes/implementation-plans/T2.1-sqlite-store.md` §6.
 */
import type { Database } from 'better-sqlite3'

export const name = '001-initial-schema'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                          TEXT PRIMARY KEY,
      session_key                 TEXT NOT NULL,
      source                      TEXT NOT NULL,
      user_id                     TEXT,
      team_id                     TEXT,
      channel_type                TEXT,
      channel_id                  TEXT,
      thread_id                   TEXT,
      model                       TEXT,
      system_prompt_stable_hash   TEXT,
      parent_session_id           TEXT REFERENCES sessions(id),
      started_at                  REAL NOT NULL,
      ended_at                    REAL,
      end_reason                  TEXT,
      message_count               INTEGER NOT NULL DEFAULT 0,
      tool_call_count             INTEGER NOT NULL DEFAULT 0,
      input_tokens                INTEGER NOT NULL DEFAULT 0,
      output_tokens               INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens           INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens          INTEGER NOT NULL DEFAULT 0,
      title                       TEXT,
      state                       TEXT NOT NULL DEFAULT 'idle'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_key
      ON sessions(session_key);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id
      ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_team_id
      ON sessions(team_id) WHERE team_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_ended_at
      ON sessions(ended_at) WHERE ended_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_started_at
      ON sessions(started_at);

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ordinal         INTEGER NOT NULL,
      role            TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
      content         TEXT,
      content_parts   TEXT,
      tool_call_id    TEXT,
      tool_calls      TEXT,
      tool_name       TEXT,
      timestamp       REAL NOT NULL,
      token_count     INTEGER,
      finish_reason   TEXT,
      spillover_ref   TEXT,
      is_error        INTEGER NOT NULL DEFAULT 0,
      turn_number     INTEGER,
      UNIQUE(session_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_messages_spillover
      ON messages(spillover_ref) WHERE spillover_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp
      ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS pending_approvals (
      request_id        TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      task_id           TEXT NOT NULL,
      tool_name         TEXT NOT NULL,
      tool_call_id      TEXT NOT NULL,
      parameters        TEXT NOT NULL,
      description       TEXT NOT NULL,
      context_snapshot  TEXT NOT NULL,
      completed_results TEXT,
      intent_summary    TEXT,
      source_message    TEXT,
      registered_at     REAL NOT NULL,
      expires_at        REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_session
      ON pending_approvals(session_id);
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_task
      ON pending_approvals(task_id);
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_expires
      ON pending_approvals(expires_at);

    -- Cross-plan discovery T3.1 -> T2.1: the original schema declared
    -- user_id/channel_type as UNINDEXED columns alongside the indexed
    -- content. With content="messages", FTS5 builds internal sync triggers
    -- that alias the content table as T and reference every declared
    -- column by name -- T.user_id does NOT exist on the messages table,
    -- so every MATCH query failed with "no such column: T.user_id". The
    -- columns were not load-bearing -- searchMessages always JOINs to
    -- sessions for those values. Removed.
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    -- External-content FTS5 tables expose a special "delete" command to
    -- remove rows; the plain DELETE FROM messages_fts WHERE rowid syntax
    -- also works on modern SQLite. We use the command form to stay
    -- portable across SQLite builds.
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `)
}

export function down(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS messages_fts_update;
    DROP TRIGGER IF EXISTS messages_fts_delete;
    DROP TRIGGER IF EXISTS messages_fts_insert;
    DROP TABLE IF EXISTS messages_fts;
    DROP TABLE IF EXISTS pending_approvals;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS sessions;
  `)
}
