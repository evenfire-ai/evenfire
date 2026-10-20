import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as migration from '../018-model-step-checkpoints'
import { runMigrations } from '../../migrate'
import { dispatchModelStepCheckpointOp } from '../../worker/modelStepCheckpointOps'
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

describe('migration 018 model-step checkpoints (#1043)', () => {
  it('C-4: upgrades the 09ffe61bb preview schema and opens a checkpoint', () => {
    const db = beforeMigration()
    try {
      // The 017-model-step-checkpoints schema at 09ffe61bb, before source_message.
      db.exec(`
        CREATE TABLE model_step_checkpoints (
          checkpoint_id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL,
          origin_turn_number INTEGER NOT NULL,
          origin_task_id TEXT NOT NULL,
          continuation_task_id TEXT,
          version INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN
            ('open','resumable','claimed','blocked','completed','abandoned')),
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          host_id TEXT NOT NULL,
          principal TEXT NOT NULL,
          loop_state TEXT,
          task_budget TEXT,
          claim_owner TEXT NOT NULL,
          claim_generation INTEGER NOT NULL,
          claim_expires_at INTEGER,
          blocked_reason TEXT,
          failed_at INTEGER,
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_model_step_checkpoints_live_session
          ON model_step_checkpoints(session_key)
          WHERE status IN ('open','resumable','claimed','blocked');
        CREATE INDEX idx_model_step_checkpoints_status
          ON model_step_checkpoints(status, updated_at);
        CREATE TABLE model_step_checkpoint_entries (
          checkpoint_id TEXT NOT NULL
            REFERENCES model_step_checkpoints(checkpoint_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('message','tool_dispatch','tool_result')),
          tool_call_id TEXT,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (checkpoint_id, seq)
        );
        ALTER TABLE messages ADD COLUMN model_step_checkpoint_id TEXT;
        CREATE TABLE migrations_meta (name TEXT PRIMARY KEY, applied_at REAL NOT NULL);
      `)
      const markApplied = db.prepare('INSERT INTO migrations_meta VALUES (?, 0)')
      for (const m of migrations) {
        if (m.name === migration.name) break
        markApplied.run(m.name)
      }
      markApplied.run('017-model-step-checkpoints')
      db.prepare(
        `
        INSERT INTO model_step_checkpoints
          (checkpoint_id, session_key, origin_turn_number, origin_task_id, version, status,
           provider, model, host_id, principal, claim_owner, claim_generation, created_at, updated_at)
        VALUES ('preview', 'preview-session', 1, 'preview-task', 1, 'abandoned',
                'claude', 'preview-model', 'host', 'user', 'preview-task', 0, 0, 0)
      `
      ).run()

      expect(runMigrations(db)).toEqual({
        applied: ['018-model-step-checkpoints', '019-model-step-checkpoint-attachments'],
        pending: [],
      })
      const sourceMessage = JSON.stringify({ id: 'message-1', content: 'continue the turn' })
      expect(
        dispatchModelStepCheckpointOp(
          {
            kind: 'model_step_checkpoint_open',
            header: {
              checkpointId: 'upgraded',
              sessionKey: 'u:rpc:a:c',
              originTurnNumber: 1,
              originTaskId: 'task-1',
              provider: 'claude',
              model: 'turn-start-model',
              hostId: 'host',
              principal: 'user',
              loopState: null,
              taskBudget: null,
              sourceMessage,
            },
            entries: [
              {
                kind: 'message',
                toolCallId: null,
                payload: JSON.stringify({ role: 'user', content: 'hi' }),
              },
            ],
            now: 1000,
          },
          db
        )
      ).toEqual({ applied: true })
      expect(
        db
          .prepare(
            'SELECT checkpoint_id, status, source_message FROM model_step_checkpoints ORDER BY checkpoint_id'
          )
          .all()
      ).toEqual([
        { checkpoint_id: 'preview', status: 'abandoned', source_message: null },
        { checkpoint_id: 'upgraded', status: 'open', source_message: sourceMessage },
      ])
      expect(
        db
          .prepare(
            "SELECT seq, kind FROM model_step_checkpoint_entries WHERE checkpoint_id = 'upgraded'"
          )
          .all()
      ).toEqual([{ seq: 1, kind: 'message' }])
      expect(runMigrations(db)).toEqual({ applied: [], pending: [] })
      migration.up(db)
      expect(db.prepare('SELECT content FROM messages').get()).toEqual({ content: 'hi' })
    } finally {
      db.close()
    }
  })

  it('is registered right after 017', () => {
    const names = migrations.map(m => m.name)
    expect(names.indexOf('018-model-step-checkpoints')).toBe(
      names.indexOf('017-session-parent-index') + 1
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
