import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as migration from '../018-model-step-checkpoint-attachments'
import { migrations } from '../index'

function beforeMigration() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (m.name === migration.name) break
    m.up(db)
  }
  db.prepare(
    `INSERT INTO model_step_checkpoints (checkpoint_id, session_key, origin_turn_number,
     origin_task_id, version, status, provider, model, host_id, principal, claim_owner,
     claim_generation, created_at, updated_at)
     VALUES ('cp', 'k', 1, 't', 1, 'resumable', 'p', 'm', 'h', 'u', 't', 0, 0, 0)`
  ).run()
  return db
}

const hasTable = (db: Database.Database) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'model_step_checkpoint_attachments'")
    .get() !== undefined

const insertBytes = (db: Database.Database, checkpointId: string, bytes: Buffer) =>
  db
    .prepare(
      `INSERT INTO model_step_checkpoint_attachments
       (checkpoint_id, attachment_id, digest_hex, size_bytes, bytes, expires_at, created_at)
       VALUES (?, 'a1', 'd', ?, ?, 10, 0)`
    )
    .run(checkpointId, bytes.length, bytes)

describe('migration 018 model-step checkpoint attachments (#1043)', () => {
  it('is the last registered migration, right after 017', () => {
    const names = migrations.map(m => m.name)
    expect(names[names.length - 1]).toBe('018-model-step-checkpoint-attachments')
    expect(names[names.length - 2]).toBe('017-model-step-checkpoints')
  })

  it('up and down are idempotent', () => {
    const db = beforeMigration()
    try {
      migration.up(db)
      migration.up(db)
      expect(hasTable(db)).toBe(true)
      migration.down(db)
      migration.down(db)
      expect(hasTable(db)).toBe(false)
      migration.up(db)
      expect(hasTable(db)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('round-trips raw bytes and cascades with its checkpoint header', () => {
    const db = beforeMigration()
    try {
      migration.up(db)
      const bytes = Buffer.from([0, 255, 1, 254, 10, 13])
      insertBytes(db, 'cp', bytes)
      const row = db
        .prepare('SELECT bytes FROM model_step_checkpoint_attachments WHERE checkpoint_id = ?')
        .get('cp') as { bytes: Buffer }
      expect(Buffer.compare(row.bytes, bytes)).toBe(0)
      db.prepare("DELETE FROM model_step_checkpoints WHERE checkpoint_id = 'cp'").run()
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM model_step_checkpoint_attachments').get()
      ).toEqual({ n: 0 })
      expect(() => insertBytes(db, 'missing', bytes)).toThrow(/FOREIGN KEY/)
    } finally {
      db.close()
    }
  })
})
