import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as migration from '../017-model-step-checkpoints'
import { migrations } from '../index'

function beforeMigration() {
  const db = new Database(':memory:')
  for (const m of migrations) {
    if (m.name === migration.name) break
    m.up(db)
  }
  db.prepare(
    "INSERT INTO sessions(id,session_key,source,started_at,state) VALUES ('s','u:rpc:a:c','rpc',0,'idle')"
  ).run()
  db.prepare(
    "INSERT INTO messages(session_id,ordinal,role,content,timestamp,is_error) VALUES ('s',1,'user','hi',0,0)"
  ).run()
  return db
}

const tables = (db: Database.Database) =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE 'model_step_checkpoint%' ORDER BY name"
      )
      .all() as Array<{ name: string }>
  ).map(r => r.name)

const hasColumn = (db: Database.Database) =>
  (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).some(
    c => c.name === 'model_step_checkpoint_id'
  )

describe('migration 017 model-step checkpoints (#1043)', () => {
  it('is registered right after 016', () => {
    const names = migrations.map(m => m.name)
    expect(names.indexOf('017-model-step-checkpoints')).toBe(
      names.indexOf('016-pending-approval-authorization-scope') + 1
    )
  })

  it('up and down are idempotent and keep existing messages', () => {
    const db = beforeMigration()
    try {
      migration.up(db)
      migration.up(db)
      expect(tables(db)).toEqual(['model_step_checkpoint_entries', 'model_step_checkpoints'])
      expect(hasColumn(db)).toBe(true)
      expect(db.prepare('SELECT content, model_step_checkpoint_id FROM messages').get()).toEqual({
        content: 'hi',
        model_step_checkpoint_id: null,
      })

      migration.down(db)
      migration.down(db)
      expect(tables(db)).toEqual([])
      expect(hasColumn(db)).toBe(false)
      expect(db.prepare('SELECT content FROM messages').get()).toEqual({ content: 'hi' })

      migration.up(db)
      expect(hasColumn(db)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('rejects an unknown status and an unknown entry kind', () => {
    const db = beforeMigration()
    try {
      migration.up(db)
      const insert = (status: string) =>
        db
          .prepare(
            `INSERT INTO model_step_checkpoints (checkpoint_id, session_key, origin_turn_number,
             origin_task_id, version, status, provider, model, host_id, principal, claim_owner,
             claim_generation, created_at, updated_at)
             VALUES (?, 'k', 1, 't', 1, ?, 'p', 'm', 'h', 'u', 't', 0, 0, 0)`
          )
          .run(`cp-${status}`, status)
      expect(() => insert('open')).not.toThrow()
      expect(() => insert('paused')).toThrow(/CHECK/)
      expect(() =>
        db
          .prepare(
            "INSERT INTO model_step_checkpoint_entries (checkpoint_id, seq, kind, payload, created_at) VALUES ('cp-open', 1, 'note', '{}', 0)"
          )
          .run()
      ).toThrow(/CHECK/)
    } finally {
      db.close()
    }
  })
})
