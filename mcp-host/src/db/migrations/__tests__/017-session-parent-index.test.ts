import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrations } from '../index'

const NAME = '017-session-parent-index'

function indexedColumns(db: Database.Database, table: string): string[][] {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>
  return indexes.map(index =>
    (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map(
      column => column.name
    )
  )
}

describe('migration 017 — index on sessions(parent_session_id)', () => {
  it('is registered last and indexes the self-referencing parent key', () => {
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
      expect(indexedColumns(db, 'sessions')).not.toContainEqual(['parent_session_id'])

      migration.up(db)
      expect(indexedColumns(db, 'sessions')).toContainEqual(['parent_session_id'])
      // Liveness witness: the index was built over an existing row, which survives.
      expect(db.prepare('SELECT id, parent_session_id FROM sessions').all()).toEqual([
        { id: 's-1', parent_session_id: null },
      ])

      migration.down(db)
      expect(indexedColumns(db, 'sessions')).not.toContainEqual(['parent_session_id'])
    } finally {
      db.close()
    }
  })
})
