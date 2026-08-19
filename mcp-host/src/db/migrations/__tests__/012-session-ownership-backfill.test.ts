import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrations } from '../index'

const MIGRATION_NAME = '012-session-ownership-backfill'

describe('migration 012 — session ownership backfill', () => {
  it('repairs only legacy owners proven by the exact structured session-key suffix', () => {
    const migration = migrations.find(candidate => candidate.name === MIGRATION_NAME)
    expect(migration, `${MIGRATION_NAME} must be registered`).toBeDefined()

    const db = new Database(':memory:')
    for (const candidate of migrations) {
      if (candidate.name === MIGRATION_NAME) break
      candidate.up(db)
    }

    const owner = 'subject:rpc:embedded'
    const insert = db.prepare(
      `INSERT INTO sessions (
         id, session_key, source, user_id, channel_type, channel_id, thread_id, started_at
       ) VALUES (?, ?, 'rpc', ?, ?, ?, ?, 1)`
    )
    insert.run(
      'legacy-null-owner',
      `${owner}:rpc:agent-x:chat-null`,
      null,
      'rpc',
      'agent-x',
      'chat-null'
    )
    insert.run(
      'legacy-blank-owner',
      `${owner}:rpc:agent-x:chat-blank`,
      '  ',
      'rpc',
      'agent-x',
      'chat-blank'
    )
    insert.run(
      'legacy-full-key-owner',
      `${owner}:rpc:agent-x:chat-full`,
      `${owner}:rpc:agent-x:chat-full`,
      'rpc',
      'agent-x',
      'chat-full'
    )
    insert.run('legacy-default-fields', `${owner}:rpc:default:default`, null, 'rpc', null, null)
    insert.run(
      'legacy-real-mismatch',
      `${owner}:rpc:agent-x:chat-mismatch`,
      'different-owner',
      'rpc',
      'agent-x',
      'chat-mismatch'
    )
    insert.run(
      'legacy-suffix-mismatch',
      `${owner}:rpc:agent-x:chat-ambiguous`,
      null,
      'rpc',
      'different-agent',
      'chat-ambiguous'
    )
    insert.run(
      'legacy-missing-channel-type',
      `${owner}:rpc:agent-x:chat-unknown`,
      null,
      null,
      'agent-x',
      'chat-unknown'
    )

    const legacyCount = () =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM sessions
              WHERE user_id IS NULL
                 OR trim(user_id) = ''
                 OR user_id = session_key`
          )
          .get() as { count: number }
      ).count

    expect(legacyCount()).toBe(6)
    migration!.up(db)
    expect(legacyCount()).toBe(2)

    const rows = db.prepare('SELECT id, user_id FROM sessions ORDER BY id').all() as Array<{
      id: string
      user_id: string | null
    }>
    expect(rows).toEqual([
      { id: 'legacy-blank-owner', user_id: owner },
      { id: 'legacy-default-fields', user_id: owner },
      { id: 'legacy-full-key-owner', user_id: owner },
      { id: 'legacy-missing-channel-type', user_id: null },
      { id: 'legacy-null-owner', user_id: owner },
      { id: 'legacy-real-mismatch', user_id: 'different-owner' },
      { id: 'legacy-suffix-mismatch', user_id: null },
    ])

    migration!.up(db)
    expect(db.prepare('SELECT id, user_id FROM sessions ORDER BY id').all()).toEqual(rows)
    db.close()
  })
})
