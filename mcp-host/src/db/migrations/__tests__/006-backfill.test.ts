import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as m006 from '../006-sessions-cache-reported'
import { migrations } from '../index'

describe('migration 006 — cache_tokens_reported backfill', () => {
  it('seeds the flag to 1 for pre-existing sessions that had cache traffic, 0 otherwise', () => {
    const db = new Database(':memory:')
    // Build the pre-006 schema by applying every migration before 006.
    for (const mig of migrations) {
      if (mig.name === m006.name) break
      mig.up(db)
    }

    const insert = db.prepare(
      `INSERT INTO sessions (id, session_key, source, started_at, cache_read_tokens, cache_write_tokens)
       VALUES (?, ?, 'rpc', 0, ?, ?)`
    )
    insert.run('s-read', 'u:rpc:a:1', 5, 0) // cache read only
    insert.run('s-write', 'u:rpc:a:2', 0, 3) // cache write only
    insert.run('s-none', 'u:rpc:a:3', 0, 0) // no cache traffic

    // Apply the migration under test.
    m006.up(db)

    const flag = (id: string) =>
      (
        db.prepare('SELECT cache_tokens_reported AS r FROM sessions WHERE id = ?').get(id) as {
          r: number
        }
      ).r
    expect(flag('s-read')).toBe(1)
    expect(flag('s-write')).toBe(1)
    expect(flag('s-none')).toBe(0)
    db.close()
  })
})
