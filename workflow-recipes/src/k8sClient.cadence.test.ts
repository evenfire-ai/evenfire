import { describe, expect, it, vi } from 'vitest'
import { WorkflowRecipeWatcher } from './k8sClient'
import { registry } from './metrics'
import type { WorkflowRecipeCRD } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- private-member harness
type Any = any

function recipe(name = 'r', gen = 1): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name, namespace: 'sandbox-recipes', generation: gen, uid: `u-${name}` },
    spec: { steps: [], workloads: [{ id: 'api', type: 'deployment', image: 'x' }] },
    status: { phase: 'active' },
  } as unknown as WorkflowRecipeCRD
}

function harness(
  reconcileResult: Record<string, unknown> = {
    phase: 'active',
    message: 'ok',
    workloadStatuses: [],
    skipStatusPatch: true,
    cadence: { dnsBlocks: [], repairPending: false },
  }
) {
  const w: Any = Object.create(WorkflowRecipeWatcher.prototype)
  const queue: Array<() => Promise<unknown>> = []
  Object.assign(w, {
    recipes: new Map<string, WorkflowRecipeCRD>(),
    transientRetries: new Map(),
    stopped: false,
    traceReporter: null,
    dbRunProcessor: null,
    config: { sandboxNamespace: 'sandbox-recipes' },
    eventQueue: {
      enqueue: vi.fn((_k: string, t: () => Promise<unknown>) => {
        queue.push(t)
        return Promise.resolve()
      }),
    },
    reconciler: {
      isRecipeStillActive: vi.fn().mockResolvedValue(true),
      ensureFinalizer: vi.fn().mockResolvedValue(undefined),
      reconcile: vi.fn(async (r: WorkflowRecipeCRD) => {
        r.spec.workloads = []
        return { ...reconcileResult }
      }),
      patchStatus: vi.fn().mockResolvedValue(undefined),
    },
  })
  return {
    w,
    drain: async () => {
      while (queue.length) await queue.shift()!()
    },
  }
}

describe('handleRecipeEvent cadence plumbing (#1016)', () => {
  it('reconciles a clone so the cached recipe keeps its unfiltered spec', async () => {
    const { w } = harness()
    const r = recipe()
    await w.handleRecipeEvent('MODIFIED', r, { forceReconcile: true, trigger: 'watch' })
    expect(w.recipes.get('r').spec.workloads).toHaveLength(1)
  })

  it('passes the trigger to the reconciler for the "Reconciling recipe" log', async () => {
    const { w } = harness()
    await w.handleRecipeEvent('MODIFIED', recipe(), { forceReconcile: true, trigger: 'notify' })
    expect(w.reconciler.reconcile.mock.calls[0][1]).toEqual({ trigger: 'notify' })
  })

  it('stamps a settled pass (bare skipStatusPatch) and returns its outcome', async () => {
    const { w } = harness()
    const out = await w.handleRecipeEvent('MODIFIED', recipe(), {
      forceReconcile: true,
      trigger: 'steady_backstop',
    })
    expect(out).toMatchObject({ ran: true, settled: true })
    expect(w.cadence.lastSettledAt('r')).toBeTypeOf('number')
  })

  it('does not stamp an unsettled pass (requeue)', async () => {
    const { w } = harness({
      phase: 'degraded',
      message: 'x',
      workloadStatuses: [],
      requeueAfterMs: 5000,
      cadence: { dnsBlocks: [], repairPending: false },
    })
    const out = await w.handleRecipeEvent('MODIFIED', recipe(), {
      forceReconcile: true,
      trigger: 'infra_retry',
    })
    for (const { timer } of w.transientRetries.values()) clearTimeout(timer)
    expect(out.settled).toBe(false)
    expect(w.cadence.lastSettledAt('r')).toBeUndefined()
    expect(w.cadence.lastStartAt('r')).toBeTypeOf('number')
  })

  it('records the enforced ownership signature from ANY settled pass (here: secret_watch)', async () => {
    const { w } = harness({
      phase: 'active',
      message: 'ok',
      workloadStatuses: [],
      cadence: { dnsBlocks: [], enforcedOwnership: '', repairPending: false },
    })
    await w.handleRecipeEvent('MODIFIED', recipe(), {
      forceReconcile: true,
      trigger: 'secret_watch',
    })
    expect(w.cadence.enforcedOwnership('r')).toBe('')
  })

  it('counts the reconcile by trigger and outcome', async () => {
    const { w } = harness()
    await w.handleRecipeEvent('MODIFIED', recipe(), { forceReconcile: true, trigger: 'ownership' })
    expect(await registry.metrics()).toMatch(
      /clerum_wrc_reconciliations_total\{trigger="ownership",outcome="noop"[^}]*\} [1-9]/
    )
  })

  it('returns a not-ran outcome (never undefined) on an early return', async () => {
    const { w } = harness()
    w.reconciler.isRecipeStillActive.mockResolvedValue(false)
    const out = await w.handleRecipeEvent('MODIFIED', recipe(), { forceReconcile: true })
    expect(out).toEqual({ ran: false, settled: false })
  })

  it('forgets cadence and DNS-block records when the recipe leaves the cache', async () => {
    const { w } = harness()
    w.reconciler.forgetDnsBlockRecord = vi.fn()
    await w.handleRecipeEvent('MODIFIED', recipe(), { forceReconcile: true })
    expect(w.cadence.lastStartAt('r')).toBeTypeOf('number')
    await w.handleRecipeEvent('DELETED', recipe())
    expect(w.cadence.lastStartAt('r')).toBeUndefined()
    expect(w.cadence.lastSettledAt('r')).toBeUndefined()
    expect(w.reconciler.forgetDnsBlockRecord).toHaveBeenCalledWith('r')
  })

  it('SecretWatcher fan-out reconciles the NEWEST cached recipe (fresh read)', async () => {
    const { w, drain } = harness()
    w.recipes.set('r', recipe('r', 1))
    w.triggerSecretDrivenReconcile('r')
    w.recipes.set('r', recipe('r', 2))
    await drain()
    expect(w.reconciler.reconcile.mock.calls[0][0].metadata.generation).toBe(2)
  })

  it('transient retry reconciles the NEWEST cached recipe (fresh read)', async () => {
    vi.useFakeTimers()
    try {
      const { w, drain } = harness()
      w.recipes.set('r', recipe('r', 1))
      w.scheduleTransientRetry('r', 10, true)
      vi.advanceTimersByTime(10)
      w.recipes.set('r', recipe('r', 2))
      await drain()
      expect(w.reconciler.reconcile.mock.calls[0][0].metadata.generation).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
