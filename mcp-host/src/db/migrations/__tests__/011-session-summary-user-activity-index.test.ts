import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { prepareStatements } from '../../statements'
import * as m011 from '../011-session-summary-user-activity-index'
import { migrations } from '../index'

describe('migration 011 — session summary user/activity index', () => {
  it('serves owned rows without sorting unbounded catalog candidates', () => {
    const db = new Database(':memory:')
    for (const migration of migrations) migration.up(db)

    const index = db
      .prepare(
        `SELECT sql
           FROM sqlite_master
          WHERE type = 'index'
            AND name = 'idx_sessions_summary_activity'`
      )
      .get() as { sql: string }
    expect(index.sql).toContain(
      'user_id, COALESCE(last_activity_at, started_at) DESC, session_key ASC'
    )

    const statement = prepareStatements(db).selectSessionSummariesByPrefix
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${statement.source}`).all({
      prefix_start: 'u-1:rpc:',
      prefix_end: 'u-1:rpd',
      user_id: 'u-1',
      agent_scoped: 0,
      limit: 20,
      cursor_updated_at: null,
      cursor_key: null,
    }) as Array<{ detail: string }>

    expect(plan.some(step => step.detail.includes('idx_sessions_summary_activity'))).toBe(true)
    // The approval join may sort the already-limited page once. A second sort
    // means the catalog candidates were materialized before LIMIT.
    expect(plan.filter(step => step.detail.includes('USE TEMP B-TREE FOR ORDER BY'))).toHaveLength(
      1
    )

    m011.down(db)
    const downgraded = db
      .prepare(
        `SELECT sql
           FROM sqlite_master
          WHERE type = 'index'
            AND name = 'idx_sessions_summary_activity'`
      )
      .get() as { sql: string }
    expect(downgraded.sql).not.toContain('user_id,')
    db.close()
  })
})
