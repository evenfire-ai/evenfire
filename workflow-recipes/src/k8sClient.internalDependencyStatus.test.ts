import { describe, expect, it } from 'vitest'
import { shouldPatchRecipeStatus } from './k8sClient'
import type { WorkflowRecipeCRD } from './types'

function makeWorkflowRecipe(overrides: Partial<WorkflowRecipeCRD> = {}): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: 'recipe',
      namespace: 'sandbox-recipes',
      ...(overrides.metadata ?? {}),
    },
    spec: {
      workloads: [{ id: 'api', type: 'deployment', image: 'api:test' }],
      ...(overrides.spec ?? {}),
    },
    status: overrides.status,
  }
}

describe('shouldPatchRecipeStatus internal dependency readiness', () => {
  it('does not patch when InternalDependenciesReady only changes lastTransitionTime', () => {
    const message = 'Reconciled 6 WRC internal dependency rule(s)'

    expect(
      shouldPatchRecipeStatus(
        makeWorkflowRecipe({
          status: {
            phase: 'active',
            message: 'All workloads deployed',
            conditions: [
              {
                type: 'InternalDependenciesReady',
                status: 'True',
                reason: 'Reconciled',
                message,
                lastTransitionTime: 'old',
              },
            ],
          },
        }),
        {
          phase: 'active',
          message: 'All workloads deployed',
          workloadStatuses: [],
          internalDependencyConditions: [
            {
              type: 'InternalDependenciesReady',
              status: 'True',
              reason: 'Reconciled',
              message,
              lastTransitionTime: 'now',
            },
          ],
        }
      )
    ).toBe(false)
  })

  it('honors skipStatusPatch even when InternalDependenciesReady is stale', () => {
    expect(
      shouldPatchRecipeStatus(
        makeWorkflowRecipe({
          spec: { steps: [{ id: 'run', instruction: 'run' }] },
          status: {
            phase: 'active',
            message: 'Workflow running',
            conditions: [
              {
                type: 'InternalDependenciesReady',
                status: 'False',
                reason: 'InvalidInternalDependency',
                message: 'stale',
                lastTransitionTime: 'old',
              },
            ],
          },
        }),
        {
          phase: 'active',
          message: 'Workflow running',
          workloadStatuses: [],
          skipStatusPatch: true,
        }
      )
    ).toBe(false)
  })
})
