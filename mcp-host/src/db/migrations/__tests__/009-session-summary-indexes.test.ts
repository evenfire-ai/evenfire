import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as m009 from '../009-session-summary-indexes'
import { migrations } from '../index'

function indexNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'idx_messages_turn',
              'idx_messages_session_timestamp',
              'idx_messages_session_turn_ordinal'
            )
          ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).map(row => row.name)
}

describe('migration 009 — session summary indexes', () => {
  it('replaces the legacy turn index and supports down/up replay', () => {
    const db = new Database(':memory:')
    for (const migration of migrations) {
      if (migration.name === m009.name) break
      migration.up(db)
    }

    expect(indexNames(db)).toEqual(['idx_messages_turn'])

    m009.up(db)
    m009.up(db)
    expect(indexNames(db)).toEqual([
      'idx_messages_session_timestamp',
      'idx_messages_session_turn_ordinal',
    ])

    m009.down(db)
    expect(indexNames(db)).toEqual(['idx_messages_turn'])

    m009.up(db)
    expect(indexNames(db)).toEqual([
      'idx_messages_session_timestamp',
      'idx_messages_session_turn_ordinal',
    ])
    db.close()
  })
})
