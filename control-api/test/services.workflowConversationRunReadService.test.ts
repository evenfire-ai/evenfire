import { describe, expect, it, vi } from 'vitest'
import { getConversationScopedWorkflowHealth } from '../src/services/workflows/workflowConversationRunReadService.js'

const caller = {
  kind: 'mcp-host-control' as const,
  claims: {
    sub: 'mcp-host/standalone',
    hostRefs: ['chatllm'],
    scopes: ['workflow:read'],
  },
}

describe('workflowConversationRunReadService', () => {
  it('counts every active run and returns the latest run inside the exact conversation scope', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          run_id: '00000000-0000-4000-8000-000000000123',
          recipe_namespace: 'sandbox-recipes',
          recipe_name: 'gfs-grant-e2e-plugin',
          phase: 'Succeeded',
          activeRuns: 2,
        },
      ],
      rowCount: 1,
    })

    const result = await getConversationScopedWorkflowHealth({
      caller: caller as never,
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'gfs-grant-e2e-plugin',
      approvalTarget: { targetUserId: '00000000-0000-4000-8000-000000000001' },
      conversationId: 'thread-1',
      db: { query } as never,
    })

    expect(result.activeRuns).toBe(2)
    expect(result.lastRun).toMatchObject({ phase: 'Succeeded' })
    const [sql, params] = query.mock.calls[0]
    expect(String(sql)).toContain('COUNT(*) FILTER')
    expect(String(sql)).toContain("phase IN ('Pending', 'Running')")
    expect(String(sql)).toContain('trigger_caller_key = $5')
    expect(String(sql)).toContain("'conversationId' = $6")
    expect(params).toEqual([
      'sandbox-recipes',
      'gfs-grant-e2e-plugin',
      '00000000-0000-4000-8000-000000000001',
      null,
      'chatllm',
      'thread-1',
    ])
  })

  it('returns no run and zero active runs when the exact conversation has no match', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await expect(
      getConversationScopedWorkflowHealth({
        caller: caller as never,
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'gfs-grant-e2e-plugin',
        approvalTarget: { targetTeamId: '00000000-0000-4000-8000-0000000000aa' },
        conversationId: 'other-thread',
        db: { query } as never,
      })
    ).resolves.toEqual({ activeRuns: 0, lastRun: null })
  })
})
