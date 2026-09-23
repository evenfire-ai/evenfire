import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as migration from '../014-pending-approval-task-budget'
import { reconstructPendingApproval } from '../../../core/conversation/persistence/reconstruct'
import { createDispatcher, dispatch } from '../../worker/dispatcher'
import type { PendingApprovalRow } from '../../worker/protocol'
import { migrations } from '../index'

function fixture() {
  const db = new Database(':memory:')
  for (const m of migrations) {
    if (m.name === migration.name) break
    m.up(db)
  }
  db.prepare(
    "INSERT INTO sessions(id,session_key,source,started_at,state,active_task_id) VALUES ('s','u:rpc:a:c','rpc',0,'awaiting_approval','task')"
  ).run()
  db.prepare(
    `INSERT INTO pending_approvals(request_id,session_id,task_id,tool_name,tool_call_id,parameters,description,context_snapshot,source_message,registered_at,expires_at)
    VALUES ('old','s','task','test','tc','{}','confirm','[]','{"content":"work"}',0,9999999999)`
  ).run()
  migration.up(db)
  return db
}
describe('durable task budget migration and renewal', () => {
  it('marks old rows once, preserves new budgets on repeated migration, and supports rollback', () => {
    const db = fixture()
    try {
      const row = db.prepare('SELECT * FROM pending_approvals').get() as PendingApprovalRow
      expect(reconstructPendingApproval(row).legacy_budget).toBe(true)
      db.prepare('UPDATE pending_approvals SET task_budget=?').run(
        JSON.stringify({
          elapsedActiveMs: 10,
          iterationsUsed: 1,
          durationMs: 100,
          maxIterations: 3,
        })
      )
      migration.up(db)
      expect(
        reconstructPendingApproval(
          db.prepare('SELECT * FROM pending_approvals').get() as PendingApprovalRow
        ).task_budget?.iterationsUsed
      ).toBe(1)
      migration.down(db)
      expect(
        (db.prepare('PRAGMA table_info(pending_approvals)').all() as Array<{ name: string }>).some(
          c => c.name === 'task_budget'
        )
      ).toBe(false)
    } finally {
      db.close()
    }
  })
  it('atomically replaces a legacy approval, retaining old state if insertion fails', async () => {
    const db = fixture()
    try {
      // The current dispatcher prepares statements against the current schema.
      const currentIndex = migrations.findIndex(m => m.name === migration.name)
      for (const later of migrations.slice(currentIndex + 1)) later.up(db)
      const deps = createDispatcher(db)
      const old = db.prepare('SELECT * FROM pending_approvals').get() as PendingApprovalRow
      const budget = { elapsedActiveMs: 0, iterationsUsed: 0, durationMs: 100, maxIterations: 3 }
      const row = {
        ...old,
        request_id: 'new',
        source_message: null,
        task_budget: JSON.stringify(budget),
      }
      db.exec(
        "CREATE TRIGGER reject_new BEFORE INSERT ON pending_approvals WHEN NEW.request_id='new' BEGIN SELECT RAISE(ABORT,'test failure'); END;"
      )
      await expect(
        dispatch({ kind: 'insert_pending_approval', payload: row, replaceRequestId: 'old' }, deps)
      ).rejects.toThrow('test failure')
      expect(db.prepare('SELECT request_id FROM pending_approvals').get()).toEqual({
        request_id: 'old',
      })
      db.exec('DROP TRIGGER reject_new')
      await dispatch(
        { kind: 'insert_pending_approval', payload: row, replaceRequestId: 'old' },
        deps
      )
      const saved = db.prepare('SELECT * FROM pending_approvals').get() as PendingApprovalRow
      expect(saved.request_id).toBe('new')
      expect(saved.task_id).toBe('task')
      expect(saved.source_message).toBe(old.source_message)
      expect(reconstructPendingApproval(saved).task_budget).toEqual(budget)
      expect(reconstructPendingApproval(saved).legacy_budget).toBe(false)
      expect(db.prepare('SELECT state,active_task_id FROM sessions').get()).toEqual({
        state: 'awaiting_approval',
        active_task_id: 'task',
      })
    } finally {
      db.close()
    }
  })
  it.each(['', null, '{}', 'null'])(
    'rejects malformed or missing post-migration accounting: %s',
    value => {
      const db = fixture()
      try {
        const old = db.prepare('SELECT * FROM pending_approvals').get() as PendingApprovalRow
        expect(() => reconstructPendingApproval({ ...old, task_budget: value })).toThrow()
      } finally {
        db.close()
      }
    }
  )
})
