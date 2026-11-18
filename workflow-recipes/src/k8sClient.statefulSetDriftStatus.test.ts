import { afterEach, describe, expect, it, vi } from 'vitest'
import { shouldPatchRecipeStatus } from './k8sClient'
import type { ReconcileResult } from './reconciler/workflowRecipeReconciler'
import type { StatusCondition, WorkflowRecipeCRD } from './types'

// Issue #1518: the StatefulSetImmutableDrift condition can appear, change or
// clear while phase, message and workload statuses stay equal. Every fixture
// below keeps those three equal between the stored status and the result, so
// the only difference the decision can see is the drift condition list.

const PHASE = 'degraded'
const MESSAGE = 'Reconciled with workload failures; requeueing'
const WORKLOAD_MESSAGE = 'StatefulSet "db" is not ready'

function driftCondition(name: string, fields = 'spec.serviceName'): StatusCondition {
  const message =
    `ImmutableStatefulSetDrift: StatefulSet "${name}" in sandbox-recipes has immutable drift in ` +
    `${fields}; WRC will not full-replace StatefulSets. ` +
    'Recreate through an explicit data-safe migration.'
  return {
    type: 'StatefulSetImmutableDrift',
    status: 'True',
    reason: 'ImmutableStatefulSetDrift',
    message,
    lastTransitionTime: new Date().toISOString(),
  }
}

function makeRecipe(conditions: StatusCondition[] | undefined): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'recipe', namespace: 'sandbox-recipes' },
    spec: {
      workloads: [
        { id: 'db', type: 'statefulset', image: 'db:test' },
        { id: 'cache', type: 'statefulset', image: 'cache:test' },
      ],
    },
    status: {
      phase: PHASE,
      message: MESSAGE,
      workloads: [
        {
          id: 'db',
          type: 'statefulset',
          phase: 'failed',
          ready: false,
          message: WORKLOAD_MESSAGE,
        },
      ],
      ...(conditions === undefined ? {} : { conditions }),
    },
  }
}

function makeResult(overrides: Partial<ReconcileResult> = {}): ReconcileResult {
  return {
    phase: PHASE,
    message: MESSAGE,
    workloadStatuses: [{ id: 'db', phase: 'failed', ready: false, message: WORKLOAD_MESSAGE }],
    ...overrides,
  }
}

describe('shouldPatchRecipeStatus StatefulSetImmutableDrift condition (issue #1518)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('patches when the result carries a drift condition the stored status lacks (i)', () => {
    const recipe = makeRecipe(undefined)
    const result = makeResult({ workloadConditions: [driftCondition('db')] })

    expect(shouldPatchRecipeStatus(recipe, result)).toBe(true)
  })

  it('patches when the result clears a drift condition the stored status holds (iii)', () => {
    const recipe = makeRecipe([driftCondition('db')])
    const result = makeResult({ workloadConditions: [] })

    expect(shouldPatchRecipeStatus(recipe, result)).toBe(true)
  })

  it('patches when the first of two drift conditions changes its message (vi)', () => {
    const recipe = makeRecipe([driftCondition('db'), driftCondition('cache')])
    const result = makeResult({
      workloadConditions: [
        driftCondition('db', 'spec.serviceName, spec.volumeClaimTemplates'),
        driftCondition('cache'),
      ],
    })

    expect(shouldPatchRecipeStatus(recipe, result)).toBe(true)
  })

  it('does not patch when only lastTransitionTime differs (ii)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'))
    const stored = driftCondition('db')
    vi.setSystemTime(new Date('2026-11-17T10:00:30.000Z'))
    const fresh = driftCondition('db')

    // Witness: the two conditions differ in lastTransitionTime and in nothing else.
    expect(stored.lastTransitionTime).not.toBe(fresh.lastTransitionTime)
    expect({ ...stored, lastTransitionTime: fresh.lastTransitionTime }).toEqual(fresh)

    expect(
      shouldPatchRecipeStatus(makeRecipe([stored]), makeResult({ workloadConditions: [fresh] }))
    ).toBe(false)
  })

  it('does not patch when the result has no opinion on drift (iv)', () => {
    // Same stored status as row (iii), which patches when the result clears it.
    const recipe = makeRecipe([driftCondition('db')])
    expect(recipe.status?.conditions?.map(condition => condition.type)).toEqual([
      'StatefulSetImmutableDrift',
    ])

    expect(shouldPatchRecipeStatus(recipe, makeResult({ workloadConditions: undefined }))).toBe(
      false
    )
  })

  it('honors skipStatusPatch even when the drift condition is new (v)', () => {
    // Same fixture as row (i), which patches without skipStatusPatch.
    const recipe = makeRecipe(undefined)
    const workloadConditions = [driftCondition('db')]
    expect(recipe.status?.conditions).toBeUndefined()

    expect(
      shouldPatchRecipeStatus(recipe, makeResult({ workloadConditions, skipStatusPatch: true }))
    ).toBe(false)
  })
})
