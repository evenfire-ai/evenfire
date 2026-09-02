// Issue #513: the external-egress catch classifies EVERY exception as a DNS
// condition. classifyDnsError keys on `.code` and defaults anything unknown or
// codeless to 'permanent' (network-policy-core/index.cjs:83), and 'permanent'
// PRUNES the accumulated window instead of freezing it. So a programming fault
// raised anywhere inside the ~60-line try — a TypeError from a contract
// violation, an ERR_* argument error — is laundered into the prune branch and
// reported to the operator as `permanent DNS failure for "<host>"`, pointing at
// DNS while the actual fault is in the reconciler.
//
// The injection here is deliberately production-shaped rather than a test hook:
// the resolver returns one valid record and one non-object, so `records.map(r =>
// r.address)` throws a real TypeError INSIDE the try, AFTER resolution. That is
// the contract violation the catch cannot tell apart from a DNS answer.
//
// T3 is the semantics guard: a genuine NXDOMAIN must keep pruning and failing
// loud exactly as before. Without it, "stop classifying" could be satisfied by
// simply never pruning, which would break the permanent branch the platform
// depends on.
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

const server: McpServerCRD = {
  name: 'classify-mcp',
  namespace: 'mcp-server',
  spec: {
    contextRef: 'dev',
    image: 'classify:latest',
    transport: { type: 'streamableHttp', url: 'http://classify:3000', port: 3000 },
    egressBindings: [{ dns: 'api.example.com', port: 443 }],
  },
}

describe('#513: a non-DNS exception inside the resolve block is not a DNS condition', () => {
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

  /** Bootstrap a written policy, then re-serve it with the window optionally lapsed. */
  async function seedAccumulatedPolicy(opts: { lapsed: boolean }): Promise<void> {
    await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    const written = (
      mockApi.createNamespacedNetworkPolicy.mock.calls[0][0] as { body: k8s.V1NetworkPolicy }
    ).body
    const annotations = { ...(written.metadata?.annotations ?? {}) }
    expect(annotations['clerum.io/egress-fqdn-state']).toBeTruthy()

    if (opts.lapsed) {
      const state = JSON.parse(annotations['clerum.io/egress-fqdn-state']) as Array<{
        expiresAt: number
      }>
      for (const e of state) e.expiresAt = Date.now() - 60_000
      annotations['clerum.io/egress-fqdn-state'] = JSON.stringify(state)
    }

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
    mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
  }

  /** A resolver answer whose second record is not an object: records.map() throws. */
  function injectPostResolutionTypeError(): void {
    resolve4Mock.mockResolvedValueOnce([
      { address: '1.2.3.4', ttl: 300 },
      null as unknown as RecordWithTtl,
    ])
  }

  type Condition = { type?: string; status?: string; reason?: string; message?: string }

  /**
   * The status write is a JSON Patch array, not a status object: conditions
   * arrive either as `/status/conditions` (status object already present) or
   * nested inside a whole-`/status` add (bootstrap). Read both shapes.
   */
  function statusConditions(): Condition[] {
    type Op = { op?: string; path?: string; value?: unknown }
    return mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.flatMap(
      (call: [{ body?: Op[] }]) =>
        (call[0]?.body ?? []).flatMap((op): Condition[] => {
          if (op.path === '/status/conditions') return (op.value ?? []) as Condition[]
          if (op.path === '/status') {
            return (((op.value ?? {}) as { conditions?: Condition[] }).conditions ??
              []) as Condition[]
          }
          return []
        })
    )
  }

  it('T1 reports a post-resolution TypeError as a reconcile error, not as a permanent DNS failure', async () => {
    await seedAccumulatedPolicy({ lapsed: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    // The operator must not be pointed at DNS for a fault in the reconciler.
    expect(warn.mock.calls.flat().join('\n')).not.toContain('permanent DNS failure')
    warn.mockRestore()

    // No mutation of the live policy on a fault we cannot classify.
    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()

    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress).not.toHaveLength(0)
    expect(egress.at(-1)?.status).toBe('False')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressReconcileFailed')
    expect(egress.at(-1)?.message).toContain('api.example.com')
  })

  it('T2 does not prune the lapsed window on a post-resolution TypeError', async () => {
    await seedAccumulatedPolicy({ lapsed: true })
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    // Pre-fix this prunes the lapsed set to zero, hits the `continue`, and the
    // policy is swept as undesired. D4 fail-static must hold for a fault that is
    // not a resolver condition at all.
    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()

    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressReconcileFailed')
  })

  it('T3 still prunes and fails loud on a genuine NXDOMAIN with a lapsed window', async () => {
    await seedAccumulatedPolicy({ lapsed: true })
    resolve4Mock.mockRejectedValueOnce(
      Object.assign(new Error('queryA ENOTFOUND api.example.com'), { code: 'ENOTFOUND' })
    )

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(/failed to resolve hostname "api\.example\.com"/)

    // A real no-records answer is a DNS condition: the permanent branch is intact.
    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)

    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressRejected')
  })

  it("T4 treats EBADNAME as the operator's malformed name, not as a controller fault", async () => {
    // EBADNAME is a POSITIVE verdict about the name: c-ares refused to send the
    // query at all. It is reachable from user input — the CRD pattern for
    // `egressBindings[].dns` admits consecutive dots and labels over 63 octets —
    // so it belongs with NXDOMAIN: prune and reject. Blaming the controller with
    // ExternalEgressReconcileFailed would send the operator hunting through our
    // logs for their own typo.
    await seedAccumulatedPolicy({ lapsed: true })
    resolve4Mock.mockRejectedValueOnce(
      Object.assign(new Error('queryA EBADNAME api.example.com'), { code: 'EBADNAME' })
    )

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(/failed to resolve hostname "api\.example\.com"/)

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)

    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressRejected')
  })
})
