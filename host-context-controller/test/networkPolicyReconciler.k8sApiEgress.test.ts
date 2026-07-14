import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { NetworkPolicyReconciler } from '../src/networkPolicyReconciler'
import { applyNetworkPolicy } from '../src/utils'

vi.mock('../src/config', () => ({
  config: {
    namespace: 'mcp-server',
    controlPlaneNamespace: 'control-plane',
    hostNamespace: 'mcp-host',
    rpcProxyNamespace: 'rpc-proxy',
    runtimeNamespaces: ['mcp-server', 'rpc-proxy', 'sandbox-recipes'],
    port: 8081,
    k8sApiCidrs: ['203.0.113.10/32', '10.128.0.2/32'],
  },
}))

vi.mock('../src/utils', () => ({
  getErrorCode: (err: any) => err?.code,
  applyNetworkPolicy: vi.fn().mockResolvedValue(undefined),
}))

const mockApply = vi.mocked(applyNetworkPolicy)

function k8sApiEgressFor(ns: string): k8s.V1NetworkPolicy | undefined {
  const call = mockApply.mock.calls.find(c => c[1] === `allow-k8s-api-egress-${ns}`)
  return call?.[3] as k8s.V1NetworkPolicy | undefined
}

describe('ensureK8sApiEgress', () => {
  let reconciler: NetworkPolicyReconciler

  beforeEach(() => {
    mockApply.mockClear()
    // ensureDefaultPolicies() also prunes legacy static policies via the
    // networking API directly (not applyNetworkPolicy), so the mocked client
    // must expose deleteNamespacedNetworkPolicy.
    const mockKc = {
      makeApiClient: () => ({
        deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
      }),
    } as unknown as k8s.KubeConfig
    reconciler = new NetworkPolicyReconciler(mockKc, new Map())
  })

  it('emits one ipBlock per configured CIDR', async () => {
    await reconciler.ensureDefaultPolicies()
    const np = k8sApiEgressFor('mcp-server')
    expect(np).toBeDefined()
    const blocks = np!.spec!.egress![0].to!.map(t => t.ipBlock!.cidr)
    expect(blocks).toEqual(['203.0.113.10/32', '10.128.0.2/32'])
  })

  it('applies the same CIDR set to every runtime namespace', async () => {
    await reconciler.ensureDefaultPolicies()
    for (const ns of ['mcp-server', 'rpc-proxy', 'sandbox-recipes']) {
      const np = k8sApiEgressFor(ns)
      expect(np, `allow-k8s-api-egress-${ns}`).toBeDefined()
      expect(np!.spec!.egress![0].to!.length).toBe(2)
    }
  })
})
