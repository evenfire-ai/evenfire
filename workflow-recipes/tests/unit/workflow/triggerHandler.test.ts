import { describe, expect, it, vi } from 'vitest'
import { handleTrigger } from '../../../src/workflow/triggerHandler'

function makeParentRecipe(overrides: Record<string, unknown> = {}) {
  return {
    metadata: { name: 'market-report', namespace: 'sandbox-recipes', uid: 'uid-123' },
    spec: {
      scheduling: {
        cron: '0 9 * * *',
        concurrencyPolicy: 'Forbid',
        successfulHistoryLimit: 3,
        failedHistoryLimit: 1,
      },
      steps: [{ id: 'fetch', instruction: 'Get data' }],
      agent: { model: 'gpt-4', provider: 'openai' },
      ...overrides,
    },
  }
}

function makeMockApi(parent: unknown | null, listItems: unknown[] = []) {
  return {
    getNamespacedCustomObject: parent
      ? vi.fn().mockResolvedValue(parent)
      : vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 404 })),
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: listItems }),
    createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  } as any
}

describe('handleTrigger', () => {
  it('returns 404 when parent not found', async () => {
    const api = makeMockApi(null)
    const result = await handleTrigger(api, 'missing', 'sandbox-recipes')
    expect(result.status).toBe(404)
    expect(result.body.error).toContain('not found')
  })

  it('returns 400 when parent has no scheduling', async () => {
    const parent = {
      metadata: { name: 'no-sched', namespace: 'ns', uid: 'u' },
      spec: { steps: [] },
    }
    const api = makeMockApi(parent)
    const result = await handleTrigger(api, 'no-sched', 'ns')
    expect(result.status).toBe(400)
    expect(result.body.error).toContain('spec.scheduling')
  })

  it('returns 409 when scheduling is suspended', async () => {
    const parent = makeParentRecipe()
    ;(parent.spec.scheduling as any).suspend = true
    const api = makeMockApi(parent)
    const result = await handleTrigger(api, 'market-report', 'sandbox-recipes')
    expect(result.status).toBe(409)
    expect(result.body.error).toContain('suspended')
  })

  it('creates child and returns 202 on proceed', async () => {
    const parent = makeParentRecipe()
    const api = makeMockApi(parent, []) // no running children
    const result = await handleTrigger(api, 'market-report', 'sandbox-recipes')
    expect(result.status).toBe(202)
    expect(result.body.childName).toMatch(/^market-report-\d{8}-\d{6}-\d{4}$/)
    expect(api.createNamespacedCustomObject).toHaveBeenCalledTimes(1)
  })

  it('returns 202 with skipped when Forbid and child running', async () => {
    const parent = makeParentRecipe()
    const runningChild = {
      metadata: { name: 'market-report-20260316-090000', namespace: 'sandbox-recipes' },
      status: { workflowExecution: { phase: 'running' } },
    }
    const api = makeMockApi(parent, [runningChild])
    const result = await handleTrigger(api, 'market-report', 'sandbox-recipes')
    expect(result.status).toBe(202)
    expect(result.body.skipped).toBe(true)
    expect(api.createNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('cancels running child on Replace policy', async () => {
    const parent = makeParentRecipe()
    ;(parent.spec.scheduling as any).concurrencyPolicy = 'Replace'
    const runningChild = {
      metadata: { name: 'market-report-old', namespace: 'sandbox-recipes' },
      status: { workflowExecution: { phase: 'running' } },
    }
    const api = makeMockApi(parent, [runningChild])
    const result = await handleTrigger(api, 'market-report', 'sandbox-recipes')
    expect(result.status).toBe(202)
    expect(result.body.childName).toBeDefined()
    // Should have patched running child to cancelled (now called with params + merge-patch options)
    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'market-report-old',
        body: expect.objectContaining({
          status: expect.objectContaining({
            workflowExecution: expect.objectContaining({ phase: 'cancelled' }),
          }),
        }),
      }),
      expect.objectContaining({ middleware: expect.any(Array) })
    )
    // And created a new child
    expect(api.createNamespacedCustomObject).toHaveBeenCalledTimes(1)
  })

  it('proceeds on Allow policy when below capacity', async () => {
    const parent = makeParentRecipe()
    ;(parent.spec.scheduling as any).concurrencyPolicy = 'Allow'
    const runningChild = {
      metadata: { name: 'market-report-r1', namespace: 'sandbox-recipes' },
      status: { workflowExecution: { phase: 'running' } },
    }
    const api = makeMockApi(parent, [runningChild])
    const result = await handleTrigger(api, 'market-report', 'sandbox-recipes')
    expect(result.status).toBe(202)
    expect(result.body.childName).toBeDefined()
  })

  it('does not fail when pruneHistory throws', async () => {
    const parent = makeParentRecipe()
    const api = makeMockApi(parent, [])
    // Make listNamespacedCustomObject fail on the second call (pruneHistory)
    let callCount = 0
    api.listNamespacedCustomObject = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount <= 1) return Promise.resolve({ items: [] }) // resolveExecutionIndex
      throw new Error('prune fail')
    })
    const result = await handleTrigger(api, 'market-report', 'sandbox-recipes')
    expect(result.status).toBe(202) // Should still succeed
  })

  it('uses default concurrencyPolicy Forbid when not specified', async () => {
    const parent = makeParentRecipe()
    delete (parent.spec.scheduling as any).concurrencyPolicy
    const runningChild = {
      metadata: { name: 'r1', namespace: 'sandbox-recipes' },
      status: { workflowExecution: { phase: 'running' } },
    }
    const api = makeMockApi(parent, [runningChild])
    const result = await handleTrigger(api, 'market-report', 'sandbox-recipes')
    expect(result.status).toBe(202)
    expect(result.body.skipped).toBe(true) // Forbid default → skip
  })
})
