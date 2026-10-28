import { describe, expect, it, vi } from 'vitest'
import { canCallerReadWorkflowRun } from '../src/services/workflows/workflowRunReadService.js'

const caller = {
  kind: 'user-session' as const,
  claims: {
    userId: 'user-1',
    email: 'user@example.com',
    teamId: 'team-1',
    role: 'member' as const,
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 'run-1',
    recipe_namespace: 'workflows',
    recipe_name: 'recipe-1',
    actor_type: 'user',
    actor_id: 'user-1',
    team_id: null,
    usage_team_id: null,
    ...overrides,
  } as never
}

describe('workflow run user authorization', () => {
  it('keeps a directly attributed user run readable without a team lookup', async () => {
    const db = { query: vi.fn() }

    await expect(canCallerReadWorkflowRun(caller, run(), db as never)).resolves.toBe(true)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('lets the author read their own historical team-attributed run without a live team grant', async () => {
    const db = { query: vi.fn() }

    await expect(
      canCallerReadWorkflowRun(
        caller,
        run({ team_id: 'team-1', usage_team_id: 'team-1' }),
        db as never
      )
    ).resolves.toBe(true)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('allows the same team-attributed run only with a current membership and recipe grant', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 }) }

    await expect(
      canCallerReadWorkflowRun(caller, run({ team_id: 'team-1' }), db as never)
    ).resolves.toBe(true)
  })
})
