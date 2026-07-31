import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as m007 from '../007-sessions-model-selections'
import * as m008 from '../008-active-trace-context'
import { runMigrations } from '../../migrate'
import { migrations } from '../index'

describe('migration 008 — active trace context', () => {
  it('keeps legacy rows nullable, repairs task_id, and tolerates the legacy migration body', () => {
    const db = new Database(':memory:')
    for (const migration of migrations) {
      if (migration.name === m008.name) break
      migration.up(db)
    }

    db.prepare(
      `INSERT INTO sessions (id, session_key, source, started_at, state, active_task_id)
       VALUES (?, ?, 'rpc', 0, 'awaiting_approval', ?)`
    ).run('session-1', 'user:rpc:agent:chat', 'task-active')
    db.prepare(
      `INSERT INTO pending_approvals (
         request_id, session_id, task_id, tool_name, tool_call_id, parameters,
         description, context_snapshot, registered_at, expires_at
       ) VALUES (?, ?, ?, 'shell_exec', 'tool-call-1', '{}', 'run command', '[]', 0, 9999999999)`
    ).run('request-1', 'session-1', 'request-1')

    m008.up(db)
    m008.up(db)

    const legacySession = db
      .prepare('SELECT active_trace_context FROM sessions WHERE id = ?')
      .get('session-1') as { active_trace_context: string | null }
    const legacyApproval = db
      .prepare('SELECT task_id, trace_context FROM pending_approvals WHERE request_id = ?')
      .get('request-1') as { task_id: string; trace_context: string | null }
    expect(legacySession.active_trace_context).toBeNull()
    expect(legacyApproval).toEqual({ task_id: 'task-active', trace_context: null })

    const traceTriggers = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'trigger' AND name LIKE '%trace_context%'`
      )
      .all()
    expect(traceTriggers).toEqual([])
    db.close()
  })

  it('upgrades a database that recorded the old 007 trace migration name', () => {
    const db = new Database(':memory:')
    const priorEnd = migrations.findIndex(migration => migration.name === m007.name)
    expect(priorEnd).toBeGreaterThan(0)
    const priorMigrations = migrations.slice(0, priorEnd)
    for (const migration of priorMigrations) migration.up(db)

    m008.up(db)
    db.exec(`
      CREATE TABLE migrations_meta (
        name TEXT PRIMARY KEY,
        applied_at REAL NOT NULL
      );
    `)
    const record = db.prepare('INSERT INTO migrations_meta (name, applied_at) VALUES (?, 0)')
    for (const migration of priorMigrations) record.run(migration.name)
    record.run('007-active-trace-context')

    const result = runMigrations(db)

    expect(result).toEqual({
      applied: [
        '007-sessions-model-selections',
        '008-active-trace-context',
        '009-session-summary-indexes',
        '010-materialized-session-summaries',
        '011-session-summary-user-activity-index',
      ],
      pending: [],
    })
    const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string
    }>
    expect(sessionColumns.map(column => column.name)).toEqual(
      expect.arrayContaining(['model_selections', 'active_trace_context'])
    )
    db.close()
  })
})
