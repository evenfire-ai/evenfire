import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { NetworkPolicyReconciler } from '../src/networkPolicyReconciler'
import { applyNetworkPolicy } from '../src/utils'

// Mock config — three runtime namespaces, sandbox-ui marked minimal.
vi.mock('../src/config', () => ({
  config: {
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    rpcProxyNamespace: 'rpc-proxy',
    runtimeNamespaces: ['mcp-server', 'sandbox-recipes', 'rpc-proxy', 'sandbox-ui'],
    minimalInfraNamespaces: ['sandbox-ui'],
    k8sApiCidrs: [],
    port: 8081,
  },
}))

vi.mock('../src/utils', () => ({
  getErrorCode: (err: { code?: number }) => err?.code,
  applyNetworkPolicy: vi.fn().mockResolvedValue(undefined),
}))

const mockApply = vi.mocked(applyNetworkPolicy)

function createMockNetworkingApi() {
  return {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('not found'), { code: 404 })),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
  }
}

function policyNamesAppliedTo(namespace: string): string[] {
  return mockApply.mock.calls.filter(call => call[2] === namespace).map(call => call[1] as string)
}

describe('NetworkPolicyReconciler — minimalInfraNamespaces', () => {
  let reconciler: NetworkPolicyReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    const mockKc = {
      makeApiClient: () => createMockNetworkingApi() as unknown as k8s.NetworkingV1Api,
    } as unknown as k8s.KubeConfig
    reconciler = new NetworkPolicyReconciler(mockKc, new Map())
  })

  it('applies the full infra set (deny-all + dns + hcc-api + k8s-api) to non-minimal namespaces', async () => {
    await reconciler.ensureDefaultPolicies()

    const sandboxRecipes = policyNamesAppliedTo('sandbox-recipes')
    expect(sandboxRecipes).toContain('deny-all-sandbox-recipes')
    expect(sandboxRecipes).toContain('allow-dns-egress-sandbox-recipes')
    expect(sandboxRecipes).toContain('allow-hcc-api-egress-sandbox-recipes')
    expect(sandboxRecipes).toContain('allow-k8s-api-egress-sandbox-recipes')
  })

  it('applies ONLY deny-all + allow-dns to a namespace listed in minimalInfraNamespaces', async () => {
    await reconciler.ensureDefaultPolicies()

    const sandboxUi = policyNamesAppliedTo('sandbox-ui')
    expect(sandboxUi).toContain('deny-all-sandbox-ui')
    expect(sandboxUi).toContain('allow-dns-egress-sandbox-ui')
    expect(sandboxUi).not.toContain('allow-hcc-api-egress-sandbox-ui')
    expect(sandboxUi).not.toContain('allow-k8s-api-egress-sandbox-ui')
  })
})
