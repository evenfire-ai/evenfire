/**
 * U5 — durable round-trip of a `connect_required` suspension.
 *
 * A reactive OAuth-consent suspension must survive a cold restart WITHOUT
 * degrading into a generic approval. This drives a REAL in-memory SQLite DB
 * through every migration (incl. 013), inserts a connect_required row via the
 * real prepared statement, reads it back via the real select, and reconstructs
 * the PendingApproval — asserting reason/mcpServerName/provider are preserved.
 *
 * The row shape is `PendingApprovalRow`, the exact interface `persistSuspend`
 * fills (T1: no ad-hoc fixture standing in for another layer — the DB schema and
 * statements under test are the real ones).
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrations } from '../../../../db/migrations'
import { prepareStatements } from '../../../../db/statements'
import type { PendingApprovalRow } from '../../../../db/worker/protocol'
import { reconstructPendingApproval } from '../reconstruct'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of migrations) migration.up(db)
  return db
}

function connectRow(): PendingApprovalRow {
  return {
    request_id: 'req-connect-1',
    session_id: 'session-1',
    task_id: 'task-1',
    tool_name: 'monday__list_boards',
    tool_call_id: 'call-1',
    parameters: '{}',
    description: 'Connect monday to continue',
    context_snapshot: '[]',
    completed_results: null,
    intent_summary: 'Using monday...',
    source_message: null,
    registered_at: 0,
    expires_at: 9999999999,
    trace_context: null,
    reason: 'connect_required',
    mcp_server_name: 'monday',
    provider: 'monday',
  }
}

describe('U5 — connect_required durable round-trip', () => {
  it('preserves reason/mcpServerName/provider through insert → select → reconstruct', () => {
    const db = freshDb()
    const s = prepareStatements(db)

    db.prepare(
      `INSERT INTO sessions (id, session_key, source, started_at, state, active_task_id)
       VALUES (?, ?, 'rpc', 0, 'awaiting_approval', ?)`
    ).run('session-1', 'user:rpc:agent:chat', 'task-1')

    s.insertPendingApproval.run(connectRow())

    const row = s.selectPendingApprovalBySession.get('session-1') as PendingApprovalRow
    const approval = reconstructPendingApproval(row)

    // Observable: the rehydrated suspension is a connect_required, not a generic
    // approval, and it still names the oauth server + provider.
    expect(approval.reason).toBe('connect_required')
    expect(approval.mcpServerName).toBe('monday')
    expect(approval.provider).toBe('monday')
    expect(approval.tool_name).toBe('monday__list_boards')
    db.close()
  })

  it('a legacy/approval row rehydrates as a generic approval (reason undefined)', () => {
    const db = freshDb()
    const s = prepareStatements(db)

    db.prepare(
      `INSERT INTO sessions (id, session_key, source, started_at, state, active_task_id)
       VALUES (?, ?, 'rpc', 0, 'awaiting_approval', ?)`
    ).run('session-2', 'user:rpc:agent:chat', 'task-2')

    const legacy: PendingApprovalRow = {
      ...connectRow(),
      request_id: 'req-approval-1',
      session_id: 'session-2',
      task_id: 'task-2',
      reason: null,
      mcp_server_name: null,
      provider: null,
    }
    s.insertPendingApproval.run(legacy)

    const row = s.selectPendingApprovalBySession.get('session-2') as PendingApprovalRow
    const approval = reconstructPendingApproval(row)

    expect(approval.reason).toBeUndefined()
    expect(approval.mcpServerName).toBeUndefined()
    expect(approval.provider).toBeUndefined()
    db.close()
  })
})
