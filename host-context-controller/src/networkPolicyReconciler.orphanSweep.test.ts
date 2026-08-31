import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { config } from './config'
import { netPolOrphanSweepCappedTotal, netPolOrphansDeletedTotal } from './metrics'
import {
  NETWORKPOLICY_ORPHAN_SWEEP_CAPPED_MESSAGE,
  NetworkPolicyReconciler,
} from './networkPolicyReconciler'

vi.mock('./config', () => ({
  config: {
    namespace: 'mcp-server',
    controlPlaneNamespace: 'control-plane',
    hostNamespace: 'mcp-host',
    rpcProxyNamespace: 'rpc-proxy',
    port: 8081,
    runtimeNamespaces: ['mcp-server', 'mcp-host', 'sandbox-recipes', 'rpc-proxy'],
    k8sApiCidrs: [],
    externalEgressDnsResolveTimeoutMs: 5_000,
    externalEgressOverlapSec: 300,
    externalEgressMaxEntries: 128,
    netPolOrphanDeleteCap: 10,
    netPolOrphanDeleteCapPercent: 20,
  },
}))

vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn().mockResolvedValue([
    { address: '1.2.3.4', ttl: 300 },
    { address: '5.6.7.8', ttl: 300 },
  ]),
}))

vi.mock('./metrics', () => ({
  networkPolicySafetyPassDurationSeconds: { observe: vi.fn() },
  networkPolicySafetyPassPoliciesTotal: { inc: vi.fn() },
  netPolOrphansDeletedTotal: { inc: vi.fn() },
  netPolOrphanSweepCappedTotal: { inc: vi.fn() },
  writesTotal: { inc: vi.fn() },
}))
function makeMockNetworkingApi() {
  return {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  }
}

function makeMockCustomApi() {
  return {
    getNamespacedCustomObject: vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('not found'), { code: 404 })),
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    getNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({
      metadata: { generation: 7, resourceVersion: 'status-rv-default' },
      status: {},
    }),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  }
}

function makeReconciler(
  mockApi: ReturnType<typeof makeMockNetworkingApi>,
  mockCustomApi: ReturnType<typeof makeMockCustomApi> = makeMockCustomApi()
): NetworkPolicyReconciler {
  const kc = new k8s.KubeConfig()
  kc.loadFromOptions({
    clusters: [{ name: 'test', server: 'https://test' }],
    users: [{ name: 'test' }],
    contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
    currentContext: 'test',
  })
  const reconciler = new NetworkPolicyReconciler(kc, new Map())
  const listedPolicies = new Map<string, k8s.V1NetworkPolicy>()
  const networkingApi = {
    ...mockApi,
    listNamespacedNetworkPolicy: async (args: { namespace: string }) => {
      const response = await mockApi.listNamespacedNetworkPolicy(args)
      const items = (response.items ?? []).map((policy: k8s.V1NetworkPolicy, index: number) => {
        const name = policy.metadata?.name ?? `unnamed-${index}`
        const materialized = {
          ...policy,
          metadata: {
            ...policy.metadata,
            name,
            namespace: policy.metadata?.namespace ?? args.namespace,
            uid: policy.metadata?.uid ?? `${args.namespace}:${name}:uid`,
            resourceVersion: policy.metadata?.resourceVersion ?? '1',
          },
        }
        listedPolicies.set(`${args.namespace}/${name}`, materialized)
        return materialized
      })
      return { ...response, items }
    },
    readNamespacedNetworkPolicy: async (args: { name: string; namespace: string }) => {
      const listed = listedPolicies.get(`${args.namespace}/${args.name}`)
      return (
        listed ?? {
          metadata: { name: args.name, namespace: args.namespace, uid: 'u', resourceVersion: '1' },
        }
      )
    },
  }
  ;(reconciler as unknown as { networkingApi: unknown }).networkingApi = networkingApi
  ;(reconciler as unknown as { customApi: unknown }).customApi = mockCustomApi
  return reconciler
}
function orphanContextAllow(name: string, contextId: string): k8s.V1NetworkPolicy {
  return {
    metadata: {
      name,
      labels: {
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/policy-type': 'context-allow',
        'clerum.io/context': contextId,
        'clerum.io/mcpserver': 'old-server',
      },
    },
    // #471 fail-open: a missing spec is treated as unknown/write. Sweep
    // fixtures must include spec so the candidate is a real listed policy.
    spec: {
      podSelector: {},
      policyTypes: ['Ingress'],
      ingress: [{ _from: [{ podSelector: { matchLabels: { app: 'mcp-host' } } }] }],
    },
  }
}

function orphanHostEgress(name: string, contextId: string): k8s.V1NetworkPolicy {
  return {
    metadata: {
      name,
      labels: {
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/policy-type': 'context-allow',
        'clerum.io/context': contextId,
        'clerum.io/mcpserver': 'old-server',
      },
    },
    spec: {
      podSelector: {},
      policyTypes: ['Egress'],
      egress: [{ to: [{ podSelector: { matchLabels: { app: 'mcp-server' } } }] }],
    },
  }
}

function orphanRpcEgress(name: string, contextId: string): k8s.V1NetworkPolicy {
  return {
    metadata: {
      name,
      labels: {
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/policy-type': 'rpc-proxy-egress',
        'clerum.io/context': contextId,
        'clerum.io/mcpserver': 'old-server',
      },
    },
    spec: {
      podSelector: {},
      policyTypes: ['Egress'],
      egress: [{ to: [{ podSelector: { matchLabels: { app: 'mcp-server' } } }] }],
    },
  }
}

function orphanExternalEgress(name: string, serverName: string): k8s.V1NetworkPolicy {
  return {
    metadata: {
      name,
      labels: {
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/policy-type': 'external-egress',
        'clerum.io/mcpserver': serverName,
      },
    },
    spec: {
      podSelector: {},
      policyTypes: ['Egress'],
      egress: [{ to: [{ ipBlock: { cidr: '1.2.3.4/32' } }] }],
    },
  }
}
function stubOrphanLists(
  mockApi: ReturnType<typeof makeMockNetworkingApi>,
  items: {
    context?: k8s.V1NetworkPolicy[]
    hostEgress?: k8s.V1NetworkPolicy[]
    rpc?: k8s.V1NetworkPolicy[]
    external?: k8s.V1NetworkPolicy[]
  }
): void {
  mockApi.listNamespacedNetworkPolicy.mockImplementation(
    async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
      if (namespace === 'mcp-server' && labelSelector?.includes('context-allow')) {
        return { items: items.context ?? [] }
      }
      if (namespace === 'mcp-host' && labelSelector?.includes('context-allow')) {
        return { items: items.hostEgress ?? [] }
      }
      if (namespace === 'rpc-proxy' && labelSelector?.includes('rpc-proxy-egress')) {
        return { items: items.rpc ?? [] }
      }
      if (namespace === 'mcp-server' && labelSelector?.includes('external-egress')) {
        return { items: items.external ?? [] }
      }
      return { items: [] }
    }
  )
}

describe('NetworkPolicy orphan sweep cap (#478)', () => {
  let mockApi: ReturnType<typeof makeMockNetworkingApi>
  let reconciler: NetworkPolicyReconciler

  beforeEach(() => {
    config.netPolOrphanDeleteCap = 10
    config.netPolOrphanDeleteCapPercent = 20
    mockApi = makeMockNetworkingApi()
    reconciler = makeReconciler(mockApi)
    vi.clearAllMocks()
  })
  it('M3: deletes one under-cap context-allow orphan and increments orphans_deleted_total{lane=context-ingress}', async () => {
    stubOrphanLists(mockApi, {
      context: [orphanContextAllow('ctx-orphan-context-old-server', 'orphan-context')],
    })
    const complete = vi.fn()

    await reconciler.fullReconcile([], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: complete,
    })

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ctx-orphan-context-old-server',
        namespace: 'mcp-server',
      })
    )
    expect(netPolOrphansDeletedTotal.inc).toHaveBeenCalledWith({ lane: 'context-ingress' })
    expect(netPolOrphansDeletedTotal.inc).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledOnce()
    expect(netPolOrphanSweepCappedTotal.inc).not.toHaveBeenCalled()
  })

  it('M4: N+1 orphans refuse every delete, increment absolute cap, and still certify', async () => {
    const orphans = Array.from({ length: 11 }, (_, i) =>
      orphanContextAllow(`ctx-orphan-${i}-old-server`, `orphan-context-${i}`)
    )
    stubOrphanLists(mockApi, { context: orphans })
    const complete = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await reconciler.fullReconcile([], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: complete,
    })
    await reconciler.fullReconcile([], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: complete,
    })
    await reconciler.fullReconcile([], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: complete,
    })

    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(netPolOrphanSweepCappedTotal.inc).toHaveBeenCalledWith({ reason: 'absolute' })
    expect(netPolOrphanSweepCappedTotal.inc).toHaveBeenCalledTimes(3)
    expect(netPolOrphansDeletedTotal.inc).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalledTimes(3)
    expect(
      warnSpy.mock.calls.some(call =>
        String(call[0]).includes(NETWORKPOLICY_ORPHAN_SWEEP_CAPPED_MESSAGE)
      )
    ).toBe(true)
    warnSpy.mockRestore()
  })

  it('M4 sibling: cap trip also refuses external-egress deletes and still certifies', async () => {
    const orphans = Array.from({ length: 11 }, (_, i) =>
      orphanContextAllow(`ctx-orphan-${i}-old-server`, `orphan-context-${i}`)
    )
    stubOrphanLists(mockApi, {
      context: orphans,
      external: [
        orphanExternalEgress('ext-egress-orphan-server-old-example-com-443', 'orphan-server'),
      ],
    })
    const complete = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await reconciler.fullReconcile([], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: complete,
    })

    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ext-egress-orphan-server-old-example-com-443',
        namespace: 'mcp-server',
      })
    )
    expect(netPolOrphanSweepCappedTotal.inc).toHaveBeenCalledWith({ reason: 'absolute' })
    expect(netPolOrphansDeletedTotal.inc).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it('M4 sibling: orphans over the percent share refuse deletes with reason=percent and still certify', async () => {
    const orphans = Array.from({ length: 5 }, (_, i) =>
      orphanContextAllow(`ctx-orphan-${i}-old-server`, `orphan-context-${i}`)
    )
    stubOrphanLists(mockApi, { context: orphans })
    const complete = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await reconciler.fullReconcile([], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: complete,
    })

    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(netPolOrphanSweepCappedTotal.inc).toHaveBeenCalledWith({ reason: 'percent' })
    expect(complete).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })
  it('S2: absolute cap is strict >; exactly N deletes and N+1 refuses', async () => {
    config.netPolOrphanDeleteCapPercent = 100
    const ten = Array.from({ length: 10 }, (_, i) =>
      orphanContextAllow(`ctx-orphan-${i}-old-server`, `orphan-context-${i}`)
    )
    stubOrphanLists(mockApi, { context: ten })
    const completeTen = vi.fn()

    await reconciler.fullReconcile([], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: completeTen,
    })
    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(10)
    expect(completeTen).toHaveBeenCalledOnce()

    mockApi.deleteNamespacedNetworkPolicy.mockClear()
    vi.mocked(netPolOrphanSweepCappedTotal.inc).mockClear()
    const eleven = [...ten, orphanContextAllow('ctx-orphan-10-old-server', 'orphan-context-10')]
    stubOrphanLists(mockApi, { context: eleven })
    const completeEleven = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await reconciler.fullReconcile([], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: completeEleven,
    })
    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(netPolOrphanSweepCappedTotal.inc).toHaveBeenCalledWith({ reason: 'absolute' })
    expect(completeEleven).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it('S3: deleted orphans increment the matching lane label', async () => {
    stubOrphanLists(mockApi, {
      context: [orphanContextAllow('ctx-orphan-context-old-server', 'orphan-context')],
      hostEgress: [orphanHostEgress('ctx-orphan-context-old-server-egress', 'orphan-context')],
      rpc: [orphanRpcEgress('rpc-egress-orphan-context-old-server', 'orphan-context')],
      external: [
        orphanExternalEgress('ext-egress-orphan-server-old-example-com-443', 'orphan-server'),
      ],
    })

    await reconciler.fullReconcile([], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: vi.fn(),
    })

    expect(netPolOrphansDeletedTotal.inc).toHaveBeenCalledWith({ lane: 'context-ingress' })
    expect(netPolOrphansDeletedTotal.inc).toHaveBeenCalledWith({ lane: 'context-host-egress' })
    expect(netPolOrphansDeletedTotal.inc).toHaveBeenCalledWith({ lane: 'context-rpc-egress' })
    expect(netPolOrphansDeletedTotal.inc).toHaveBeenCalledWith({ lane: 'external-egress' })
    expect(netPolOrphansDeletedTotal.inc).toHaveBeenCalledTimes(4)
  })

  it('S4: percent cap is inert on a tiny listed fleet', async () => {
    stubOrphanLists(mockApi, {
      context: [
        orphanContextAllow('ctx-orphan-a-old-server', 'orphan-a'),
        orphanContextAllow('ctx-orphan-b-old-server', 'orphan-b'),
      ],
    })
    const complete = vi.fn()

    await reconciler.fullReconcile([], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: complete,
    })

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
    expect(netPolOrphanSweepCappedTotal.inc).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalledOnce()
  })
})
