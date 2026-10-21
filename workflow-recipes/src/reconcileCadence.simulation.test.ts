/**
 * Issue #1016 — mixed-fleet cadence simulation. Runs the REAL T1/T2/T3 timer
 * loops of the watcher under fake timers against a nine-recipe fleet and pins the
 * full-reconcile budget, then simulates a WRC restart (fresh CadenceState).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config'
import {
  WorkflowRecipeWatcher,
  externalEgressRefreshIntervalMs,
  recipeHasExternalExactHostEgress,
  runtimeCredentialRefreshIntervalMs,
  workflowNeedsInfrastructureReconcile,
  workflowNeedsWorkloadStatusRefresh,
} from './k8sClient'
import { CadenceState, workflowNeedsOwnershipBackstop } from './reconcileCadence'
import type { WorkflowRecipeCRD } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- private-member harness
type Any = any

const T0 = new Date('2026-10-08T12:00:00Z').getTime()
const SIM_MS = 10 * 60_000
const STEP_MS = 2_500
const RECONCILE_BUDGET = 40

type Klass = 'sdk' | 'secrets' | 'egress' | 'workflowEgress' | 'failedEgress'

const EXTERNAL_EGRESS = {
  workloadRef: 'api',
  port: 8080,
  egress: { external: [{ fqdn: 'a.example.com', port: 443 }] },
}

function fleetRecipe(klass: Klass, name: string): WorkflowRecipeCRD {
  const r = {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name, namespace: 'sandbox-recipes', generation: 1, uid: `u-${name}` },
    spec: { steps: [], workloads: [{ id: 'api', type: 'deployment', image: 'x' }] },
    status: { phase: 'active' },
  } as unknown as WorkflowRecipeCRD
  const spec = r.spec as Any
  switch (klass) {
    case 'sdk':
      // SDK no-run workflow: steps present, no workflowExecution, healthy validated pod.
      spec.steps = [{ id: 's1', instruction: 'go' }]
      spec.workloads = []
      spec.pluginWorkloadSdk = { promptBridge: {} }
      r.status = {
        phase: 'active',
        pluginWorkloadSdk: { state: 'validated', bootstrapPodUid: `pod-${name}` },
      } as Any
      break
    case 'secrets':
      spec.workloads = [{ id: 'api', type: 'deployment', image: 'x', envSecret: { name: 's' } }]
      break
    case 'egress':
      spec.ui = EXTERNAL_EGRESS
      break
    case 'workflowEgress':
      spec.steps = [{ id: 's1', instruction: 'go' }]
      spec.ui = EXTERNAL_EGRESS
      r.status = { phase: 'active', workflowExecution: { phase: 'completed' } } as Any
      break
    case 'failedEgress':
      spec.ui = EXTERNAL_EGRESS
      r.status = { phase: 'failed' } as Any
      break
  }
  return r
}

const FLEET: Array<[Klass, number]> = [
  ['sdk', 3],
  ['secrets', 2],
  ['egress', 2],
  ['workflowEgress', 1],
  ['failedEgress', 1],
]

function simulation() {
  const w: Any = Object.create(WorkflowRecipeWatcher.prototype)
  const queue: Array<() => Promise<unknown>> = []
  const classes = new Map<string, Klass>()
  const recipes = new Map<string, WorkflowRecipeCRD>()
  for (const [klass, n] of FLEET) {
    for (let i = 0; i < n; i++) {
      const name = `${klass}-${i}`
      classes.set(name, klass)
      recipes.set(name, fleetRecipe(klass, name))
    }
  }
  const triggers: string[] = []
  Object.assign(w, {
    recipes,
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
    _coreApi: {
      readNamespacedPod: vi.fn(async ({ name }: { name: string }) => ({
        metadata: { uid: `pod-${name.replace(/-mcp-host$/, '')}` },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      })),
    },
    reconciler: {
      externalEgressRefreshMinTtlMs: 15_000,
      isRecipeStillActive: vi.fn().mockResolvedValue(true),
      ensureFinalizer: vi.fn().mockResolvedValue(undefined),
      forgetDnsBlockRecord: vi.fn(),
      patchStatus: vi.fn().mockResolvedValue(undefined),
      refreshInProgressWorkflowRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
      listPoliciesForLane: vi.fn().mockResolvedValue([]),
      observeSecretOwnership: vi.fn().mockResolvedValue({ kind: 'ok', signature: '' }),
      observeCurrentWorkloadStatus: vi.fn(async (r: WorkflowRecipeCRD) => ({
        phase: 'active',
        message: 'ok',
        workloadStatuses: (r.spec.workloads ?? []).map(wl => ({ id: wl.id, ready: true })),
        skipStatusPatch: true,
      })),
      refreshDnsBlocks: vi.fn(async (r: WorkflowRecipeCRD) =>
        classes.get(r.metadata.name) === 'failedEgress' ? 'none' : 'clean'
      ),
      reconcile: vi.fn(async (r: WorkflowRecipeCRD, opts?: { trigger?: string }) => {
        triggers.push(opts?.trigger ?? 'watch')
        const hasEgress = recipeHasExternalExactHostEgress(r)
        return {
          phase: r.status?.phase ?? 'active',
          message: 'ok',
          workloadStatuses: [],
          skipStatusPatch: true,
          cadence: {
            dnsBlocks: hasEgress ? ['recipe_egress'] : [],
            enforcedOwnership: '',
            repairPending: false,
          },
        }
      }),
    },
  })

  const drain = async () => {
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 10; i++) await Promise.resolve()
      while (queue.length) await queue.shift()!()
    }
  }
  const advance = async (totalMs: number) => {
    for (let elapsed = 0; elapsed < totalMs; elapsed += STEP_MS) {
      await vi.advanceTimersByTimeAsync(STEP_MS)
      await drain()
    }
  }
  const count = (trigger: string) => triggers.filter(t => t === trigger).length
  return { w, advance, triggers, count, drain }
}

describe('mixed-fleet cadence simulation (#1016)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays within the full-reconcile budget over 10 minutes and survives a restart without an ownership burst', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const { w, advance, triggers, count, drain } = simulation()
    const all = [...w.recipes.values()] as WorkflowRecipeCRD[]
    expect(all).toHaveLength(9)

    // T1 = 30s, T2 = 30s, T3 = 7.5s.
    const t1Ms = runtimeCredentialRefreshIntervalMs(w.config)
    const t3Ms = externalEgressRefreshIntervalMs(w.config, 15_000)
    expect(t1Ms).toBe(30_000)
    expect(t3Ms).toBe(7_500)

    w.startRuntimeCredentialRefreshLoop()
    w.startWorkloadStatusRefreshLoop()
    w.startExternalEgressRefreshLoop()
    try {
      await advance(SIM_MS)

      const total = w.reconciler.reconcile.mock.calls.length
      // Old behaviour: every timer forced a full reconcile of every recipe it selected,
      // on every tick (T1 infra-needing, T2 status/ownership-needing, T3 egress).
      const oldEstimate =
        (SIM_MS / t1Ms) * all.filter(workflowNeedsInfrastructureReconcile).length +
        (SIM_MS / 30_000) *
          all.filter(
            r => workflowNeedsWorkloadStatusRefresh(r) || workflowNeedsOwnershipBackstop(r)
          ).length +
        (SIM_MS / t3Ms) * all.filter(recipeHasExternalExactHostEgress).length
      expect(total).toBeLessThanOrEqual(RECONCILE_BUDGET)
      const byTrigger = JSON.stringify(
        Object.fromEntries([...new Set(triggers)].map(t => [t, count(t)]))
      )
      const detail = `reconciles=${total} old-behaviour=${oldEstimate} byTrigger=${byTrigger}`
      expect(total, detail).toBeLessThanOrEqual(RECONCILE_BUDGET)

      // Positive evidence (the budget must not pass vacuously): every recipe was
      // backstopped about 4 times (165s backstop on a 30s tick over 600s).
      const callsFor = (mock: { mock: { calls: Any[][] } }, name: string): number =>
        mock.mock.calls.filter(c => (c[0]?.metadata?.name ?? c[0]?.name) === name).length
      const names = all.map(r => r.metadata.name)
      for (const name of names) {
        expect(
          callsFor(w.reconciler.reconcile, name),
          `${name} backstops: ${detail}`
        ).toBeGreaterThanOrEqual(3)
      }
      expect(total, detail).toBeGreaterThanOrEqual(27)
      // Each class stayed on its own narrow path.
      for (const name of names.filter(n => n.startsWith('sdk-'))) {
        expect(
          w._coreApi.readNamespacedPod.mock.calls.filter(
            (c: Any[]) => c[0].name === `${name}-mcp-host`
          ).length,
          `${name} pod probe`
        ).toBeGreaterThan(0)
      }
      for (const name of names.filter(n => n.startsWith('secrets-'))) {
        expect(
          callsFor(w.reconciler.observeSecretOwnership, name),
          `${name} ownership`
        ).toBeGreaterThan(0)
      }
      for (const name of names.filter(n => /^(egress|workflowEgress|failedEgress)/.test(n))) {
        expect(
          callsFor(w.reconciler.refreshDnsBlocks, name),
          `${name} egress lane`
        ).toBeGreaterThanOrEqual(60)
      }
      // The failed classic recipe's lane answers 'none' and it only ever backstops.
      const failedIdx = w.reconciler.refreshDnsBlocks.mock.calls
        .map((c: Any[], i: number) => (c[0].metadata.name === 'failedEgress-0' ? i : -1))
        .filter((i: number) => i >= 0)
      expect(failedIdx.length).toBeGreaterThan(0)
      for (const i of failedIdx) {
        expect(await w.reconciler.refreshDnsBlocks.mock.results[i].value).toBe('none')
      }
      expect(
        triggers.filter(
          (_, i) => w.reconciler.reconcile.mock.calls[i][0].metadata.name === 'failedEgress-0'
        )
      ).toEqual(
        Array(4)
          .fill('steady_backstop')
          .slice(0, callsFor(w.reconciler.reconcile, 'failedEgress-0'))
      )
      // A healthy fleet has nothing to repair: only the steady backstop drives full passes.
      for (const t of [
        'ownership',
        'sdk_liveness',
        'egress_fallback',
        'workload_status',
        'infra_retry',
      ]) {
        expect(count(t), t).toBe(0)
      }
      expect(count('steady_backstop')).toBe(total)

      // Restart: fresh CadenceState over the same cache, one more tick of every timer.
      triggers.length = 0
      const ownershipBefore = w.reconciler.observeSecretOwnership.mock.calls.length
      w._cadence = new CadenceState()
      await advance(t1Ms)
      await drain()
      expect(triggers.length).toBeGreaterThan(0)
      expect(w.reconciler.observeSecretOwnership.mock.calls.length).toBeGreaterThan(ownershipBefore)
      expect(count('ownership')).toBe(0)
      expect(triggers.every(t => t === 'steady_backstop')).toBe(true)
      expect(triggers.length).toBeLessThanOrEqual(all.length)
    } finally {
      await w.stop().catch(() => undefined)
    }
  })
})
