import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as m010 from '../010-materialized-session-summaries'
import { migrations } from '../index'

describe('migration 010 — materialized session summaries', () => {
  it('backfills activity, visible-message, and turn counters from legacy rows', () => {
    const db = new Database(':memory:')
    for (const migration of migrations) {
      if (migration.name === m010.name) break
      migration.up(db)
    }

    const insertSession = db.prepare(
      `INSERT INTO sessions (id, session_key, source, started_at)
       VALUES (?, ?, 'rpc', ?)`
    )
    insertSession.run('session-with-messages', 'u-1:rpc:agent:chat-1', 1)
    insertSession.run('empty-session', 'u-1:rpc:agent:chat-2', 5)

    const insertMessage = db.prepare(
      `INSERT INTO messages (
         session_id, ordinal, role, content, tool_calls, timestamp, turn_number
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    insertMessage.run('session-with-messages', 0, 'user', 'question', null, 10, 1)
    insertMessage.run('session-with-messages', 1, 'assistant', null, '[]', 11, 1)
    insertMessage.run('session-with-messages', 2, 'tool', 'result', null, 11, 1)
    insertMessage.run('session-with-messages', 3, 'assistant', 'answer', null, 12, 1)
    insertMessage.run('session-with-messages', 4, 'user', 'next', null, 20, 2)

    m010.up(db)

    expect(
      db
        .prepare(
          `SELECT last_activity_at, turn_count, message_count
             FROM sessions
            WHERE id = 'session-with-messages'`
        )
        .get()
    ).toEqual({
      last_activity_at: 20,
      turn_count: 2,
      message_count: 3,
    })
    expect(
      db
        .prepare(
          `SELECT last_activity_at, turn_count, message_count
             FROM sessions
            WHERE id = 'empty-session'`
        )
        .get()
    ).toEqual({
      last_activity_at: 5,
      turn_count: 0,
      message_count: 0,
    })

    const indexes = db
      .prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'idx_sessions_summary_activity',
              'idx_messages_session_turn_ordinal',
              'idx_messages_session_turn_key_ordinal'
            )
          ORDER BY name`
      )
      .all() as Array<{ name: string }>
    expect(indexes.map(index => index.name)).toEqual([
      'idx_messages_session_turn_ordinal',
      'idx_sessions_summary_activity',
    ])
    const activityIndex = db
      .prepare(
        `SELECT sql
           FROM sqlite_master
          WHERE type = 'index'
            AND name = 'idx_sessions_summary_activity'`
      )
      .get() as { sql: string }
    expect(activityIndex.sql).toContain(
      'COALESCE(last_activity_at, started_at) DESC, session_key ASC'
    )
    const activityPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id
           FROM sessions
          ORDER BY COALESCE(last_activity_at, started_at) DESC, session_key ASC
          LIMIT 10`
      )
      .all() as Array<{ detail: string }>
    expect(activityPlan.some(step => step.detail.includes('idx_sessions_summary_activity'))).toBe(
      true
    )
    db.close()
  })
})
