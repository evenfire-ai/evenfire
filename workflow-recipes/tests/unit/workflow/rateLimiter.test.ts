import { describe, expect, it, vi } from 'vitest'
import { checkConcurrency, listRunningChildren } from '../../../src/workflow/rateLimiter'

function makeRunningChild(name: string, phase = 'running') {
  return {
    metadata: { name, namespace: 'sandbox-recipes' },
    status: { workflowExecution: { phase } },
  }
}

function makeMockApi(items: unknown[]) {
  return {
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ items }),
  } as any
}

describe('listRunningChildren', () => {
  it('returns only running children', async () => {
    const items = [
      makeRunningChild('r1', 'running'),
      makeRunningChild('c1', 'completed'),
      makeRunningChild('f1', 'failed'),
      makeRunningChild('r2', 'pending'),
    ]
    const api = makeMockApi(items)
    const result = await listRunningChildren(api, 'parent', 'ns')
    // running and pending are non-terminal → running
    expect(result).toHaveLength(2)
    expect(result.map((r: any) => r.metadata.name)).toEqual(['r1', 'r2'])
  })

  it('excludes cancelled children', async () => {
    const items = [makeRunningChild('x1', 'cancelled')]
    const api = makeMockApi(items)
    const result = await listRunningChildren(api, 'parent', 'ns')
    expect(result).toHaveLength(0)
  })

  it('treats missing phase as running (pending)', async () => {
    const items = [{ metadata: { name: 'no-status', namespace: 'ns' } }]
    const api = makeMockApi(items)
    const result = await listRunningChildren(api, 'parent', 'ns')
    expect(result).toHaveLength(1)
  })

  it('uses correct label selector', async () => {
    const api = makeMockApi([])
    await listRunningChildren(api, 'my-recipe', 'sandbox-recipes')
    expect(api.listNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        labelSelector: 'clerum.io/parent-recipe=my-recipe,clerum.io/scheduled=true',
      })
    )
  })
})

describe('checkConcurrency', () => {
  it('proceeds when no running children', async () => {
    const api = makeMockApi([])
    const result = await checkConcurrency(api, 'parent', 'ns', 'Forbid')
    expect(result.decision).toBe('proceed')
  })

  describe('Forbid policy', () => {
    it('skips when child is running', async () => {
      const api = makeMockApi([makeRunningChild('r1')])
      const result = await checkConcurrency(api, 'parent', 'ns', 'Forbid')
      expect(result.decision).toBe('skip')
      expect(result.reason).toContain('Forbid')
    })
  })

  describe('Replace policy', () => {
    it('proceeds when no running children', async () => {
      const api = makeMockApi([])
      const result = await checkConcurrency(api, 'parent', 'ns', 'Replace')
      expect(result.decision).toBe('proceed')
    })

    it('returns replace with running child reference', async () => {
      const api = makeMockApi([makeRunningChild('r1')])
      const result = await checkConcurrency(api, 'parent', 'ns', 'Replace')
      expect(result.decision).toBe('replace')
      expect(result.runningChildren?.[0]?.metadata.name).toBe('r1')
      expect(result.reason).toContain('Replace')
    })
  })

  describe('Allow policy', () => {
    it('proceeds when below default capacity (3)', async () => {
      const api = makeMockApi([makeRunningChild('r1'), makeRunningChild('r2')])
      const result = await checkConcurrency(api, 'parent', 'ns', 'Allow')
      expect(result.decision).toBe('proceed')
    })

    it('skips when at default capacity (3)', async () => {
      const api = makeMockApi([
        makeRunningChild('r1'),
        makeRunningChild('r2'),
        makeRunningChild('r3'),
      ])
      const result = await checkConcurrency(api, 'parent', 'ns', 'Allow')
      expect(result.decision).toBe('skip')
      expect(result.reason).toContain('3/3')
    })

    it('respects custom maxConcurrent', async () => {
      const api = makeMockApi([makeRunningChild('r1')])
      const result = await checkConcurrency(api, 'parent', 'ns', 'Allow', 1)
      expect(result.decision).toBe('skip')
      expect(result.reason).toContain('1/1')
    })

    it('proceeds when below custom maxConcurrent', async () => {
      const api = makeMockApi([makeRunningChild('r1')])
      const result = await checkConcurrency(api, 'parent', 'ns', 'Allow', 5)
      expect(result.decision).toBe('proceed')
    })
  })
})
