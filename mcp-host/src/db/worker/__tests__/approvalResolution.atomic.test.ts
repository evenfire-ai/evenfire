import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../migrate'
import { createDispatcher, dispatch } from '../dispatcher'
import { isWriteOp } from '../protocol'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
  db.prepare(
    `INSERT INTO sessions(id,session_key,source,started_at,state,active_task_id,active_trace_context)
    VALUES('session','user:rpc:agent:chat','rpc',1,'awaiting_approval','old-task','old-trace')`
  ).run()
  db.prepare(
    `INSERT INTO pending_approvals(request_id,session_id,task_id,tool_name,tool_call_id,parameters,description,context_snapshot,registered_at,expires_at)
    VALUES('approval','session','old-task','shell_exec','call','{}','pending action','[]',1,1000000)`
  ).run()
})
afterEach(() => db.close())
const operation = {
  kind: 'resolve_pending_approval' as const,
  sessionId: 'session',
  requestId: 'approval',
  decision: 'cancel' as const,
  endedAt: 2,
}

describe('atomic pending approval resolution', () => {
  it('atomically removes the approval and clears only the matching awaited task', async () => {
    expect(isWriteOp(operation)).toBe(true)
    await dispatch(operation, createDispatcher(db))
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toEqual([])
    expect(
      db.prepare('SELECT state,active_task_id,active_trace_context,end_reason FROM sessions').get()
    ).toEqual({
      state: 'idle',
      active_task_id: null,
      active_trace_context: null,
      end_reason: 'cancelled',
    })
  })
  it('never overwrites a new accepted turn with an old resolution or its replay', async () => {
    db.prepare(
      "UPDATE sessions SET state='processing',active_task_id='new-task',active_trace_context='new-trace'"
    ).run()
    await dispatch(operation, createDispatcher(db))
    await dispatch(operation, createDispatcher(db))
    expect(
      db.prepare('SELECT state,active_task_id,active_trace_context,end_reason FROM sessions').get()
    ).toEqual({
      state: 'processing',
      active_task_id: 'new-task',
      active_trace_context: 'new-trace',
      end_reason: null,
    })
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toEqual([])
  })
  it('rolls back the state update when deleting the approval fails', async () => {
    db.exec(
      "CREATE TRIGGER fail_delete BEFORE DELETE ON pending_approvals BEGIN SELECT RAISE(ABORT,'fixture delete failure'); END"
    )
    await expect(dispatch(operation, createDispatcher(db))).rejects.toThrow(
      'fixture delete failure'
    )
    expect(
      db.prepare('SELECT state,active_task_id,active_trace_context FROM sessions').get()
    ).toEqual({
      state: 'awaiting_approval',
      active_task_id: 'old-task',
      active_trace_context: 'old-trace',
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get()).toEqual({ n: 1 })
  })
  it('approve preserves the same task and trace, and foreign session binding cannot consume it', async () => {
    await expect(
      dispatch({ ...operation, sessionId: 'other' }, createDispatcher(db))
    ).rejects.toThrow('binding mismatch')
    await dispatch({ ...operation, decision: 'approve', endedAt: undefined }, createDispatcher(db))
    expect(
      db.prepare('SELECT state,active_task_id,active_trace_context FROM sessions').get()
    ).toEqual({
      state: 'processing',
      active_task_id: 'old-task',
      active_trace_context: 'old-trace',
    })
  })
})
