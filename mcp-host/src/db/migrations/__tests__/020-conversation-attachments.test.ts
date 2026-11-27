import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as migration020 from '../020-conversation-attachments'
import { migrations } from '../index'

function openDbUpTo019(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (m.name === migration020.name) break
    m.up(db)
  }
  return db
}

function insertSessionRow(
  db: Database.Database,
  row: {
    id: string
    session_key: string
    state: string
    started_at: number
    parent_session_id?: string | null
    linked_user_id?: string | null
  }
): void {
  db.prepare(
    `INSERT INTO sessions (
      id, session_key, source, user_id, channel_type, channel_id,
      parent_session_id, started_at, last_activity_at,
      turn_count, message_count, tool_call_count,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cache_tokens_reported, state, approval_mode, linked_user_id
    ) VALUES (?, ?, 'slack', 'U1', 'slack', 'C1', ?, ?, ?, 1, 0, 0, 0, 0, 0, 0, 0, ?, 'manual', ?)`
  ).run(
    row.id,
    row.session_key,
    row.parent_session_id ?? null,
    row.started_at,
    row.started_at,
    row.state,
    row.linked_user_id ?? null
  )
}

describe('Migration 020 — conversation_attachments & partial unique session index (BR-T8 / V6)', () => {
  it('up() is idempotent, creates conversation_attachments and partial unique index, and allows rotated rows while blocking duplicate active rows', () => {
    const db = openDbUpTo019()
    try {
      migration020.up(db)
      // Idempotent second run must not throw.
      migration020.up(db)

      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_attachments'"
          )
          .all() as Array<{ name: string }>
      ).map(r => r.name)
      expect(tables).toEqual(['conversation_attachments'])

      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
          name: string
        }>
      ).map(r => r.name)
      expect(indexes).toContain('idx_sessions_active_session_key')
      expect(indexes).toContain('idx_sessions_linked_user_id')
      expect(indexes).not.toContain('idx_sessions_session_key')

      const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
        c => c.name
      )
      expect(cols).toContain('linked_user_id')

      // Rotated ended + active session under the same session_key succeeds.
      insertSessionRow(db, {
        id: 'sess-ended-1',
        session_key: 'U1:slack:C1:default',
        state: 'ended',
        started_at: 100,
        linked_user_id: 'linked-a',
      })
      insertSessionRow(db, {
        id: 'sess-active-1',
        session_key: 'U1:slack:C1:default',
        state: 'idle',
        started_at: 200,
        linked_user_id: 'linked-b',
      })

      // Liveness witness: second active session under the same session_key fails UNIQUE constraint.
      expect(() =>
        insertSessionRow(db, {
          id: 'sess-active-2',
          session_key: 'U1:slack:C1:default',
          state: 'processing',
          started_at: 300,
          linked_user_id: 'linked-c',
        })
      ).toThrow(/UNIQUE constraint failed/)
    } finally {
      db.close()
    }
  })

  it('down() succeeds cleanly under PRAGMA foreign_keys = ON with rotated sessions, parent_session_id FK chain, and multi-ended rows', () => {
    const db = openDbUpTo019()
    try {
      migration020.up(db)

      // Key 1: ended -> ended (FK to first) -> active (FK to second). Active row must survive.
      insertSessionRow(db, {
        id: 'k1-ended-old',
        session_key: 'U1:slack:C1:default',
        state: 'ended',
        started_at: 100,
        linked_user_id: 'linked-a',
      })
      insertSessionRow(db, {
        id: 'k1-ended-mid',
        session_key: 'U1:slack:C1:default',
        state: 'ended',
        started_at: 200,
        parent_session_id: 'k1-ended-old',
        linked_user_id: 'linked-b',
      })
      insertSessionRow(db, {
        id: 'k1-active',
        session_key: 'U1:slack:C1:default',
        state: 'idle',
        started_at: 300,
        parent_session_id: 'k1-ended-mid',
        linked_user_id: 'linked-c',
      })

      // Key 2: multiple ended rows only (with parent_session_id FK chain). Newest ended row must survive.
      insertSessionRow(db, {
        id: 'k2-ended-1',
        session_key: 'U2:slack:C2:default',
        state: 'ended',
        started_at: 100,
        linked_user_id: 'linked-a',
      })
      insertSessionRow(db, {
        id: 'k2-ended-2',
        session_key: 'U2:slack:C2:default',
        state: 'ended',
        started_at: 250,
        parent_session_id: 'k2-ended-1',
        linked_user_id: 'linked-b',
      })

      // Must succeed with PRAGMA foreign_keys = ON!
      expect(db.pragma('foreign_keys', { simple: true }) as number).toBe(1)
      migration020.down(db)

      const remaining = db
        .prepare(
          'SELECT id, session_key, state, parent_session_id FROM sessions ORDER BY session_key ASC'
        )
        .all() as Array<{
        id: string
        session_key: string
        state: string
        parent_session_id: string | null
      }>
      expect(remaining).toEqual([
        {
          id: 'k1-active',
          session_key: 'U1:slack:C1:default',
          state: 'idle',
          parent_session_id: null,
        },
        {
          id: 'k2-ended-2',
          session_key: 'U2:slack:C2:default',
          state: 'ended',
          parent_session_id: null,
        },
      ])

      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
          name: string
        }>
      ).map(r => r.name)
      expect(indexes).toContain('idx_sessions_session_key')
      expect(indexes).not.toContain('idx_sessions_active_session_key')

      const attTable = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_attachments'"
        )
        .get()
      expect(attTable).toBeUndefined()

      const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
        c => c.name
      )
      expect(cols).not.toContain('linked_user_id')
    } finally {
      db.close()
    }
  })
})
