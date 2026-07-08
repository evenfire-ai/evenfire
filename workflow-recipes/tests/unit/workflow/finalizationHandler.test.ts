import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  FinalizationDeps,
  WORKFLOW_FINALIZER,
  addFinalizer,
  cleanupWorkflowResources,
  hasDeletionTimestamp,
  hasFinalizer,
  removeFinalizer,
  validateOutputPath,
  withRetry,
} from '../../../src/workflow/finalizationHandler'

// ─── withRetry ─────────────────────────────────────────────────────────

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, 3, 1)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('retries on failure and succeeds on 3rd attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok')
    const result = await withRetry(fn, 5, 1)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws last error after exhausting attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent'))
    await expect(withRetry(fn, 3, 1)).rejects.toThrow('persistent')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('delays increase exponentially', async () => {
    const delays: number[] = []
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      // Execute immediately
      if (typeof fn === 'function') fn()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    const failFn = vi.fn().mockRejectedValue(new Error('fail'))
    await withRetry(failFn, 4, 100).catch(() => {})

    // 3 delays for 4 attempts (no delay before first attempt)
    expect(delays).toEqual([100, 200, 400])
    vi.restoreAllMocks()
  })
})

// ─── validateOutputPath ────────────────────────────────────────────────

describe('validateOutputPath', () => {
  const mount = '/data/output'

  it('accepts valid relative path within mount', () => {
    expect(() => validateOutputPath('reports/2026-03.csv', mount)).not.toThrow()
  })

  it('accepts path equal to mount itself', () => {
    expect(() => validateOutputPath('/data/output', mount)).not.toThrow()
  })

  it('accepts path with no special characters', () => {
    expect(() => validateOutputPath('simple.txt', mount)).not.toThrow()
  })

  it('rejects empty path', () => {
    expect(() => validateOutputPath('', mount)).toThrow('empty')
  })

  it("rejects path containing '..'", () => {
    expect(() => validateOutputPath('../etc/passwd', mount)).toThrow('traversal')
  })

  it('rejects absolute path outside mount', () => {
    expect(() => validateOutputPath('/tmp/evil', mount)).toThrow('outside declared mount')
  })

  it('rejects path starting with /etc', () => {
    expect(() => validateOutputPath('/etc/shadow', mount)).toThrow('system directory')
  })

  it('rejects path starting with /proc', () => {
    expect(() => validateOutputPath('/proc/1/environ', mount)).toThrow('system directory')
  })

  it('rejects path starting with /sys', () => {
    expect(() => validateOutputPath('/sys/class/net', mount)).toThrow('system directory')
  })

  it('rejects path with unresolved template variable', () => {
    expect(() => validateOutputPath('reports/{{inputs.month}}/data.csv', mount)).toThrow(
      'unresolved template'
    )
  })

  it('rejects path that resolves outside mount via path.resolve', () => {
    // On POSIX, path.resolve("/data/output", "/tmp/evil") → "/tmp/evil"
    expect(() => validateOutputPath('/tmp/evil', mount)).toThrow()
  })
})

// ─── hasFinalizer / hasDeletionTimestamp ────────────────────────────────

describe('hasFinalizer', () => {
  it('returns true when finalizer is present', () => {
    expect(hasFinalizer({ finalizers: [WORKFLOW_FINALIZER] })).toBe(true)
  })

  it('returns false when finalizer is absent', () => {
    expect(hasFinalizer({ finalizers: ['other-finalizer'] })).toBe(false)
  })

  it('returns false when no finalizers', () => {
    expect(hasFinalizer({})).toBe(false)
  })
})

describe('hasDeletionTimestamp', () => {
  it('returns true when timestamp is set', () => {
    expect(hasDeletionTimestamp({ deletionTimestamp: '2026-03-17T10:00:00Z' })).toBe(true)
  })

  it('returns false when timestamp is absent', () => {
    expect(hasDeletionTimestamp({})).toBe(false)
  })
})

// ─── cleanupWorkflowResources ──────────────────────────────────────────

describe('cleanupWorkflowResources', () => {
  let deps: FinalizationDeps

  beforeEach(() => {
    deps = {
      coreApi: {
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
        deleteNamespacedConfigMap: vi.fn().mockResolvedValue({}),
        deleteNamespacedService: vi.fn().mockResolvedValue({}),
      } as any,
      customApi: {
        listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
        deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      } as any,
      networkingApi: {
        listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
        deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
      } as any,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withStep: vi.fn(),
      } as any,
    }
  })

  it('calls all cleanup steps in sequence', async () => {
    await cleanupWorkflowResources('my-recipe', 'sandbox-recipes', 'mcp-server', deps)

    // Pods
    expect(deps.coreApi.deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-recipe-coordinator' })
    )
    expect(deps.coreApi.deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-recipe-mcp-host' })
    )
    expect(deps.coreApi.deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-recipe-artifact-reader' })
    )
    // Secret
    expect(deps.coreApi.deleteNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'wf-my-recipe-coordinator-token' })
    )
    // ConfigMaps
    expect(deps.coreApi.deleteNamespacedConfigMap).toHaveBeenCalledTimes(2)
    // Service
    expect(deps.coreApi.deleteNamespacedService).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'wf-my-recipe-mcp-host' })
    )
    expect(deps.coreApi.deleteNamespacedService).toHaveBeenCalledWith(
      expect.objectContaining({
        name: `wf-${createHash('sha256')
          .update('sandbox-recipes/my-recipe')
          .digest('hex')
          .slice(0, 16)}-mcp-host`,
      })
    )
    expect(deps.coreApi.deleteNamespacedService).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'wf-my-recipe-artifact-reader' })
    )
  })

  it('uses label selector with both recipe and managed-by labels', async () => {
    await cleanupWorkflowResources('test-r', 'sandbox-recipes', 'mcp-server', deps)

    expect(deps.networkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        labelSelector: 'clerum.io/recipe=test-r,clerum.io/managed-by=wrc',
      })
    )
  })

  it('treats 404 as success (resource already gone)', async () => {
    const error = new Error('not found')
    ;(error as any).response = { statusCode: 404 }
    ;(error as any).statusCode = 404
    deps.coreApi.deleteNamespacedPod = vi.fn().mockRejectedValue(error)

    // Should not throw
    await expect(
      cleanupWorkflowResources('r', 'sandbox-recipes', 'mcp-server', deps)
    ).resolves.toBeUndefined()
  })

  it('uses allSettled — one failure does not prevent other cleanups', async () => {
    // Mock setTimeout to execute immediately (avoid real delays from withRetry)
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void) => {
      if (typeof fn === 'function') fn()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    const nonRetryableError = new Error('permission denied')
    ;(nonRetryableError as any).code = 403
    // Pod delete fails, but Secret/ConfigMap/Service should still be attempted
    deps.coreApi.deleteNamespacedPod = vi.fn().mockRejectedValue(nonRetryableError)

    // Should not throw — allSettled collects failures, logs warnings
    await expect(
      cleanupWorkflowResources('r', 'sandbox-recipes', 'mcp-server', deps)
    ).resolves.toBeUndefined()
    // Secret and ConfigMaps and Service were still called despite Pod failure
    expect(deps.coreApi.deleteNamespacedSecret).toHaveBeenCalled()
    expect(deps.coreApi.deleteNamespacedConfigMap).toHaveBeenCalled()
    expect(deps.coreApi.deleteNamespacedService).toHaveBeenCalled()
    // Failures logged as warnings
    expect(deps.log.warn).toHaveBeenCalled()

    vi.restoreAllMocks()
  })

  it('deletes McpServer CRDs found by label selector', async () => {
    deps.customApi.listNamespacedCustomObject = vi.fn().mockResolvedValue({
      items: [{ metadata: { name: 'mcp-server-1' } }, { metadata: { name: 'mcp-server-2' } }],
    })

    await cleanupWorkflowResources('r', 'sandbox-recipes', 'mcp-server', deps)

    expect(deps.customApi.deleteNamespacedCustomObject).toHaveBeenCalledTimes(2)
  })

  it('deletes NetworkPolicies found by label selector', async () => {
    deps.networkingApi.listNamespacedNetworkPolicy = vi.fn().mockResolvedValue({
      items: [{ metadata: { name: 'np-1' } }],
    })

    await cleanupWorkflowResources('r', 'sandbox-recipes', 'mcp-server', deps)

    expect(deps.networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalled()
  })

  it('emits structured log entries for each cleanup step', async () => {
    await cleanupWorkflowResources('r', 'sandbox-recipes', 'mcp-server', deps)

    // 4 log entries: parallel batch (steps 1-4,7) + NPs (step 5) + McpServers (step 6) + completion
    expect(deps.log.info).toHaveBeenCalledTimes(4)
  })

  it('throws when NetworkPolicy cleanup fails', async () => {
    deps.networkingApi.listNamespacedNetworkPolicy = vi.fn().mockResolvedValue({
      items: [{ metadata: { name: 'np-egress' } }],
    })
    deps.networkingApi.deleteNamespacedNetworkPolicy = vi
      .fn()
      .mockRejectedValue(new Error('permission denied'))

    await expect(
      cleanupWorkflowResources('r', 'sandbox-recipes', 'mcp-server', deps)
    ).rejects.toThrow('NetworkPolicy cleanup failed')
  })

  it('throws when McpServer CRD cleanup fails', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void) => {
      if (typeof fn === 'function') fn()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    deps.customApi.listNamespacedCustomObject = vi.fn().mockResolvedValue({
      items: [{ metadata: { name: 'mcp-server-1' } }],
    })
    deps.customApi.deleteNamespacedCustomObject = vi.fn().mockRejectedValue(new Error('forbidden'))

    await expect(
      cleanupWorkflowResources('r', 'sandbox-recipes', 'mcp-server', deps)
    ).rejects.toThrow('McpServer cleanup failed')

    vi.restoreAllMocks()
  })
})

// ─── addFinalizer / removeFinalizer ─────────────────────────────────────────

describe('addFinalizer', () => {
  it('adds WORKFLOW_FINALIZER when none exist', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({ metadata: {} }),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as any

    await addFinalizer(customApi, 'my-recipe', 'sandbox-recipes')

    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        body: [{ op: 'add', path: '/metadata/finalizers', value: [WORKFLOW_FINALIZER] }],
      })
    )
  })

  it('preserves existing finalizers from other controllers', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { finalizers: ['kubernetes.io/pvc-protection'] },
      }),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as any

    await addFinalizer(customApi, 'my-recipe', 'sandbox-recipes')

    const patchArg = (customApi.patchNamespacedCustomObject as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(patchArg.body[0].value).toEqual(['kubernetes.io/pvc-protection', WORKFLOW_FINALIZER])
  })

  it('is idempotent — does not patch if finalizer already present', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { finalizers: [WORKFLOW_FINALIZER] },
      }),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as any

    await addFinalizer(customApi, 'my-recipe', 'sandbox-recipes')

    expect(customApi.patchNamespacedCustomObject).not.toHaveBeenCalled()
  })
})

describe('removeFinalizer', () => {
  it('removes only WORKFLOW_FINALIZER, leaving others intact', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { finalizers: ['kubernetes.io/pvc-protection', WORKFLOW_FINALIZER] },
      }),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as any

    await removeFinalizer(customApi, 'my-recipe', 'sandbox-recipes')

    const patchArg = (customApi.patchNamespacedCustomObject as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(patchArg.body[0].value).toEqual(['kubernetes.io/pvc-protection'])
  })

  it('patches with empty array when no other finalizers remain', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { finalizers: [WORKFLOW_FINALIZER] },
      }),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as any

    await removeFinalizer(customApi, 'my-recipe', 'sandbox-recipes')

    const patchArg = (customApi.patchNamespacedCustomObject as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(patchArg.body[0].value).toEqual([])
  })
})
