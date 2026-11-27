import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowRunRow } from '../src/services/workflowRunService.js'
import {
  getLatestRun,
  getWorkflowHealth,
  listCanonicalRuns,
  mapDbRun,
} from '../src/services/workflows/workflowRunReadService.js'

const mockPoolQuery = vi.fn()
const mockListRunsByRecipe = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

vi.mock('../src/services/workflowRunService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/workflowRunService.js')>()),
  listRunsByRecipe: (...args: unknown[]) => mockListRunsByRecipe(...args),
}))

const NAMESPACE = 'sandbox-recipes'
const RECIPE = 'viewer-recipe'
const OPERATOR_SUBJECT = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607'
const USER_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d'

function cancelledRow(canceledBy: string): WorkflowRunRow {
  return {
    run_id: '1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081',
    recipe_namespace: NAMESPACE,
    recipe_name: RECIPE,
    phase: 'Canceled',
    actor_type: 'scheduled',
    team_id: null,
    usage_team_id: null,
    actor_id: null,
    approval_request_id: null,
    child_recipe_name: null,
    child_recipe_namespace: null,
    created_at: '2026-11-26T10:00:00.000Z',
    started_at: null,
    completed_at: '2026-11-26T10:00:05.000Z',
    failure_reason: null,
    cancel_requested_at: '2026-11-26T10:00:05.000Z',
    canceled_by: canceledBy,
  } as WorkflowRunRow
}

describe('maps canceledBy per viewer', () => {
  it('mapDbRun shows an operator cancel as operator to tenant viewers only', () => {
    const operatorRow = cancelledRow(`operator:${OPERATOR_SUBJECT}`)
    expect(mapDbRun(operatorRow, 'tenant').canceledBy).toBe('operator')
    expect(mapDbRun(operatorRow, 'admin').canceledBy).toBe(`operator:${OPERATOR_SUBJECT}`)

    const userRow = cancelledRow(USER_ID)
    expect(mapDbRun(userRow, 'tenant').canceledBy).toBe(USER_ID)
    expect(mapDbRun(userRow, 'admin').canceledBy).toBe(USER_ID)

    // Only the canceledBy field differs between the two viewers.
    const { canceledBy: tenantCanceledBy, ...tenantRest } = mapDbRun(operatorRow, 'tenant')
    const { canceledBy: adminCanceledBy, ...adminRest } = mapDbRun(operatorRow, 'admin')
    expect(tenantRest).toEqual(adminRest)
    expect(tenantCanceledBy).not.toBe(adminCanceledBy)
  })

  it('mapDbRun throws a TypeError for a missing or unknown viewer', () => {
    const operatorRow = cancelledRow(`operator:${OPERATOR_SUBJECT}`)
    for (const viewer of [undefined, 'other']) {
      expect(() => mapDbRun(operatorRow, viewer as never)).toThrow(TypeError)
    }
    // Liveness witness: the same row maps with a valid viewer.
    expect(mapDbRun(operatorRow, 'tenant').id).toBe(operatorRow.run_id)
  })
})

describe('maps canceledBy per viewer: run readers check the viewer before any query', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockListRunsByRecipe.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockListRunsByRecipe.mockResolvedValue([])
  })

  const readers = {
    listCanonicalRuns: (viewer: unknown) =>
      listCanonicalRuns(NAMESPACE, RECIPE, 10, viewer as never),
    getLatestRun: (viewer: unknown) => getLatestRun(NAMESPACE, RECIPE, viewer as never),
    getWorkflowHealth: (viewer: unknown) => getWorkflowHealth(NAMESPACE, RECIPE, viewer as never),
  }

  for (const [name, read] of Object.entries(readers)) {
    it(`${name} throws a TypeError for a missing or unknown viewer and queries nothing`, async () => {
      for (const viewer of [undefined, 'other']) {
        await expect(read(viewer)).rejects.toThrow(TypeError)
      }
      expect(mockListRunsByRecipe).not.toHaveBeenCalled()
      expect(mockPoolQuery).not.toHaveBeenCalled()

      // Liveness witness: the same read with a valid viewer issues the live query once.
      await read('tenant')
      expect(mockListRunsByRecipe).toHaveBeenCalledTimes(1)
      expect(mockListRunsByRecipe.mock.calls[0]!.slice(0, 2)).toEqual([NAMESPACE, RECIPE])
    })
  }
})
