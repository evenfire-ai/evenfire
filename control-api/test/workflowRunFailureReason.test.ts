import { describe, expect, it } from 'vitest'
import type { WorkflowRunRow } from '../src/services/workflowRunService.js'
import { mapDbRun } from '../src/services/workflows/workflowRunReadService.js'

describe('workflow run failure diagnostics', () => {
  it('projects the closed durable authority reason as the canonical run message', () => {
    const row = {
      run_id: '00000000-0000-4000-8000-000000000001',
      recipe_namespace: 'demo',
      recipe_name: 'echo',
      phase: 'Failed',
      actor_type: 'user',
      team_id: null,
      usage_team_id: null,
      actor_id: null,
      approval_request_id: null,
      child_recipe_name: null,
      child_recipe_namespace: null,
      created_at: '2026-09-14T12:00:00.000Z',
      started_at: null,
      completed_at: '2026-09-14T12:00:01.000Z',
      failure_reason: 'workflow_authority_invalid_binding',
    } as WorkflowRunRow

    expect(mapDbRun(row).message).toBe('workflow_authority_invalid_binding')
  })
})
