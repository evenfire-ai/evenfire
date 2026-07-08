/**
 * Migration runner — applied by the worker thread at boot before accepting
 * any user query. Records each applied migration name in `migrations_meta`.
 *
 * Idempotent: re-running with no pending migrations is a no-op.
 */
import type { Database } from 'better-sqlite3'
import { migrations } from './migrations'

const META_TABLE = 'migrations_meta'

export interface MigrationRunResult {
  applied: string[]
  pending: string[]
}

export function runMigrations(db: Database): MigrationRunResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${META_TABLE} (
      name        TEXT PRIMARY KEY,
      applied_at  REAL NOT NULL
    );
  `)

  const knownRows = db.prepare(`SELECT name FROM ${META_TABLE}`).all() as Array<{ name: string }>
  const known = new Set(knownRows.map(r => r.name))

  const applied: string[] = []
  const insertMeta = db.prepare(`INSERT INTO ${META_TABLE} (name, applied_at) VALUES (?, ?)`)

  for (const migration of migrations) {
    if (known.has(migration.name)) continue
    const tx = db.transaction(() => {
      migration.up(db)
      insertMeta.run(migration.name, Date.now() / 1000)
    })
    tx.immediate()
    applied.push(migration.name)
  }

  const pending = migrations.map(m => m.name).filter(n => !known.has(n) && !applied.includes(n))

  return { applied, pending }
}
