// Regression for zach88 R1-B1 / R1-M1 on PR #382.
// D4 fail-static: a bounded-timeout DNS failure is a TRANSIENT resolver error and
// must FREEZE the accumulated external-egress set, even when the persisted window
// has lapsed. Before the fix the synthetic timeout Error carried no `.code`, so
// classifyDnsError mapped it to 'permanent', lapsed entries were pruned to zero,
// and the reconcile failed and DELETED the egress policy — dropping the McpServer's
// external egress. The existing timeout test (networkPolicyReconciler.test.ts) uses
// a server with no accumulated policy, so it fails loud regardless of the
// classification and cannot catch this; this seeds a lapsed accumulated policy so
// the freeze-vs-prune decision is observable.
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import type { RecordWithTtl } from 'node:dns'
import * as dns from 'node:dns/promises'
import { NetworkPolicyReconciler } from './networkPolicyReconciler'
import { McpServerCRD } from './types'

vi.mock('./mcpServerSafety', async () => {
  const actual = await vi.importActual<typeof import('./mcpServerSafety')>('./mcpServerSafety')
  return {
    ...actual,
    confirmAuthoritativeMcpServerAbsence: vi.fn(actual.confirmAuthoritativeMcpServerAbsence),
  }
})

const rec = (...ips: string[]): RecordWithTtl[] => ips.map(address => ({ address, ttl: 300 }))
const resolve4Mock = vi.mocked(dns.resolve4) as unknown as Mock

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
  },
}))

vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn().mockResolvedValue([{ address: '1.2.3.4', ttl: 300 }]),
}))

vi.mock('./metrics', () => ({
  networkPolicySafetyPassDurationSeconds: { observe: vi.fn() },
  networkPolicySafetyPassPoliciesTotal: { inc: vi.fn() },
  writesTotal: { inc: vi.fn() },
  writeSkipsTotal: { inc: vi.fn() },
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
  mockCustomApi: ReturnType<typeof makeMockCustomApi>
): NetworkPolicyReconciler {
  const kc = new k8s.KubeConfig()
  kc.loadFromOptions({
    clusters: [{ name: 'test', server: 'https://test' }],
    users: [{ name: 'test' }],
    contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
    currentContext: 'test',
  })
  const reconciler = new NetworkPolicyReconciler(kc, new Map())
  const networkingApi = {
    ...mockApi,
    listNamespacedNetworkPolicy: async (args: { namespace: string }) => {
      const response = await mockApi.listNamespacedNetworkPolicy(args)
      const items = (response.items ?? []).map((policy: k8s.V1NetworkPolicy, index: number) => {
        const name = policy.metadata?.name ?? `unnamed-${index}`
        return {
          ...policy,
          metadata: {
            ...policy.metadata,
            name,
            namespace: policy.metadata?.namespace ?? args.namespace,
            uid: policy.metadata?.uid ?? `${args.namespace}:${name}:uid`,
            resourceVersion: policy.metadata?.resourceVersion ?? '1',
          },
        }
      })
      return { ...response, items }
    },
  }
  ;(reconciler as unknown as { networkingApi: unknown }).networkingApi = networkingApi
  ;(reconciler as unknown as { customApi: unknown }).customApi = mockCustomApi
  return reconciler
}

describe('R1-B1 regression: DNS timeout must fail-static (freeze), not prune', () => {
  let mockApi: ReturnType<typeof makeMockNetworkingApi>
  let mockCustomApi: ReturnType<typeof makeMockCustomApi>
  let reconciler: NetworkPolicyReconciler

  beforeEach(() => {
    vi.useRealTimers()
    mockApi = makeMockNetworkingApi()
    mockCustomApi = makeMockCustomApi()
    reconciler = makeReconciler(mockApi, mockCustomApi)
    vi.clearAllMocks()
    resolve4Mock.mockResolvedValue(rec('1.2.3.4'))
  })

  it('retains the accumulated /32 when the resolver stalls past the bounded timeout while the window has lapsed', async () => {
    const server: McpServerCRD = {
      name: 'frozen-mcp',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'dev',
        image: 'frozen:latest',
        transport: { type: 'streamableHttp', url: 'http://frozen:3000', port: 3000 },
        egressBindings: [{ dns: 'api.example.com', port: 443 }],
      },
    }

    // 1) Bootstrap: healthy resolve writes the policy with its STATE annotation.
    await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    const written = (
      mockApi.createNamespacedNetworkPolicy.mock.calls[0][0] as { body: k8s.V1NetworkPolicy }
    ).body
    const annotations = { ...(written.metadata?.annotations ?? {}) }
    expect(annotations['clerum.io/egress-fqdn-state']).toBeTruthy()

    // 2) Lapse the persisted window: every entry expired in the past. This is the
    // "sustained stall" precondition: TTL+overlap ran out while DNS was failing.
    const state = JSON.parse(annotations['clerum.io/egress-fqdn-state']) as Array<{
      expiresAt: number
    }>
    for (const e of state) e.expiresAt = Date.now() - 60_000
    annotations['clerum.io/egress-fqdn-state'] = JSON.stringify(state)

    mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
      items: [
        {
          metadata: {
            name: written.metadata?.name,
            labels: written.metadata?.labels,
            annotations,
          },
          spec: written.spec,
        },
      ],
    })
    mockApi.createNamespacedNetworkPolicy.mockClear()
    mockApi.replaceNamespacedNetworkPolicy.mockClear()
    mockApi.deleteNamespacedNetworkPolicy.mockClear()

    // 3) Stall the resolver so the bounded-timeout wrapper fires (the synthetic
    // timeout Error), and run the next reconcile under fake timers.
    vi.useFakeTimers()
    resolve4Mock.mockImplementationOnce(() => new Promise(() => undefined))
    const reconcile = reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    const settled = reconcile.then(
      () => ({ outcome: 'resolved' as const }),
      (err: unknown) => ({ outcome: 'rejected' as const, err })
    )
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await settled

    // 4) Fail-static (D4/H1): the timeout is a TRANSIENT resolver failure. The
    // load-bearing retention proof is that the reconcile RESOLVES and does NOT
    // delete the policy — pre-fix the misclassification prunes the lapsed set to
    // zero, so the reconcile REJECTS and DELETES the policy (both assertions flip
    // against the pre-fix tree). Freezing an already-correct policy is a no-op, so
    // it issues no create/replace here.
    expect(result.outcome).toBe('resolved')
    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    // Defensive: should a future freeze ever re-persist instead of no-op'ing, any
    // write it makes must still carry the accumulated /32 (never a pruned body).
    const writes = [
      ...mockApi.createNamespacedNetworkPolicy.mock.calls,
      ...mockApi.replaceNamespacedNetworkPolicy.mock.calls,
    ] as Array<[{ body: k8s.V1NetworkPolicy }]>
    for (const [call] of writes) {
      const cidrs = (call.body.spec?.egress ?? []).flatMap(rule =>
        (rule.to ?? []).map(t => t.ipBlock?.cidr)
      )
      expect(cidrs).toContain('1.2.3.4/32')
    }
  })
})
