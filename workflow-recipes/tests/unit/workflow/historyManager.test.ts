import { describe, expect, it, vi } from 'vitest'
import {
  isTerminalForPruning,
  listChildren,
  pruneHistory,
} from '../../../src/workflow/historyManager'

function makeChild(name: string, phase: string, timestamp: string) {
  return {
    metadata: { name, namespace: 'sandbox-recipes', creationTimestamp: timestamp },
    status: { workflowExecution: { phase } },
  }
}

describe('listChildren', () => {
  it('returns items from API response', async () => {
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [makeChild('c1', 'completed', '2026-03-01T00:00:00Z')],
      }),
    } as any
    const result = await listChildren(mockApi, 'parent', 'ns')
    expect(result).toHaveLength(1)
    expect(result[0].metadata.name).toBe('c1')
  })

  it('returns empty array when no items', async () => {
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as any
    expect(await listChildren(mockApi, 'parent', 'ns')).toEqual([])
  })

  it('uses correct label selector', async () => {
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    } as any
    await listChildren(mockApi, 'my-recipe', 'sandbox-recipes')
    expect(mockApi.listNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        labelSelector: 'clerum.io/parent-recipe=my-recipe,clerum.io/scheduled=true',
        namespace: 'sandbox-recipes',
      })
    )
  })
})

describe('pruneHistory', () => {
  it('deletes oldest successful children beyond limit', async () => {
    const children = [
      makeChild('old-1', 'completed', '2026-03-01T00:00:00Z'),
      makeChild('old-2', 'completed', '2026-03-02T00:00:00Z'),
      makeChild('keep', 'completed', '2026-03-03T00:00:00Z'),
    ]
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: children }),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as any

    const deleted = await pruneHistory(mockApi, 'parent', 'ns', {
      successfulHistoryLimit: 1,
      failedHistoryLimit: 3,
    })
    expect(deleted).toEqual(['old-1', 'old-2'])
    expect(mockApi.deleteNamespacedCustomObject).toHaveBeenCalledTimes(2)
  })

  it('deletes oldest failed children beyond limit', async () => {
    const children = [
      makeChild('f1', 'failed', '2026-03-01T00:00:00Z'),
      makeChild('f2', 'failed', '2026-03-02T00:00:00Z'),
      makeChild('f3', 'failed', '2026-03-03T00:00:00Z'),
    ]
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: children }),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as any

    const deleted = await pruneHistory(mockApi, 'parent', 'ns', {
      successfulHistoryLimit: 3,
      failedHistoryLimit: 1,
    })
    expect(deleted).toEqual(['f1', 'f2'])
  })

  it('does not delete running children', async () => {
    const children = [
      makeChild('running-1', 'running', '2026-03-01T00:00:00Z'),
      makeChild('pending-1', 'pending', '2026-03-01T00:00:00Z'),
    ]
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: children }),
      deleteNamespacedCustomObject: vi.fn(),
    } as any

    const deleted = await pruneHistory(mockApi, 'parent', 'ns', {
      successfulHistoryLimit: 0,
      failedHistoryLimit: 0,
    })
    expect(deleted).toEqual([])
    expect(mockApi.deleteNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('returns empty when within limits', async () => {
    const children = [makeChild('c1', 'completed', '2026-03-01T00:00:00Z')]
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: children }),
      deleteNamespacedCustomObject: vi.fn(),
    } as any

    const deleted = await pruneHistory(mockApi, 'parent', 'ns', {
      successfulHistoryLimit: 5,
      failedHistoryLimit: 5,
    })
    expect(deleted).toEqual([])
  })

  it('continues on delete error (best-effort)', async () => {
    const children = [
      makeChild('c1', 'completed', '2026-03-01T00:00:00Z'),
      makeChild('c2', 'completed', '2026-03-02T00:00:00Z'),
      makeChild('c3', 'completed', '2026-03-03T00:00:00Z'),
    ]
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: children }),
      deleteNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({}),
    } as any

    const deleted = await pruneHistory(mockApi, 'parent', 'ns', {
      successfulHistoryLimit: 1,
      failedHistoryLimit: 3,
    })
    // c1 fails, c2 succeeds
    expect(deleted).toEqual(['c2'])
  })

  it('deletes all successful when successfulHistoryLimit is 0', async () => {
    const children = [
      makeChild('s1', 'completed', '2026-03-01T00:00:00Z'),
      makeChild('s2', 'completed', '2026-03-02T00:00:00Z'),
    ]
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: children }),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as any

    const deleted = await pruneHistory(mockApi, 'parent', 'ns', {
      successfulHistoryLimit: 0,
      failedHistoryLimit: 5,
    })
    expect(deleted).toEqual(['s1', 's2'])
  })

  it('deletes all failed when failedHistoryLimit is 0', async () => {
    const children = [
      makeChild('f1', 'failed', '2026-03-01T00:00:00Z'),
      makeChild('f2', 'failed', '2026-03-02T00:00:00Z'),
    ]
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: children }),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as any

    const deleted = await pruneHistory(mockApi, 'parent', 'ns', {
      successfulHistoryLimit: 5,
      failedHistoryLimit: 0,
    })
    expect(deleted).toEqual(['f1', 'f2'])
  })

  it('handles empty history (no children)', async () => {
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
      deleteNamespacedCustomObject: vi.fn(),
    } as any

    const deleted = await pruneHistory(mockApi, 'parent', 'ns', {
      successfulHistoryLimit: 3,
      failedHistoryLimit: 1,
    })
    expect(deleted).toEqual([])
    expect(mockApi.deleteNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('handles mixed successful and failed children', async () => {
    const children = [
      makeChild('s1', 'completed', '2026-03-01T00:00:00Z'),
      makeChild('s2', 'completed', '2026-03-02T00:00:00Z'),
      makeChild('f1', 'failed', '2026-03-01T00:00:00Z'),
      makeChild('f2', 'failed', '2026-03-02T00:00:00Z'),
    ]
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: children }),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as any

    const deleted = await pruneHistory(mockApi, 'parent', 'ns', {
      successfulHistoryLimit: 1,
      failedHistoryLimit: 1,
    })
    expect(deleted).toContain('s1')
    expect(deleted).toContain('f1')
    expect(deleted).not.toContain('s2')
    expect(deleted).not.toContain('f2')
  })
})

describe('isTerminalForPruning', () => {
  it('returns true for completed', () => {
    expect(isTerminalForPruning('completed')).toBe(true)
  })

  it('returns true for failed', () => {
    expect(isTerminalForPruning('failed')).toBe(true)
  })

  it('returns false for running', () => {
    expect(isTerminalForPruning('running')).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isTerminalForPruning(undefined)).toBe(false)
  })

  it('returns true for cancelled (prunable — children cancelled by Replace policy must be cleaned up)', () => {
    expect(isTerminalForPruning('cancelled')).toBe(true)
  })
})
