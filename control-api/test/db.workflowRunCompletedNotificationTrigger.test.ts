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
    expect(sql).toContain("IN ('telegram', 'slack', 'teams')")
    expect(sql).toContain("'providerChannelId'")
    expect(sql).toContain("'providerWorkspaceId'")
    expect(sql).toContain("'hasDownloadableItems'")
    expect(sql).toContain('CREATE OR REPLACE FUNCTION workflow_run_step_output_jsonb')
    expect(sql).toContain('EXCEPTION WHEN others THEN')
    expect(sql).toContain('workflow_run_steps wrs')
    expect(sql).not.toContain('wrs.output #>>')
    expect(sql).not.toContain('wrs.output->')
    expect(sql).toContain('workflow_run_step_output_jsonb(wrs.output) AS output_json')
    expect(sql).toContain("NULLIF(wrs_output.output_json #>> '{artifact,name}', '') IS NOT NULL")
    expect(sql).toContain("jsonb_typeof(wrs_output.output_json->'artifacts') = 'array'")
    expect(sql).toContain('jsonb_array_elements')
    expect(sql).toContain("jsonb_typeof(wrs.tools_called) = 'array'")
    expect(sql).toContain("WHEN jsonb_typeof(tool_call->'result') = 'object'")
    expect(sql).toContain("WHEN jsonb_typeof(tool_call->'result') = 'string'")
    expect(sql).toContain("workflow_run_step_output_jsonb(tool_call->>'result')")
    expect(sql).toContain("tool_result.result_json->>'success' = 'true'")
    expect(sql).toContain("tool_result.result_json #>> '{artifact,name}'")
    expect(sql).toContain('Results are ready.')
    expect(sql).not.toContain('Reply: download result')
    expect(sql).toContain('ON CONFLICT (dedupe_key) DO NOTHING')
    expect(sql).toContain("pg_notify('workflow_run_update'")
  })
})
