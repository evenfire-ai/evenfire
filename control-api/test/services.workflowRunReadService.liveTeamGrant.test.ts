import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowRunRow } from '../src/services/workflowRunService.js'
import type { WorkflowRouteCaller } from '../src/services/workflows/types.js'
import { canCallerReadWorkflowRunWithApprovalTarget } from '../src/services/workflows/workflowRunReadService.js'

const mockPoolQuery = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

const NAMESPACE = 'sandbox-recipes'
const RECIPE = 'team-scheduled-recipe'
const TEAM_ID = '7b0d3c56-2f4e-4a51-9b8e-1c2d3e4f5a60'
const READER_ID = '0f6a9e1b-8c7d-4e2f-a1b3-c4d5e6f7a809'

function userCaller(): WorkflowRouteCaller {
  return {
    kind: 'user-session',
    claims: {
      userId: READER_ID,
      email: 'live-team-grant-reader@example.invalid',
      teamId: TEAM_ID,
      role: 'member',
      authGeneration: 1,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    },
    session: {} as never,
  }
}

function scheduledTeamRun(): WorkflowRunRow {
  return {
    run_id: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
    recipe_namespace: NAMESPACE,
    recipe_name: RECIPE,
    phase: 'Running',
    actor_type: 'scheduled',
    team_id: TEAM_ID,
    usage_team_id: null,
    actor_id: null,
    idempotency_key: null,
    trigger_source: 'schedule',
    inputs: null,
    intermediate_parameters: null,
    output_overrides: null,
    child_recipe_name: null,
    child_recipe_namespace: null,
    owner_instance_id: null,
    max_duration_seconds: null,
    ttl_seconds_after_finished: null,
    approval_request_id: null,
    idempotency_payload_hash: null,
    started_at: null,
    completed_at: null,
    last_reconciled_at: null,
    created_at: '2026-11-05T00:00:00.000Z',
    updated_at: '2026-11-05T00:00:00.000Z',
  }
}

function expectLiveGrantQueryIssuedOnce(): void {
  expect(mockPoolQuery).toHaveBeenCalledTimes(1)
  const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
  expect(sql).toContain('team_workflow_triggers')
  expect(sql).toContain("tm.status = 'active'")
  expect(params).toEqual([READER_ID, TEAM_ID, NAMESPACE, RECIPE])
}

describe('canCallerReadWorkflowRunWithApprovalTarget live team grant', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
  })

  it('hides a team-scheduled run when the reader has no live team grant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    await expect(
      canCallerReadWorkflowRunWithApprovalTarget(userCaller(), scheduledTeamRun())
    ).resolves.toBe(false)

    expectLiveGrantQueryIssuedOnce()
  })

  it('shows a team-scheduled run when the reader has a live team grant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })

    await expect(
      canCallerReadWorkflowRunWithApprovalTarget(userCaller(), scheduledTeamRun())
    ).resolves.toBe(true)

    expectLiveGrantQueryIssuedOnce()
  })
})
