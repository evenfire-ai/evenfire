import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { NetworkPolicyReconciler } from '../src/networkPolicyReconciler'
import type { ContextCRD, McpServerCRD } from '../src/types'
import { applyNetworkPolicy } from '../src/utils'

// Mock config
vi.mock('../src/config', () => ({
  config: {
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    rpcProxyNamespace: 'rpc-proxy',
    runtimeNamespaces: ['mcp-server', 'mcp-host', 'rpc-proxy'],
    port: 8081,
    k8sApiCidrs: [],
  },
}))

// Mock utils
vi.mock('../src/utils', () => ({
  getErrorCode: (err: any) => err?.code,
  applyNetworkPolicy: vi.fn().mockResolvedValue(undefined),
}))

const mockApply = vi.mocked(applyNetworkPolicy)

function makeServerCache(
  ...servers: Array<{ name: string; port?: number }>
): Map<string, McpServerCRD> {
  const cache = new Map<string, McpServerCRD>()
  for (const s of servers) {
    cache.set(s.name, {
      name: s.name,
      namespace: 'mcp-server',
      spec: {
        contextRef: 'ctx-a',
        transport: {
          type: 'streamableHttp',
          url: `http://${s.name}:${s.port ?? 3000}/mcp`,
          port: s.port ?? 3000,
        },
      },
    } as McpServerCRD)
  }
  return cache
}

function makeContext(contextId: string, servers: string[]): ContextCRD {
  return {
    name: `context-${contextId}`,
    namespace: 'mcp-server',
    spec: { contextId, mcpServers: servers },
  }
}

// Create mock NetworkingV1Api
function createMockNetworkingApi() {
  return {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ metadata: {} }),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
  }
}

describe('NetworkPolicyReconciler rpc-proxy egress', () => {
  let mockNetApi: ReturnType<typeof createMockNetworkingApi>
  let reconciler: NetworkPolicyReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    mockNetApi = createMockNetworkingApi()
    const serverCache = makeServerCache(
      { name: 'mongodb-mcp', port: 3000 },
      { name: 'airtable-mcp', port: 3001 }
    )
    const mockKc = {
      makeApiClient: () => mockNetApi as unknown as k8s.NetworkingV1Api,
    } as unknown as k8s.KubeConfig
    reconciler = new NetworkPolicyReconciler(mockKc, serverCache)
  })

  it('generates egress policy in rpc-proxy namespace when context has servers', async () => {
    const ctx = makeContext('ctx-alpha', ['mongodb-mcp'])
    await reconciler.reconcileContext(ctx)

    const rpcProxyCalls = mockApply.mock.calls.filter(call => call[2] === 'rpc-proxy')
    expect(rpcProxyCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('egress policy targets correct server pod by mcpserver label', async () => {
    const ctx = makeContext('ctx-alpha', ['mongodb-mcp'])
    await reconciler.reconcileContext(ctx)

    const rpcProxyCalls = mockApply.mock.calls.filter(call => call[2] === 'rpc-proxy')
    expect(rpcProxyCalls.length).toBeGreaterThanOrEqual(1)
    const policy = rpcProxyCalls[0][3] as k8s.V1NetworkPolicy
    const egress = policy.spec?.egress?.[0]
    const podSelector = egress?.to?.[0]?.podSelector
    expect(podSelector?.matchLabels?.['clerum.io/mcpserver']).toBe('mongodb-mcp')
  })

  it('egress policy uses correct port from McpServer spec', async () => {
    const ctx = makeContext('ctx-beta', ['airtable-mcp'])
    await reconciler.reconcileContext(ctx)

    const rpcProxyCalls = mockApply.mock.calls.filter(
      call => call[1] === 'rpc-egress-ctx-beta-airtable-mcp'
    )
    expect(rpcProxyCalls.length).toBe(1)
    const policy = rpcProxyCalls[0][3] as k8s.V1NetworkPolicy
    const port = policy.spec?.egress?.[0]?.ports?.[0]?.port
    expect(port).toBe(3001)
  })

  it('deletes egress policies when context is deleted', async () => {
    // Set up listNamespacedNetworkPolicy to return one rpc-proxy policy
    mockNetApi.listNamespacedNetworkPolicy.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'rpc-egress-ctx-gamma-mongodb-mcp',
            namespace: 'rpc-proxy',
            uid: 'rpc-delete-uid',
            resourceVersion: '7',
            labels: {
              'clerum.io/managed-by': 'host-context-controller',
              'clerum.io/policy-type': 'rpc-proxy-egress',
              'clerum.io/context': 'ctx-gamma',
            },
          },
        },
      ],
    })

    await reconciler.reconcileDeleteContext('ctx-gamma')

    // Verify deleteNamespacedNetworkPolicy was called for the rpc-proxy namespace
    const deleteCalls = mockNetApi.deleteNamespacedNetworkPolicy.mock.calls.filter(
      (call: any) => call[0]?.namespace === 'rpc-proxy'
    )
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('deletes orphaned egress policies when server removed from context', async () => {
    // First reconcile with both servers
    const ctx1 = makeContext('ctx-delta', ['mongodb-mcp', 'airtable-mcp'])
    await reconciler.reconcileContext(ctx1)
    const existingRpcProxyPolicies = mockApply.mock.calls
      .filter(call => call[2] === 'rpc-proxy')
      .map(call => {
        const policy = call[3] as k8s.V1NetworkPolicy
        const name = policy.metadata?.name
        return {
          ...policy,
          metadata: {
            ...policy.metadata,
            uid: `rpc-proxy:${name}:uid`,
            resourceVersion: '1',
          },
        }
      })
    expect(existingRpcProxyPolicies).toHaveLength(2)

    vi.clearAllMocks()
    mockNetApi.listNamespacedNetworkPolicy.mockImplementation(
      async ({ namespace, labelSelector }: any) => {
        if (
          namespace === 'rpc-proxy' &&
          String(labelSelector).includes('clerum.io/context=ctx-delta')
        ) {
          return {
            items: existingRpcProxyPolicies,
          }
        }
        return { items: [] }
      }
    )

    // Now reconcile with only one server — orphaned rpc-proxy policy should be cleaned
    const ctx2 = makeContext('ctx-delta', ['mongodb-mcp'])
    await reconciler.reconcileContext(ctx2)

    // applyNetworkPolicy should be called for mongodb-mcp in rpc-proxy but not airtable-mcp
    const rpcProxyCalls = mockApply.mock.calls.filter(call => call[2] === 'rpc-proxy')
    const serverNames = rpcProxyCalls.map(call => call[1])
    expect(serverNames).toContain('rpc-egress-ctx-delta-mongodb-mcp')
    expect(serverNames).not.toContain('rpc-egress-ctx-delta-airtable-mcp')
    expect(mockNetApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'rpc-egress-ctx-delta-airtable-mcp',
      namespace: 'rpc-proxy',
      body: {
        preconditions: {
          uid: 'rpc-proxy:rpc-egress-ctx-delta-airtable-mcp:uid',
          resourceVersion: '1',
        },
      },
    })
    expect(mockNetApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith({
      name: 'rpc-egress-ctx-delta-mongodb-mcp',
      namespace: 'rpc-proxy',
    })
  })

  it('skips egress generation when server not found in cache', async () => {
    const ctx = makeContext('ctx-epsilon', ['nonexistent-server'])
    await reconciler.reconcileContext(ctx)

    const rpcProxyCalls = mockApply.mock.calls.filter(call => call[2] === 'rpc-proxy')
    expect(rpcProxyCalls.length).toBe(0)
  })
})
