import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { BindingDef, BindingPolicyReconciler } from './bindingPolicyReconciler'

function makeMockNetworkingApi() {
  return {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  }
}

function makeReconciler(
  mockApi: ReturnType<typeof makeMockNetworkingApi>
): BindingPolicyReconciler {
  const kc = new k8s.KubeConfig()
  kc.loadFromOptions({
    clusters: [{ name: 'test', server: 'https://test' }],
    users: [{ name: 'test' }],
    contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
    currentContext: 'test',
  })
  const reconciler = new BindingPolicyReconciler(kc, 'mcp-server')
  // Inject mock
  ;(reconciler as unknown as { networkingApi: unknown }).networkingApi = mockApi
  return reconciler
}

describe('BindingPolicyReconciler', () => {
  let mockApi: ReturnType<typeof makeMockNetworkingApi>
  let reconciler: BindingPolicyReconciler

  beforeEach(() => {
    mockApi = makeMockNetworkingApi()
    reconciler = makeReconciler(mockApi)
  })

  const singleBinding: BindingDef[] = [{ from: 'redis-mcp', to: 'redis', port: 6379 }]

  it('creates egress + ingress policies for a binding', async () => {
    await reconciler.reconcileBindings('my-recipe', singleBinding, 'redis-mcp')

    // 2 calls: 1 egress + 1 ingress
    expect(mockApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)

    const calls = mockApi.createNamespacedNetworkPolicy.mock.calls
    const egressCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { spec: { policyTypes: string[] } } }).body.spec.policyTypes[0] ===
        'Egress'
    )![0] as {
      namespace: string
      body: { metadata: { name: string }; spec: { policyTypes: string[] } }
    }
    const ingressCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { spec: { policyTypes: string[] } } }).body.spec.policyTypes[0] ===
        'Ingress'
    )![0] as {
      namespace: string
      body: { metadata: { name: string }; spec: { policyTypes: string[] } }
    }

    // Egress in mcp-server (where redis-mcp, the "from" MCP workload, lives)
    expect(egressCall.namespace).toBe('mcp-server')
    expect(egressCall.body.metadata.name).toBe('bind-my-recipe-redis-mcp-redis-egress')
    expect(egressCall.body.spec.policyTypes).toEqual(['Egress'])

    // Ingress in sandbox-recipes (where redis, the "to" non-MCP workload, lives)
    expect(ingressCall.namespace).toBe('sandbox-recipes')
    expect(ingressCall.body.metadata.name).toBe('bind-my-recipe-redis-mcp-redis-ingress')
    expect(ingressCall.body.spec.policyTypes).toEqual(['Ingress'])
  })

  it('applies binding-allow labels to all policies', async () => {
    await reconciler.reconcileBindings('my-recipe', singleBinding, 'redis-mcp')

    for (const call of mockApi.createNamespacedNetworkPolicy.mock.calls) {
      const labels = (call[0] as { body: { metadata: { labels: Record<string, string> } } }).body
        .metadata.labels
      expect(labels['clerum.io/policy-type']).toBe('binding-allow')
      expect(labels['clerum.io/recipe']).toBe('my-recipe')
      expect(labels['clerum.io/managed-by']).toBe('host-context-controller')
    }
  })

  it('handles 409 conflict with create-or-replace pattern', async () => {
    mockApi.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })

    await reconciler.reconcileBindings('my-recipe', singleBinding, 'redis-mcp')

    expect(mockApi.readNamespacedNetworkPolicy).toHaveBeenCalled()
    expect(mockApi.replaceNamespacedNetworkPolicy).toHaveBeenCalled()
  })

  it('cleanupBindings deletes policies in both namespaces', async () => {
    mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
      items: [{ metadata: { name: 'bind-my-recipe-a-b-egress' } }],
    })

    await reconciler.cleanupBindings('my-recipe')

    // Lists in both namespaces
    expect(mockApi.listNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
    // Deletes found policies
    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalled()
  })

  it('uses _from for ingress rules (K8s client ObjectSerializer maps _from → from)', async () => {
    await reconciler.reconcileBindings('my-recipe', singleBinding, 'redis-mcp')

    const calls = mockApi.createNamespacedNetworkPolicy.mock.calls
    const ingressCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { spec: { policyTypes: string[] } } }).body.spec.policyTypes[0] ===
        'Ingress'
    )
    const ingressBody = (
      ingressCall![0] as { body: { spec: { ingress: Array<{ _from: unknown[] }> } } }
    ).body
    // _from is the correct TypeScript property — ObjectSerializer serializes it to "from"
    expect(ingressBody.spec.ingress[0]._from).toBeDefined()
    expect(ingressBody.spec.ingress[0]._from.length).toBeGreaterThan(0)
  })

  it('uses correct pod selectors and namespace-aware placement', async () => {
    await reconciler.reconcileBindings('my-recipe', singleBinding, 'redis-mcp')

    const calls = mockApi.createNamespacedNetworkPolicy.mock.calls
    const egressCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { spec: { policyTypes: string[] } } }).body.spec.policyTypes[0] ===
        'Egress'
    )
    const ingressCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { spec: { policyTypes: string[] } } }).body.spec.policyTypes[0] ===
        'Ingress'
    )

    const egressBody = (
      egressCall![0] as {
        body: {
          spec: {
            podSelector: { matchLabels: Record<string, string> }
            egress: Array<{
              to: Array<{
                podSelector: { matchLabels: Record<string, string> }
                namespaceSelector: { matchLabels: Record<string, string> }
              }>
            }>
          }
        }
      }
    ).body
    // Egress podSelector targets the MCP server by its stable pod label.
    expect(egressBody.spec.podSelector.matchLabels['clerum.io/mcpserver']).toBe('redis-mcp')
    // Egress destination targets the "to" workload (redis) in sandbox-recipes
    expect(egressBody.spec.egress[0].to[0].podSelector.matchLabels.app).toBe('redis')
    expect(
      egressBody.spec.egress[0].to[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name']
    ).toBe('sandbox-recipes')

    const ingressBody = (
      ingressCall![0] as {
        body: {
          spec: {
            podSelector: { matchLabels: Record<string, string> }
            ingress: Array<{
              _from: Array<{
                podSelector: { matchLabels: Record<string, string> }
                namespaceSelector: { matchLabels: Record<string, string> }
              }>
            }>
          }
        }
      }
    ).body
    // Ingress podSelector targets the "to" workload (redis)
    expect(ingressBody.spec.podSelector.matchLabels.app).toBe('redis')
    // Ingress source is the MCP server in mcp-server.
    expect(
      ingressBody.spec.ingress[0]._from[0].podSelector.matchLabels['clerum.io/mcpserver']
    ).toBe('redis-mcp')
    expect(
      ingressBody.spec.ingress[0]._from[0].namespaceSelector.matchLabels[
        'kubernetes.io/metadata.name'
      ]
    ).toBe('mcp-server')
  })

  it('uses the McpServer label when it differs from the workload id', async () => {
    await reconciler.reconcileBindings(
      'my-recipe',
      singleBinding,
      'redis-mcp',
      'my-recipe-redis-mcp'
    )

    const calls = mockApi.createNamespacedNetworkPolicy.mock.calls
    const egressCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { spec: { policyTypes: string[] } } }).body.spec.policyTypes[0] ===
        'Egress'
    )
    const ingressCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { spec: { policyTypes: string[] } } }).body.spec.policyTypes[0] ===
        'Ingress'
    )

    const egressBody = (
      egressCall![0] as { body: { spec: { podSelector: { matchLabels: Record<string, string> } } } }
    ).body
    expect(egressBody.spec.podSelector.matchLabels['clerum.io/mcpserver']).toBe(
      'my-recipe-redis-mcp'
    )

    const ingressBody = (
      ingressCall![0] as {
        body: {
          spec: {
            ingress: Array<{
              _from: Array<{ podSelector: { matchLabels: Record<string, string> } }>
            }>
          }
        }
      }
    ).body
    expect(
      ingressBody.spec.ingress[0]._from[0].podSelector.matchLabels['clerum.io/mcpserver']
    ).toBe('my-recipe-redis-mcp')
  })
})
