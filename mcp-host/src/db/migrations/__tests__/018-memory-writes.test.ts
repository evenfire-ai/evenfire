import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrations } from '../index'

const NAME = '018-memory-writes'
const HASH = 'a'.repeat(64)

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
      name: string
    }>
  ).map(row => row.name)
}

describe('migration 018 — memory_writes', () => {
  it('is registered last, creates the table over existing data, and down drops it', () => {
    const names = migrations.map(m => m.name)
    expect(names.at(-1)).toBe(NAME)
    const migration = migrations.find(m => m.name === NAME)!

    const db = new Database(':memory:')
    try {
      for (const m of migrations) {
        if (m.name === NAME) break
        m.up(db)
      }
      db.prepare(
        `INSERT INTO sessions (id, session_key, source, started_at) VALUES ('s-1', 'u:rpc:a:1', 'rpc', 0)`
      ).run()
      expect(tableNames(db)).not.toContain('memory_writes')

      migration.up(db)
      expect(tableNames(db)).toContain('memory_writes')
      // Liveness witness: the existing session row survives the migration.
      expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 's-1' }])
      // A plain rowid alias: no AUTOINCREMENT, so inserts add no sqlite_sequence row.
      const ddl = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_writes'`)
        .get() as { sql: string }
      expect(ddl.sql).toContain('id             INTEGER PRIMARY KEY,')
      expect(ddl.sql).not.toContain('AUTOINCREMENT')

      migration.down(db)
      expect(tableNames(db)).not.toContain('memory_writes')
    } finally {
      db.close()
    }
  })

  it('refuses a mode, a scope or a hash outside the CHECK constraints', () => {
    const db = new Database(':memory:')
    try {
      for (const m of migrations) m.up(db)
      const insert = db.prepare(
        `INSERT INTO memory_writes (user_key, scope, relative_path, mode, content_sha256, written_at)
         VALUES (@user_key, @scope, @relative_path, @mode, @content_sha256, @written_at)`
      )
      const valid = {
        user_key: 'u1',
        scope: 'user',
        relative_path: 'memory/notes.md',
        mode: 'append',
        content_sha256: HASH,
        written_at: 1,
      }
      // Witness: a valid insert succeeds and is read back.
      insert.run(valid)
      expect(
        db.prepare('SELECT user_key, scope, relative_path, mode FROM memory_writes').all()
      ).toEqual([
        { user_key: 'u1', scope: 'user', relative_path: 'memory/notes.md', mode: 'append' },
      ])
      expect(() => insert.run({ ...valid, mode: 'x' })).toThrow(/CHECK constraint failed/)
      expect(() => insert.run({ ...valid, scope: 'x' })).toThrow(/CHECK constraint failed/)
      expect(() => insert.run({ ...valid, content_sha256: 'a'.repeat(10) })).toThrow(
        /CHECK constraint failed/
      )
      expect(db.prepare('SELECT COUNT(*) AS n FROM memory_writes').get()).toEqual({ n: 1 })
      expect(
        db.prepare(`SELECT name FROM sqlite_sequence WHERE name = 'memory_writes'`).all()
      ).toEqual([])
    } finally {
      db.close()
    }
  })
})
