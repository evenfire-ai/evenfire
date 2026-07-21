import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import type { WorkflowRecipeCRD } from '../types'
import { INHERITED_PARENT_RESOURCES_ANNOTATION } from '../workflow/childRecipeFactory'
import {
  RuntimeScopeResolutionPendingError,
  WorkflowRecipeReconciler,
} from './workflowRecipeReconciler'

const mockCustomApi = {
  getNamespacedCustomObject: vi.fn(),
}

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    makeApiClient: vi
      .fn()
      .mockImplementation((ApiClass: unknown) =>
        (ApiClass as { name?: string }).name === 'CustomObjectsApi' ? mockCustomApi : {}
      ),
  })),
  AppsV1Api: { name: 'AppsV1Api' },
  BatchV1Api: { name: 'BatchV1Api' },
  CoreV1Api: { name: 'CoreV1Api' },
  CustomObjectsApi: { name: 'CustomObjectsApi' },
  NetworkingV1Api: { name: 'NetworkingV1Api' },
}))

function dbRunChild(): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: 'parent-recipe-run-00000000',
      namespace: 'sandbox-recipes',
      uid: 'uid-child',
      annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
      labels: {
        'clerum.io/parent-recipe': 'parent-recipe',
        'clerum.io/workflow-run-id': '00000000-0000-4000-8000-000000000123',
      },
      ownerReferences: [
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          name: 'parent-recipe',
          uid: 'uid-parent-recipe',
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: { steps: [{ id: 'research', instruction: 'run' }] },
  }
}

describe('WorkflowRecipe owner provenance', () => {
  beforeEach(() => vi.clearAllMocks())

  it('treats a non-404 owner lookup failure as retryable instead of child identity', async () => {
    mockCustomApi.getNamespacedCustomObject.mockRejectedValueOnce({ code: 503 })
    const verifyWorkflowRunProvenance = vi.fn().mockResolvedValue('verified')
    const reconciler = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      verifyWorkflowRunProvenance,
    })

    await expect(
      (
        reconciler as unknown as {
          workflowRuntimeScopeRecipeName: (recipe: WorkflowRecipeCRD) => Promise<string>
        }
      ).workflowRuntimeScopeRecipeName(dbRunChild())
    ).rejects.toBeInstanceOf(RuntimeScopeResolutionPendingError)
    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'clerum.io',
      version: 'v1alpha1',
      namespace: 'sandbox-recipes',
      plural: 'workflowrecipes',
      name: 'parent-recipe',
    })
    expect(verifyWorkflowRunProvenance).not.toHaveBeenCalled()
  })
})
