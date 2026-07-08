import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { NetworkPolicyReconciler } from '../src/networkPolicyReconciler'
import { applyNetworkPolicy } from '../src/utils'

// Mutable nodeLocalDnsCidr so a single file can cover both the default
// (empty -> no ipBlock) and the configured kube-dns Service IP paths.
const mockConfig = {
  namespace: 'mcp-server',
  hostNamespace: 'mcp-host',
  rpcProxyNamespace: 'rpc-proxy',
  runtimeNamespaces: ['sandbox-recipes'],
  minimalInfraNamespaces: [],
  k8sApiCidrs: [],
  nodeLocalDnsCidr: '',
  port: 8081,
}

vi.mock('../src/config', () => ({
  get config() {
    return mockConfig
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
    readNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ metadata: {} }),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
  }
}

function dnsPolicyFor(namespace: string): k8s.V1NetworkPolicy | undefined {
  const call = mockApply.mock.calls.find(
    c => c[1] === `allow-dns-egress-${namespace}` && c[2] === namespace
  )
  return call?.[3] as k8s.V1NetworkPolicy | undefined
}

describe('NetworkPolicyReconciler — NodeLocal DNSCache ipBlock egress', () => {
  let reconciler: NetworkPolicyReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    mockConfig.nodeLocalDnsCidr = ''
    const mockKc = {
      makeApiClient: () => createMockNetworkingApi() as unknown as k8s.NetworkingV1Api,
    } as unknown as k8s.KubeConfig
    reconciler = new NetworkPolicyReconciler(mockKc, new Map())
  })

  it('default (nodeLocalDnsCidr empty) -> only the kube-system selector, no ipBlock', async () => {
    mockConfig.nodeLocalDnsCidr = ''

    await reconciler.ensureDefaultPolicies()

    const policy = dnsPolicyFor('sandbox-recipes')
    expect(policy).toBeDefined()
    const egress = policy!.spec!.egress!
    expect(egress).toHaveLength(1)
    expect(egress[0].to).toEqual([
      { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } },
    ])
    // No ipBlock anywhere in the egress.
    const hasIpBlock = egress.some(rule => rule.to?.some(peer => 'ipBlock' in peer))
    expect(hasIpBlock).toBe(false)
  })

  it('with nodeLocalDnsCidr set -> appends a second ipBlock egress rule with that cidr + port 53', async () => {
    mockConfig.nodeLocalDnsCidr = '203.0.113.10/32'

    await reconciler.ensureDefaultPolicies()

    const policy = dnsPolicyFor('sandbox-recipes')
    expect(policy).toBeDefined()
    const egress = policy!.spec!.egress!
    expect(egress).toHaveLength(2)

    // First rule unchanged: kube-system selector.
    expect(egress[0].to).toEqual([
      { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } },
    ])

    // Second rule: ipBlock to the cluster-specific kube-dns Service IP on port 53.
    expect(egress[1].to).toEqual([{ ipBlock: { cidr: '203.0.113.10/32' } }])
    expect(egress[1].ports).toEqual([
      { port: 53, protocol: 'UDP' },
      { port: 53, protocol: 'TCP' },
    ])
  })
})
