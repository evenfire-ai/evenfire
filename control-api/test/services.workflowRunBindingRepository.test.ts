import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import { WorkflowRunBindingRepository } from '../src/services/workflowRunBindingRepository.js'

const FIRST_RUN_ID = '11111111-1111-4111-8111-111111111111'

function runId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    run_id: FIRST_RUN_ID,
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'daily-report',
    phase: 'Running',
    actor_type: 'user',
    actor_id: '22222222-2222-4222-8222-222222222222',
    team_id: '33333333-3333-4333-8333-333333333333',
    usage_team_id: 'usage-team',
    started_at: '2026-07-11T09:59:00.000Z',
    completed_at: null,
    approval_request_id: null,
    duration_ms: null,
    source: 'live',
    ...overrides,
  }
}

function repositoryWith(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length })
  return {
    query,
    repository: new WorkflowRunBindingRepository({ query } as DbClient),
  }
}

describe('WorkflowRunBindingRepository', () => {
  it.each([
    ['one id', [FIRST_RUN_ID]],
    ['one hundred ids', Array.from({ length: 100 }, (_, index) => runId(index + 1))],
  ])('uses one set-based query for %s', async (_label, runIds) => {
    const { query, repository } = repositoryWith()

    await repository.resolveMany([...runIds, runIds[0]!])

    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]![0]).toContain('SELECT DISTINCT unnest($1::uuid[])')
    expect(query.mock.calls[0]![1]).toEqual([runIds])
  })

  it('prefers a live binding over an archived row for the same run', async () => {
    const { query, repository } = repositoryWith([
      row({ source: 'archive', recipe_name: 'archived-recipe' }),
      row({ source: 'live', recipe_name: 'live-recipe' }),
    ])

    const binding = await repository.resolve(FIRST_RUN_ID)

    expect(query.mock.calls[0]![0]).toContain('WHERE NOT EXISTS')
    expect(binding).toMatchObject({
      runId: FIRST_RUN_ID,
      recipeName: 'live-recipe',
    })
  })
})
