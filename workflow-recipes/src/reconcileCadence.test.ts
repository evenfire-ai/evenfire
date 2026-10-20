import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'
import {
  CadenceState,
  classifyInfrastructureRetry,
  coalesceSpacingMs,
  isSettledResult,
  needsSteadyBackstop,
  steadyBackstopMs,
  workflowNeedsOwnershipBackstop,
} from './reconcileCadence'
import type { WorkflowRecipeCRD } from './types'

const base = (o: Partial<WorkflowRecipeCRD> = {}): WorkflowRecipeCRD =>
  ({
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'r', namespace: 'sandbox-recipes', generation: 1, uid: 'u1' },
    spec: { steps: [], workloads: [{ id: 'api', type: 'deployment', image: 'x' }] },
    status: { phase: 'active' },
    ...o,
  }) as WorkflowRecipeCRD

describe('steadyBackstopMs', () => {
  it('is 165s at defaults (lead 300 - 75 file margin - 2 x 30s tick)', () => {
    expect(steadyBackstopMs(loadConfig())).toEqual({ ms: 165_000, degenerate: false })
  })
  it('property: worst-case remint lands >= 75s before expiry, or degenerates to every tick', () => {
    for (let ttl = 10; ttl <= 3600; ttl += 37) {
      for (let before = 1; before < ttl; before += Math.max(1, Math.floor(ttl / 11))) {
        const cfg = {
          ...loadConfig(),
          runtimeTokenTtlSeconds: ttl,
          runtimeTokenRefreshBeforeSeconds: before,
        }
        const tick = coalesceSpacingMs(cfg) * 2
        const { ms, degenerate } = steadyBackstopMs(cfg)
        if (degenerate) {
          expect(ms).toBeLessThanOrEqual(tick)
          continue
        }
        const lead = Math.min(Math.max(1, ttl - 5), Math.max(before, 75)) * 1000
        // a pass started just outside the remint window, then the next backstop slips one tick
        const marginAtRemint = lead - (ms + tick)
        expect(marginAtRemint).toBeGreaterThanOrEqual(75_000)
      }
    }
  })
})

describe('isSettledResult', () => {
  it('treats a bare skipStatusPatch as settled', () => {
    expect(isSettledResult({ cadence: { repairPending: false } })).toBe(true)
  })
  it('is unsettled with a requeue or a pending repair', () => {
    expect(isSettledResult({ requeueAfterMs: 5000 })).toBe(false)
    expect(isSettledResult({ cadence: { repairPending: true } })).toBe(false)
  })
  it('is unsettled for a stale (deleting or gone) result', () => {
    expect(isSettledResult({ cadence: { repairPending: false, stale: true } })).toBe(false)
  })
})

describe('classifyInfrastructureRetry', () => {
  it('stuck for initializing/recovering workflows', () => {
    const r = base({
      spec: { steps: [{ id: 's' }] as never, workloads: [] },
      status: { phase: 'deploying', workflowExecution: { phase: 'initializing' } } as never,
    })
    expect(classifyInfrastructureRetry(r)).toBe('stuck')
  })
  it('sdk_liveness for stepless SDK and SDK no-run workflows', () => {
    expect(
      classifyInfrastructureRetry(
        base({ spec: { steps: [], workloads: [], pluginWorkloadSdk: {} } as never })
      )
    ).toBe('sdk_liveness')
    expect(
      classifyInfrastructureRetry(
        base({ spec: { steps: [{ id: 's' }], workloads: [], pluginWorkloadSdk: {} } as never })
      )
    ).toBe('sdk_liveness')
  })
  it('none for a plain active classic recipe', () => {
    expect(classifyInfrastructureRetry(base())).toBe('none')
  })
})

describe('workflowNeedsOwnershipBackstop (widened, #637 stepless-SDK gap)', () => {
  const secretWl = [{ id: 'api', type: 'deployment', image: 'x', envSecret: { name: 's' } }]
  it('selects stepless SDK recipes with named Secrets', () => {
    expect(
      workflowNeedsOwnershipBackstop(
        base({ spec: { steps: [], workloads: secretWl, pluginWorkloadSdk: {} } as never })
      )
    ).toBe(true)
  })
  it('still selects workflow recipes and skips classic ones', () => {
    expect(
      workflowNeedsOwnershipBackstop(
        base({ spec: { steps: [{ id: 's' }], workloads: secretWl } as never })
      )
    ).toBe(true)
    expect(
      workflowNeedsOwnershipBackstop(base({ spec: { steps: [], workloads: secretWl } as never }))
    ).toBe(false)
  })
})

describe('needsSteadyBackstop', () => {
  it('includes a steady non-SDK workflow whose only forcing predicate is external egress', () => {
    const r = base({
      spec: {
        steps: [{ id: 's' }],
        workloads: [],
        ui: { egress: { external: [{ fqdn: 'api.github.com', port: 443 }] } },
      } as never,
    })
    expect(needsSteadyBackstop(r)).toBe(true)
  })
  it('excludes a recipe in no forcing predicate', () => {
    expect(needsSteadyBackstop(base())).toBe(false)
  })
})

describe('CadenceState', () => {
  it('stamps settled passes, tracks starts, and forgets a recipe', () => {
    const s = new CadenceState()
    s.recordPassStart('r', 1000)
    s.recordSettled('r', 1000, 'sig-a')
    expect(s.lastStartAt('r')).toBe(1000)
    expect(s.lastSettledAt('r')).toBe(1000)
    expect(s.enforcedOwnership('r')).toBe('sig-a')
    s.forget('r')
    expect(s.lastSettledAt('r')).toBeUndefined()
    expect(s.enforcedOwnership('r')).toBeUndefined()
  })
  it('a pass that ran no gate keeps the previous enforced signature', () => {
    const s = new CadenceState()
    s.recordSettled('r', 1, 'sig-a')
    s.recordSettled('r', 2, undefined)
    expect(s.enforcedOwnership('r')).toBe('sig-a')
  })
})
