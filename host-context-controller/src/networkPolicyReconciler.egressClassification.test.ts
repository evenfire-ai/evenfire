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
    // `mock.calls` is `any[][]`, so the parameter is typed as the loose array it
    // actually is and the argument shape is asserted inside. Annotating it as a
    // fixed-length tuple does not typecheck under `tsc --noEmit` (which, unlike
    // `tsconfig.build.json`, includes test files): an `any[]` may have fewer
    // elements than a 1-tuple requires.
    return mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.flatMap(
      (call: unknown[]): Condition[] => {
        const body = (call[0] as { body?: Op[] } | undefined)?.body ?? []
        return body.flatMap((op): Condition[] => {
          if (op.path === '/status/conditions') return (op.value ?? []) as Condition[]
          if (op.path === '/status') {
            return (((op.value ?? {}) as { conditions?: Condition[] }).conditions ??
              []) as Condition[]
          }
          return []
        })
      }
    )
  }

  it('T1 reports a post-resolution TypeError as a reconcile error, not as a permanent DNS failure', async () => {
    await seedAccumulatedPolicy({ lapsed: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    injectPostResolutionTypeError()

    // No throw: there is a live policy, so the fault is served fail-static (T7).
    // Everything else this test pins is unchanged.
    await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

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

    // No throw: the policy is live (its window lapsed, the object did not), so
    // the fault is served fail-static (T7). The prune assertion is the point.
    await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

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

  it("T6 still deletes a de-authorized binding's policy when a sibling binding faults", async () => {
    // Fail-loud must not cost fail-closed. `cleanupExternalEgress` runs AFTER the
    // binding loop and is the only place that deletes policies for bindings no
    // longer in the spec, so throwing from inside the loop skips it: a
    // destination the operator explicitly removed keeps its /32 allowed for as
    // long as an unrelated sibling keeps faulting — and the fault path retries
    // every 30s, so "as long as" means indefinitely.
    //
    // The file already has the right shape for this: `failures[]` accumulates,
    // the loop finishes, the cleanup runs, and only then does it write status and
    // throw. The fault path must follow that contract rather than invent a
    // parallel exit.
    const bindings = (dns: string[]): McpServerCRD => ({
      ...server,
      spec: { ...server.spec, egressBindings: dns.map(d => ({ dns: d, port: 443 })) },
    })

    await reconciler.reconcileExternalEgress(bindings(['a.example.com', 'b.example.com']), {
      isCurrent: () => true,
    })
    const written = mockApi.createNamespacedNetworkPolicy.mock.calls.map(
      call => (call[0] as { body: k8s.V1NetworkPolicy }).body
    )
    expect(written).toHaveLength(2)

    mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
      items: written.map(body => ({ metadata: { ...body.metadata }, spec: body.spec })),
    })
    mockApi.createNamespacedNetworkPolicy.mockClear()
    mockApi.deleteNamespacedNetworkPolicy.mockClear()

    // The operator removes a.example.com; b.example.com faults after resolution.
    injectPostResolutionTypeError()
    // No throw: b.example.com has a live policy, so the fault is served
    // fail-static (T7). What this test pins is that the cleanup still ran.
    await reconciler.reconcileExternalEgress(bindings(['b.example.com']), {
      isCurrent: () => true,
    })

    // Exactly one delete, and it is A's. `toHaveBeenCalledWith` alone is a
    // membership check, not an exclusivity one: it stays green when the cleanup
    // deletes BOTH policies, which is what happens if the faulting binding is
    // left out of desiredPolicyNames. The count and the negative assertion are
    // what make this test pin the second-order effect it claims to.
    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ext-egress-classify-mcp-a.example.com-443' })
    )
    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ext-egress-classify-mcp-b.example.com-443' })
    )
  })

  it('T7 serves the frozen set and does NOT block the workload when a fault has a live policy', async () => {
    // Review of #567, major 3. The throw reaches k8sClient's catch, which logs
    // "runtime reconciliation blocked" and returns BEFORE the managed Deployment
    // is created — so a fault in ONE binding kept a whole server's pod down,
    // healthy siblings included. #513 never asked for that: its acceptance is "no
    // permanent DNS failure line, no prune". D4 fail-static is the house rule for
    // a condition we cannot resolve this pass, and the transient branch already
    // obeys it. When there is a live policy to serve, serve it, report the fault,
    // and let the workload run on the last known-good egress.
    await seedAccumulatedPolicy({ lapsed: false })
    injectPostResolutionTypeError()

    await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()

    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.status).toBe('False')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressReconcileFailed')
  })

  it('T8 still throws on a fault with nothing to serve (bootstrap)', async () => {
    // The other half of the same decision, pinned so it cannot be lost: with no
    // live policy there is no frozen set, so serving is not an option and the
    // reconcile must fail loud. Without this test, "stop throwing" could be
    // satisfied by never throwing at all.
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)
  })

  it('T9 reports the rejected binding alongside the fault instead of dropping it', async () => {
    // Review of #567, blocker 1. `failures` has exactly one sink — the message at
    // the end — and the fault branch throws before reaching it. A pass carrying
    // both loses the operator's own config error entirely: not in the status, not
    // in a log. Meanwhile cleanup has already deleted that binding's policy,
    // because a `failures.push(...); continue` never reaches
    // desiredPolicyNames.add. The operator is left with a de-authorized
    // destination, a status blaming an unrelated binding, and no trace of why.
    const twoBindings: McpServerCRD = {
      ...server,
      spec: {
        ...server.spec,
        egressBindings: [
          { dns: 'api.example.com', port: 443 },
          { dns: '*.wildcard.example.com', port: 443 },
        ],
      },
    }
    resolve4Mock.mockResolvedValue(rec('1.2.3.4'))
    await reconciler.reconcileExternalEgress(twoBindings, { isCurrent: () => true }).catch(() => {})
    mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
    injectPostResolutionTypeError()

    await reconciler
      .reconcileExternalEgress(twoBindings, { isCurrent: () => true })
      .catch(() => undefined)

    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    const message = egress.at(-1)?.message ?? ''
    expect(message).toContain('api.example.com')
    expect(message).toMatch(/wildcard/)
  })

  it('T5 keeps freezing the lapsed window on a real transient resolver code', async () => {
    // The gate has two exemptions and this pins the one the other tests do not
    // touch. Deleting `kind !== 'transient'` from the condition turns every
    // transient failure into a rethrow — fail-static (D4) collapses, and an
    // outage at the resolver would take the accumulated /32s with it.
    //
    // The only other coverage of this branch lives in
    // `networkPolicyReconciler.egressFailStatic.test.ts`, and it arrives via the
    // bounded-timeout wrapper's synthetic ETIMEDOUT rather than an answer the
    // resolver actually gave. ESERVFAIL is that answer.
    await seedAccumulatedPolicy({ lapsed: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    resolve4Mock.mockRejectedValueOnce(
      Object.assign(new Error('queryA ESERVFAIL api.example.com'), { code: 'ESERVFAIL' })
    )

    // Freezing means the reconcile completes: no rethrow, no prune, no delete.
    await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(warn.mock.calls.flat().join('\n')).not.toContain('permanent DNS failure')
    warn.mockRestore()

    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.reason).not.toBe('ExternalEgressReconcileFailed')
  })

  it("T4 treats EBADNAME as the operator's malformed name, not as a controller fault", async () => {
    // EBADNAME is a POSITIVE verdict about the name: c-ares refused to send the
    // query at all, so it belongs with NXDOMAIN — prune and reject. Blaming the
    // controller with ExternalEgressReconcileFailed would send the operator
    // hunting through our logs for their own typo.
    //
    // This controller cannot currently produce EBADNAME from its own CRD field:
    // isPublicDnsHostname rejects `..` and 64-octet labels before we resolve, so
    // the injection here is synthetic. The classification is still HCC's to get
    // right — PERMANENT_DNS_CODES is shared with WRC, whose ui lane does reach
    // c-ares on the CRD pattern alone, and a validator is a weaker guarantee than
    // a gate that classifies correctly whatever arrives.
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
