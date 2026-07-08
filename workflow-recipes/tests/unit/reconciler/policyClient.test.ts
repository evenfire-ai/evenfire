/**
 * Tests for policyClient.ts
 * Step 4.9 (G-09)
 */
import { describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { listWorkflowRecipePolicies } from '../../../src/reconciler/policyClient'

function makeMockCustomApi(overrides?: Partial<k8s.CustomObjectsApi>): k8s.CustomObjectsApi {
  return {
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    ...overrides,
  } as unknown as k8s.CustomObjectsApi
}

describe('listWorkflowRecipePolicies', () => {
  it('returns array of policies when CRD exists', async () => {
    const policy = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipePolicy',
      metadata: { name: 'default-policy', namespace: 'sandbox-recipes' },
      spec: { enforcement: 'enforcing' },
    }
    const api = makeMockCustomApi({
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [policy] }),
    })

    const result = await listWorkflowRecipePolicies(api, 'sandbox-recipes')
    expect(result).toHaveLength(1)
    expect(result[0].metadata.name).toBe('default-policy')
  })

  it('returns empty array when list returns no items', async () => {
    const api = makeMockCustomApi()
    const result = await listWorkflowRecipePolicies(api, 'sandbox-recipes')
    expect(result).toEqual([])
  })

  it('returns empty array when CRD is not installed (404)', async () => {
    const api = makeMockCustomApi({
      listNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
    })

    const result = await listWorkflowRecipePolicies(api, 'sandbox-recipes')
    expect(result).toEqual([])
  })

  it('rethrows non-404 K8s errors', async () => {
    const api = makeMockCustomApi({
      listNamespacedCustomObject: vi
        .fn()
        .mockRejectedValue({ code: 500, message: 'Internal Server Error' }),
    })

    await expect(listWorkflowRecipePolicies(api, 'sandbox-recipes')).rejects.toMatchObject({
      code: 500,
    })
  })

  it('rethrows network-level errors (no code property)', async () => {
    const networkError = new Error('ECONNREFUSED')
    const api = makeMockCustomApi({
      listNamespacedCustomObject: vi.fn().mockRejectedValue(networkError),
    })

    await expect(listWorkflowRecipePolicies(api, 'sandbox-recipes')).rejects.toThrow('ECONNREFUSED')
  })

  it('passes the namespace to the K8s API call', async () => {
    const listFn = vi.fn().mockResolvedValue({ items: [] })
    const api = makeMockCustomApi({ listNamespacedCustomObject: listFn })

    await listWorkflowRecipePolicies(api, 'control-plane')

    expect(listFn).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'control-plane' }))
  })
})
