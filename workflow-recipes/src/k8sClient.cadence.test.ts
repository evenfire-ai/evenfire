import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config'
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
    config: { ...loadConfig(), sandboxNamespace: 'sandbox-recipes' },
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

  it('does not stamp a stale result and clears earlier cadence state for the recipe', async () => {
    const { w } = harness({
      phase: 'active',
      message: 'Recipe deleted during reconcile; skipped initial check',
      workloadStatuses: [],
      skipStatusPatch: true,
      cadence: { dnsBlocks: [], enforcedOwnership: 'a|b', repairPending: false, stale: true },
    })
    w.cadence.recordSettled('r', 1, 'old-sig')
    const out = await w.handleRecipeEvent('MODIFIED', recipe(), {
      forceReconcile: true,
      trigger: 'watch',
    })
    expect(out.settled).toBe(false)
    expect(w.cadence.lastSettledAt('r')).toBeUndefined()
    expect(w.cadence.enforcedOwnership('r')).toBeUndefined()
    // Cache removal is left to the deletion event.
    expect(w.recipes.has('r')).toBe(true)
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

describe('timer task wrapper (#1016)', () => {
  const T0 = new Date('2026-10-08T12:00:00Z').getTime()
  const counter = async (timer: string, result: string) => {
    const m = (await registry.getSingleMetric('clerum_wrc_timer_checks_total')!.get()).values
    return m.find(v => v.labels.timer === timer && v.labels.result === result)?.value ?? 0
  }
  const withTime = async (fn: () => Promise<void>) => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    try {
      await fn()
    } finally {
      vi.useRealTimers()
    }
  }

  it('drops a duplicate enqueue while the first is queued and counts coalesced', async () => {
    const { w, drain } = harness()
    w.recipes.set('r', recipe())
    const before = await counter('egress', 'coalesced')
    const task = vi.fn().mockResolvedValue(undefined)
    void w.enqueueTimerTask('r', 'egress', task)
    void w.enqueueTimerTask('r', 'egress', task)
    await drain()
    expect(task).toHaveBeenCalledTimes(1)
    expect(await counter('egress', 'coalesced')).toBe(before + 1)
    expect(w.cadence.pendingTimerTasks.size).toBe(0)
  })

  it('skips the task when the recipe left the cache before it ran', async () => {
    const { w, drain } = harness()
    w.recipes.set('r', recipe())
    const before = await counter('egress', 'skipped')
    const task = vi.fn()
    void w.enqueueTimerTask('r', 'egress', task)
    w.recipes.delete('r')
    await drain()
    expect(task).not.toHaveBeenCalled()
    expect(await counter('egress', 'skipped')).toBe(before + 1)
    expect(w.cadence.pendingTimerTasks.size).toBe(0)
  })

  it('hands the task the NEWEST cached recipe (fresh read)', async () => {
    const { w, drain } = harness()
    w.recipes.set('r', recipe('r', 1))
    const task = vi.fn().mockResolvedValue(undefined)
    void w.enqueueTimerTask('r', 'egress', task)
    w.recipes.set('r', recipe('r', 2))
    await drain()
    expect(task.mock.calls[0][0].metadata.generation).toBe(2)
  })

  it('catches task errors (counts error, clears the pending key, never rejects)', async () => {
    const { w, drain } = harness()
    w.recipes.set('r', recipe())
    const before = await counter('egress', 'error')
    const p = w.enqueueTimerTask('r', 'egress', async () => {
      throw new Error('boom')
    })
    await drain()
    await expect(p).resolves.toBeUndefined()
    expect(await counter('egress', 'error')).toBe(before + 1)
    expect(w.cadence.pendingTimerTasks.size).toBe(0)
  })

  it('spacing: a pass started 10s ago (spacing 15s) coalesces', () =>
    withTime(async () => {
      const { w } = harness()
      w.cadence.recordPassStart('r', T0 - 10_000)
      expect(await w.escalate(recipe(), 'infra_retry', 'infra_retry', 'spacing')).toBe('coalesced')
      expect(w.reconciler.reconcile).not.toHaveBeenCalled()
    }))

  it('spacing: a pass started 16s ago runs', () =>
    withTime(async () => {
      const { w } = harness()
      w.cadence.recordPassStart('r', T0 - 16_000)
      const out = await w.escalate(recipe(), 'infra_retry', 'infra_retry', 'spacing')
      expect(out).toMatchObject({ ran: true })
      expect(w.reconciler.reconcile).toHaveBeenCalledTimes(1)
    }))

  it('spacing: three consecutive 30s ticks with 2s reconciles run three times', () =>
    withTime(async () => {
      const { w } = harness()
      w.reconciler.reconcile.mockImplementation(async (r: WorkflowRecipeCRD) => {
        r.spec.workloads = []
        await new Promise(res => setTimeout(res, 2_000))
        return {
          phase: 'active',
          message: 'ok',
          workloadStatuses: [],
          skipStatusPatch: true,
          cadence: { dnsBlocks: [], repairPending: false },
        }
      })
      for (let i = 0; i < 3; i++) {
        const p = w.escalate(recipe(), 'infra_retry', 'infra_retry', 'spacing')
        await vi.advanceTimersByTimeAsync(2_000)
        expect(await p).not.toBe('coalesced')
        await vi.advanceTimersByTimeAsync(28_000)
      }
      expect(w.reconciler.reconcile).toHaveBeenCalledTimes(3)
    }))

  it('backstop: settled 100s ago (backstop 165s) coalesces', () =>
    withTime(async () => {
      const { w } = harness()
      w.cadence.recordSettled('r', T0 - 100_000, '')
      expect(await w.escalate(recipe(), 'steady_backstop', 'steady_backstop', 'backstop')).toBe(
        'coalesced'
      )
    }))

  it('backstop: settled 170s ago runs', () =>
    withTime(async () => {
      const { w } = harness()
      w.cadence.recordSettled('r', T0 - 170_000, '')
      const out = await w.escalate(recipe(), 'steady_backstop', 'steady_backstop', 'backstop')
      expect(out).toMatchObject({ ran: true })
    }))

  it('backstop: no settled stamp runs', () =>
    withTime(async () => {
      const { w } = harness()
      const out = await w.escalate(recipe(), 'steady_backstop', 'steady_backstop', 'backstop')
      expect(out).toMatchObject({ ran: true })
    }))

  it('coalesce=false runs even when a pass started 1s ago', () =>
    withTime(async () => {
      const { w } = harness()
      w.cadence.recordPassStart('r', T0 - 1_000)
      const out = await w.escalate(recipe(), 'ownership', 'ownership', false)
      expect(out).toMatchObject({ ran: true })
    }))
})

describe('T3 egress lane timer (#1016 §3.3)', () => {
  const T0 = new Date('2026-10-08T12:00:00Z').getTime()
  const counter = async (timer: string, result: string) => {
    const m = (await registry.getSingleMetric('clerum_wrc_timer_checks_total')!.get()).values
    return m.find(v => v.labels.timer === timer && v.labels.result === result)?.value ?? 0
  }
  const egressRecipe = (name = 'r'): WorkflowRecipeCRD => {
    const r = recipe(name)
    ;(r.spec as Any).ui = {
      workloadRef: 'api',
      port: 8080,
      egress: { external: [{ fqdn: 'api.github.com', port: 443 }] },
    }
    return r
  }
  const lane = (result: 'clean' | 'stale' | 'none' | Error = 'clean') => {
    const policies = [{ metadata: { name: 'p' } }]
    const h = harness()
    Object.assign(h.w.reconciler, {
      listPoliciesForLane: vi.fn().mockResolvedValue(policies),
      refreshDnsBlocks: vi.fn(async () => {
        if (result instanceof Error) throw result
        return result
      }),
    })
    h.w.recipes.set('r', egressRecipe())
    return { ...h, policies }
  }
  const tick = async (h: ReturnType<typeof lane>) => {
    const p = h.w.refreshExternalEgressForActiveRecipes()
    // let the policy list resolve and the tasks enqueue, then run the queue
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await h.drain()
    await p
  }

  it("'clean' replays the lane with the fresh recipe and policies; no reconcile", async () => {
    const h = lane('clean')
    const before = await counter('egress', 'clean')
    await tick(h)
    expect(h.w.reconciler.refreshDnsBlocks).toHaveBeenCalledTimes(1)
    expect(h.w.reconciler.refreshDnsBlocks).toHaveBeenCalledWith(h.w.recipes.get('r'), h.policies)
    expect(h.w.reconciler.reconcile).not.toHaveBeenCalled()
    expect(await counter('egress', 'clean')).toBe(before + 1)
  })

  it("'none' does not reconcile and counts as clean", async () => {
    const h = lane('none')
    const before = await counter('egress', 'clean')
    await tick(h)
    expect(h.w.reconciler.reconcile).not.toHaveBeenCalled()
    expect(await counter('egress', 'clean')).toBe(before + 1)
  })

  it("a failed classic recipe with egress never reconciles over 10 ticks (lane 'none')", async () => {
    const h = lane('none')
    h.w.recipes.set('r', { ...egressRecipe(), status: { phase: 'failed' } })
    for (let i = 0; i < 10; i++) await tick(h)
    expect(h.w.reconciler.refreshDnsBlocks).toHaveBeenCalledTimes(10)
    expect(h.w.reconciler.reconcile).not.toHaveBeenCalled()
  })

  it("'stale' escalates once as egress_fallback with spacing coalescing", async () => {
    const h = lane('stale')
    h.w.handleRecipeEvent = vi.fn().mockResolvedValue({ ran: true, settled: true })
    const spy = vi.spyOn(h.w, 'escalate')
    await tick(h)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(h.w.recipes.get('r'), 'egress_fallback', 'egress', 'spacing')
    expect(h.w.handleRecipeEvent).toHaveBeenCalledWith('MODIFIED', h.w.recipes.get('r'), {
      forceReconcile: true,
      trigger: 'egress_fallback',
    })
  })

  it("'stale' within spacing of a recent pass start is coalesced", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    try {
      const h = lane('stale')
      h.w.cadence.recordPassStart('r', T0 - 1_000)
      await tick(h)
      expect(h.w.reconciler.reconcile).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a lane throw escalates egress_fallback NOT coalesced, even with a start stamped 1s ago', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    try {
      const h = lane(new Error('block failed'))
      h.w.cadence.recordPassStart('r', T0 - 1_000)
      const spy = vi.spyOn(h.w, 'escalate')
      await tick(h)
      expect(spy).toHaveBeenCalledWith(h.w.recipes.get('r'), 'egress_fallback', 'egress', false)
      expect(h.w.reconciler.reconcile).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists policies once per tick, not once per recipe', async () => {
    const h = lane('clean')
    h.w.recipes.set('r2', egressRecipe('r2'))
    h.w.recipes.set('r3', egressRecipe('r3'))
    await tick(h)
    expect(h.w.reconciler.refreshDnsBlocks).toHaveBeenCalledTimes(3)
    expect(h.w.reconciler.listPoliciesForLane).toHaveBeenCalledTimes(1)
    expect(h.w.reconciler.listPoliciesForLane).toHaveBeenCalledWith('sandbox-recipes')
  })

  it('skips the whole pass (no lane, no escalation) when listing policies throws', async () => {
    const h = lane('stale')
    h.w.reconciler.listPoliciesForLane.mockRejectedValue(new Error('api down'))
    await tick(h)
    expect(h.w.reconciler.refreshDnsBlocks).not.toHaveBeenCalled()
    expect(h.w.reconciler.reconcile).not.toHaveBeenCalled()
  })

  it('re-checks egress selection against the fresh recipe inside the task', async () => {
    const h = lane('stale')
    const p = h.w.refreshExternalEgressForActiveRecipes()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    h.w.recipes.set('r', recipe('r', 2)) // egress removed while queued
    await h.drain()
    await p
    expect(h.w.reconciler.refreshDnsBlocks).not.toHaveBeenCalled()
  })
})
