import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as migration from '../015-session-model-selection-revision'
import * as deniedTools from '../016-session-denied-tools'
import { migrations } from '../index'

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    c => c.name
  )
}

function preMigrationDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of migrations) {
    if (m.name === migration.name) break
    m.up(db)
  }
  db.prepare(
    `INSERT INTO sessions (id, session_key, source, started_at) VALUES (?, ?, 'rpc', 0)`
  ).run('s-legacy', 'u:rpc:a:1')
  return db
}

describe('migration 015 — sessions.model_selection_revision', () => {
  it('is registered immediately before the denied-tools migration', () => {
    const names = migrations.map(item => item.name)
    const index = names.indexOf(migration.name)
    expect(names[index + 1]).toBe(deniedTools.name)
  })

  it('adds a NOT NULL revision that reads 0 for every pre-existing row', () => {
    const db = preMigrationDb()
    try {
      expect(tableColumns(db, 'sessions')).not.toContain('model_selection_revision')

      migration.up(db)
      expect(tableColumns(db, 'sessions')).toContain('model_selection_revision')

      const row = db
        .prepare('SELECT model_selection_revision AS revision FROM sessions WHERE id = ?')
        .get('s-legacy') as { revision: number }
      expect(row.revision).toBe(0)

      // The default keeps applying to rows inserted without the column, which is
      // what makes the CAS base of a brand-new session a defined 0.
      db.prepare(
        `INSERT INTO sessions (id, session_key, source, started_at) VALUES (?, ?, 'rpc', 0)`
      ).run('s-new', 'u:rpc:a:2')
      expect(
        (
          db
            .prepare('SELECT model_selection_revision AS revision FROM sessions WHERE id = ?')
            .get('s-new') as { revision: number }
        ).revision
      ).toBe(0)

      expect(() =>
        db
          .prepare(
            'INSERT INTO sessions (id, session_key, source, started_at, model_selection_revision) VALUES (?, ?, ?, 0, ?)'
          )
          .run('s-bad', 'u:rpc:a:3', 'rpc', null)
      ).toThrow()
    } finally {
      db.close()
    }
  })

  it('is idempotent when re-run and drops cleanly on down()', () => {
    const db = preMigrationDb()
    try {
      migration.up(db)
      migration.up(db)
      db.prepare('UPDATE sessions SET model_selection_revision = 7 WHERE id = ?').run('s-legacy')
      migration.up(db)
      expect(
        (
          db
            .prepare('SELECT model_selection_revision AS revision FROM sessions WHERE id = ?')
            .get('s-legacy') as { revision: number }
        ).revision
      ).toBe(7)

      migration.down(db)
      expect(tableColumns(db, 'sessions')).not.toContain('model_selection_revision')
      migration.down(db)
      expect(tableColumns(db, 'sessions')).not.toContain('model_selection_revision')
    } finally {
      db.close()
    }
  })
})
