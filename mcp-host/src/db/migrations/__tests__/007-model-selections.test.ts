import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as m007 from '../007-sessions-model-selections'
import { migrations } from '../index'

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    c => c.name
  )
}

describe('migration 007 — sessions.model_selections', () => {
  it('adds a nullable model_selections column that reads back NULL for existing rows', () => {
    const db = new Database(':memory:')
    for (const mig of migrations) {
      if (mig.name === m007.name) break
      mig.up(db)
    }
    // Pre-007 row (no model_selections).
    db.prepare(
      `INSERT INTO sessions (id, session_key, source, started_at) VALUES (?, ?, 'rpc', 0)`
    ).run('s-old', 'u:rpc:a:1')

    expect(tableColumns(db, 'sessions')).not.toContain('model_selections')
    m007.up(db)
    expect(tableColumns(db, 'sessions')).toContain('model_selections')

    const row = db
      .prepare('SELECT model_selections AS ms FROM sessions WHERE id = ?')
      .get('s-old') as {
      ms: string | null
    }
    expect(row.ms).toBeNull()

    // Round-trips a JSON map on a new write.
    db.prepare(
      `INSERT INTO sessions (id, session_key, source, started_at, model_selections) VALUES (?, ?, 'rpc', 0, ?)`
    ).run('s-new', 'u:rpc:a:2', JSON.stringify({ claude: 'claude-haiku-4-5' }))
    const w = db
      .prepare('SELECT model_selections AS ms FROM sessions WHERE id = ?')
      .get('s-new') as {
      ms: string
    }
    expect(JSON.parse(w.ms)).toEqual({ claude: 'claude-haiku-4-5' })
    db.close()
  })

  it('down() drops the column', () => {
    const db = new Database(':memory:')
    for (const mig of migrations) {
      mig.up(db)
      if (mig.name === m007.name) break
    }
    expect(tableColumns(db, 'sessions')).toContain('model_selections')
    m007.down(db)
    expect(tableColumns(db, 'sessions')).not.toContain('model_selections')
    db.close()
  })
})
