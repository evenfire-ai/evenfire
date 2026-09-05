import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as m013 from '../013-pending-approval-connect'
import { migrations } from '../index'

/** Apply every migration strictly before 013, so the pending_approvals table
 *  exists in its pre-013 shape. */
function dbBefore013(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of migrations) {
    if (migration.name === m013.name) break
    migration.up(db)
  }
  return db
}

function columnNames(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(pending_approvals)').all() as Array<{ name: string }>).map(
    c => c.name
  )
}

describe('migration 013 — pending_approval connect_required fields', () => {
  it('is idempotent and leaves legacy rows nullable on the new columns', () => {
    const db = dbBefore013()

    // A pre-013 approval row (no reason / mcp_server_name columns yet).
    db.prepare(
      `INSERT INTO sessions (id, session_key, source, started_at, state, active_task_id)
       VALUES (?, ?, 'rpc', 0, 'awaiting_approval', ?)`
    ).run('session-1', 'user:rpc:agent:chat', 'request-1')
    db.prepare(
      `INSERT INTO pending_approvals (
         request_id, session_id, task_id, tool_name, tool_call_id, parameters,
         description, context_snapshot, registered_at, expires_at
       ) VALUES (?, ?, ?, 'shell_exec', 'tool-call-1', '{}', 'run command', '[]', 0, 9999999999)`
    ).run('request-1', 'session-1', 'request-1')

    // up twice → must not throw (idempotence guard on ADD COLUMN).
    m013.up(db)
    m013.up(db)

    expect(columnNames(db)).toEqual(expect.arrayContaining(['reason', 'mcp_server_name']))

    const legacy = db
      .prepare('SELECT reason, mcp_server_name FROM pending_approvals WHERE request_id = ?')
      .get('request-1') as { reason: string | null; mcp_server_name: string | null }
    expect(legacy).toEqual({ reason: null, mcp_server_name: null })

    db.close()
  })

  it('down() removes the columns and is reversible', () => {
    const db = dbBefore013()
    m013.up(db)
    expect(columnNames(db)).toEqual(expect.arrayContaining(['reason', 'mcp_server_name']))

    m013.down(db)
    const after = columnNames(db)
    expect(after).not.toContain('reason')
    expect(after).not.toContain('mcp_server_name')

    // Reversible: up again re-adds them.
    m013.up(db)
    expect(columnNames(db)).toEqual(expect.arrayContaining(['reason', 'mcp_server_name']))

    db.close()
  })
})
