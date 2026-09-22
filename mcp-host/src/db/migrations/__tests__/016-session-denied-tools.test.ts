import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as migration from '../016-session-denied-tools'
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

describe('migration 016 — sessions.denied_tools', () => {
  it('appends last to the ordered migration list', () => {
    expect(migrations[migrations.length - 1]?.name).toBe(migration.name)
  })

  it('adds a nullable column that reads null for a pre-existing row', () => {
    const db = preMigrationDb()
    try {
      expect(tableColumns(db, 'sessions')).not.toContain('denied_tools')
      migration.up(db)
      expect(tableColumns(db, 'sessions')).toContain('denied_tools')
      const row = db
        .prepare('SELECT denied_tools AS denied FROM sessions WHERE id = ?')
        .get('s-legacy') as { denied: string | null }
      expect(row.denied).toBeNull()
      migration.up(db)
      expect(tableColumns(db, 'sessions').filter(name => name === 'denied_tools')).toEqual([
        'denied_tools',
      ])
    } finally {
      db.close()
    }
  })
})
