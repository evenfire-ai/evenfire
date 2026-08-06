import { describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { listRecipePodsAcrossNamespaces } from '../src/k8s.js'

// listPodsForRecipe used to call listPodForAllNamespaces (cluster-scoped).
// On managed shared tenants control-api only has namespaced RBAC, so the K8s API
// returned 403 and the Workloads tab showed "500" + "no pod" for everything.
// The helper must list per-namespace and tolerate per-namespace 403/404 so a
// missing grant degrades to "fewer pods" instead of failing the whole call.

function makePod(name: string, namespace: string): k8s.V1Pod {
  return {
    metadata: {
      name,
      namespace,
      labels: { 'clerum.io/recipe': 'my-recipe', 'clerum.io/workload': 'api' },
      creationTimestamp: new Date('2026-06-11T00:00:00Z'),
    },
    status: {
      phase: 'Running',
      containerStatuses: [{ name: 'main', ready: true, restartCount: 0, state: { running: {} } }],
    },
  } as k8s.V1Pod
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { statusCode: status })
}

describe('listRecipePodsAcrossNamespaces', () => {
  it('lists pods with the recipe label selector in every workload namespace and merges results', async () => {
    const listNamespacedPod = vi.fn(async ({ namespace }: { namespace: string }) => ({
      items: [makePod(`pod-${namespace}`, namespace)],
    }))
    const coreApi = { listNamespacedPod } as unknown as k8s.CoreV1Api

    const pods = await listRecipePodsAcrossNamespaces(
      coreApi,
      ['sandbox-recipes-t1', 'sandbox-ui-t1', 'mcp-server-t1'],
      'my-recipe'
    )

    expect(listNamespacedPod).toHaveBeenCalledTimes(3)
    for (const namespace of ['sandbox-recipes-t1', 'sandbox-ui-t1', 'mcp-server-t1']) {
      expect(listNamespacedPod).toHaveBeenCalledWith({
        namespace,
        labelSelector: 'clerum.io/recipe=my-recipe',
      })
    }
    expect(pods.map(p => ({ name: p.name, namespace: p.namespace }))).toEqual([
      { name: 'pod-sandbox-recipes-t1', namespace: 'sandbox-recipes-t1' },
      { name: 'pod-sandbox-ui-t1', namespace: 'sandbox-ui-t1' },
      { name: 'pod-mcp-server-t1', namespace: 'mcp-server-t1' },
    ])
    expect(pods[0].workloadId).toBe('api')
    expect(pods[0].phase).toBe('Running')
  })

  it('skips namespaces that return 403 or 404 instead of failing the whole request', async () => {
    const listNamespacedPod = vi.fn(async ({ namespace }: { namespace: string }) => {
      if (namespace === 'sandbox-ui') throw httpError(404)
      if (namespace === 'mcp-server-t1') throw httpError(403)
      return { items: [makePod('api-pod', namespace)] }
    })
    const coreApi = { listNamespacedPod } as unknown as k8s.CoreV1Api

    const pods = await listRecipePodsAcrossNamespaces(
      coreApi,
      ['sandbox-recipes-t1', 'sandbox-ui', 'mcp-server-t1'],
      'my-recipe'
    )

    expect(pods).toHaveLength(1)
    expect(pods[0].namespace).toBe('sandbox-recipes-t1')
  })

  it('propagates unexpected errors', async () => {
    const listNamespacedPod = vi.fn(async () => {
      throw httpError(500)
    })
    const coreApi = { listNamespacedPod } as unknown as k8s.CoreV1Api

    await expect(
      listRecipePodsAcrossNamespaces(coreApi, ['sandbox-recipes'], 'my-recipe')
    ).rejects.toThrow('HTTP 500')
  })

  it('lists each namespace only once when the configured namespaces repeat', async () => {
    const listNamespacedPod = vi.fn(async ({ namespace }: { namespace: string }) => ({
      items: [makePod(`pod-${namespace}`, namespace)],
    }))
    const coreApi = { listNamespacedPod } as unknown as k8s.CoreV1Api

    const pods = await listRecipePodsAcrossNamespaces(
      coreApi,
      ['sandbox-recipes', 'sandbox-recipes', 'mcp-server'],
      'my-recipe'
    )

    expect(listNamespacedPod).toHaveBeenCalledTimes(2)
    expect(pods).toHaveLength(2)
  })
})
