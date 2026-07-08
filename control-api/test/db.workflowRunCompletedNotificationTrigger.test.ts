import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

describe('workflow run completed notification trigger migration', () => {
  it('enqueues terminal workflow.run.completed notifications with run-phase dedupe', async () => {
    const { applyWorkflowRunCompletedNotificationTrigger } = await import('../src/db.js')
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }

    await applyWorkflowRunCompletedNotificationTrigger(db as any)

    const sql = String(db.query.mock.calls[0]?.[0] ?? '')
    expect(sql).toContain("TG_OP = 'UPDATE'")
    expect(sql).toContain('OLD.phase IS DISTINCT FROM NEW.phase')
    expect(sql).toContain("NEW.phase IN ('Succeeded', 'Failed', 'Canceled')")
    expect(sql).toContain('event_type, dedupe_key, audience, payload')
    expect(sql).toContain("'workflow.run.completed:' || NEW.run_id::text || ':' || NEW.phase")
    expect(sql).toContain('workflow_approval_requests war')
    expect(sql).toContain('workflow_approval_trigger_intents wati')
    expect(sql).toContain("war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}'")
    expect(sql).toContain("'providerChannelId'")
    expect(sql).toContain("'providerWorkspaceId'")
    expect(sql).toContain('Results are ready. Reply: download result')
    expect(sql).toContain('ON CONFLICT (dedupe_key) DO NOTHING')
    expect(sql).toContain("pg_notify('workflow_run_update'")
  })
})
