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
  const normalizePolicy = (
    policy: k8s.V1NetworkPolicy,
    namespace: string,
    index = 0
  ): k8s.V1NetworkPolicy => {
    const name = policy.metadata?.name ?? `unnamed-${index}`
    return {
      ...policy,
      metadata: {
        ...policy.metadata,
        name,
        namespace: policy.metadata?.namespace ?? namespace,
        uid: policy.metadata?.uid ?? `${namespace}:${name}:uid`,
        resourceVersion: policy.metadata?.resourceVersion ?? '1',
      },
    }
  }
  const networkingApi = {
    ...mockApi,
    listNamespacedNetworkPolicy: async (args: { namespace: string }) => {
      const response = await mockApi.listNamespacedNetworkPolicy(args)
      const items = (response.items ?? []).map((policy: k8s.V1NetworkPolicy, index: number) =>
        normalizePolicy(policy, args.namespace, index)
      )
      return { ...response, items }
    },
    readNamespacedNetworkPolicy: async (args: { name: string; namespace: string }) => {
      const direct = (await mockApi.readNamespacedNetworkPolicy(args)) as k8s.V1NetworkPolicy
      if (direct.metadata?.name || direct.spec) return normalizePolicy(direct, args.namespace)
      const response = await mockApi.listNamespacedNetworkPolicy({ namespace: args.namespace })
      const found = (response.items ?? []).find(
        (policy: k8s.V1NetworkPolicy) => policy.metadata?.name === args.name
      )
      if (!found) throw Object.assign(new Error('not found'), { code: 404 })
      return normalizePolicy(found, args.namespace)
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
  async function seedAccumulatedPolicy(opts: {
    lapsed: boolean
    srv?: McpServerCRD
  }): Promise<void> {
    await reconciler.reconcileExternalEgress(opts.srv ?? server, { isCurrent: () => true })
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

  function injectPostResolutionCodedError(code: string): void {
    const record = Object.defineProperty({ ttl: 300 }, 'address', {
      get() {
        throw Object.assign(new Error(`post-resolution ${code}`), { code })
      },
    }) as RecordWithTtl
    resolve4Mock.mockResolvedValueOnce([record])
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

    // A verified prior policy may remain for already-running pods, but the
    // controller fault still blocks new/update runtime reconciliation.
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

  it('T2b never promotes annotation-only state during transient fail-static', async () => {
    await seedAccumulatedPolicy({ lapsed: false })
    const listed = (await mockApi.listNamespacedNetworkPolicy({ namespace: 'mcp-server' })) as {
      items: k8s.V1NetworkPolicy[]
    }
    const drifted = structuredClone(listed)
    const state = JSON.parse(
      drifted.items[0].metadata!.annotations!['clerum.io/egress-fqdn-state']
    ) as Array<Record<string, unknown>>
    state.push({
      ...state[0],
      ip: '8.8.8.8',
    })
    drifted.items[0].metadata!.annotations!['clerum.io/egress-fqdn-state'] = JSON.stringify(state)
    mockApi.listNamespacedNetworkPolicy.mockResolvedValue(drifted)
    resolve4Mock.mockRejectedValueOnce(
      Object.assign(new Error('queryA ESERVFAIL api.example.com'), { code: 'ESERVFAIL' })
    )

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(/Fail-static proof failed/)

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: drifted.items[0].metadata!.name })
    )
    const written = mockApi.replaceNamespacedNetworkPolicy.mock.calls
      .map(call => JSON.stringify(call[0]?.body))
      .join(' ')
    expect(written).not.toContain('8.8.8.8')
    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.status).toBe('False')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressReconcileFailed')
    expect(egress.at(-1)?.message).toContain('REVOKED')
  })

  it('T2c never promotes annotation-only state after an accepted DNS answer', async () => {
    await seedAccumulatedPolicy({ lapsed: false })
    const listed = (await mockApi.listNamespacedNetworkPolicy({ namespace: 'mcp-server' })) as {
      items: k8s.V1NetworkPolicy[]
    }
    const drifted = structuredClone(listed)
    const state = JSON.parse(
      drifted.items[0].metadata!.annotations!['clerum.io/egress-fqdn-state']
    ) as Array<Record<string, unknown>>
    state.push({ ...state[0], ip: '8.8.8.8' })
    drifted.items[0].metadata!.annotations!['clerum.io/egress-fqdn-state'] = JSON.stringify(state)
    mockApi.listNamespacedNetworkPolicy.mockResolvedValue(drifted)

    await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

    const writes = [
      ...mockApi.createNamespacedNetworkPolicy.mock.calls,
      ...mockApi.replaceNamespacedNetworkPolicy.mock.calls,
    ]
      .map(call => JSON.stringify(call[0]?.body))
      .join(' ')
    expect(writes).not.toContain('8.8.8.8')
    expect(writes).toContain('1.2.3.4')
    expect(servedPayload()).not.toContain('8.8.8.8')
    expect(servedPayload()).toContain('1.2.3.4')
  })

  it.each(['ETIMEDOUT', 'ENOTFOUND'])(
    'T2a keeps a post-resolution %s exception out of DNS classification',
    async code => {
      await seedAccumulatedPolicy({ lapsed: false })
      injectPostResolutionCodedError(code)

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow(`post-resolution ${code}`)

      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
      const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
      expect(egress.at(-1)?.reason).toBe('ExternalEgressReconcileFailed')
      expect(egress.at(-1)?.message).not.toContain('DNS failure')
    }
  )

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

  it('T3a revokes and blocks on genuine NXDOMAIN even while the prior window is unexpired', async () => {
    await seedAccumulatedPolicy({ lapsed: false })
    resolve4Mock.mockRejectedValueOnce(
      Object.assign(new Error('queryA ENOTFOUND api.example.com'), { code: 'ENOTFOUND' })
    )

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(/failed to resolve hostname "api\.example\.com"/)

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.status).toBe('False')
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
    await expect(
      reconciler.reconcileExternalEgress(bindings(['b.example.com']), {
        isCurrent: () => true,
      })
    ).rejects.toThrow(TypeError)

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

  it('T7 retains a verified set for existing pods but blocks runtime on a controller fault', async () => {
    await seedAccumulatedPolicy({ lapsed: false })
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()

    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.status).toBe('False')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressReconcileFailed')
  })

  it('T10 refuses to serve or report a live policy that drifted into a blocked range', async () => {
    // Closing audit, H1. The fault branch reads CIDRs off the live policy and
    // reports them as "what is enforced right now". That is only safe if the live
    // policy is trustworthy. It is the one path that neither re-validates nor
    // self-heals: the safety lane retains DNS policies modulo cidr, and the list
    // is by label without an ownership read, so nothing else repairs drift.
    //
    // An out-of-band edit to a private range would otherwise be published in
    // status.resolvedEgressIPs as the resolution of a public hostname, and
    // counted as "something to serve" — keeping the pass non-blocking and the
    // private range enforced on every resync for as long as the fault lasts.
    await seedAccumulatedPolicy({ lapsed: false })
    const items = (await mockApi.listNamespacedNetworkPolicy({ namespace: 'mcp-server' })) as {
      items: Array<{ spec?: k8s.V1NetworkPolicySpec }>
    }
    const drifted = JSON.parse(JSON.stringify(items)) as typeof items
    drifted.items[0].spec!.egress![0]!.to![0]!.ipBlock!.cidr = '10.0.0.5/32'
    mockApi.listNamespacedNetworkPolicy.mockResolvedValue(drifted)
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    const reported = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls
      // `mock.calls` is `any[][]`; a fixed-length tuple annotation does not
      // typecheck under `tsc --noEmit`, which includes test files while
      // `tsconfig.build.json` does not.
      .flatMap((call: unknown[]) => (call[0] as { body?: Array<{ value?: unknown }> })?.body ?? [])
      .map(op => JSON.stringify(op.value))
      .join(' ')
    expect(reported).not.toContain('10.0.0.5')
  })

  it('T11 revokes the drifted policy instead of leaving the blocked range enforced', async () => {
    // Review of #567, R1-L1. T10 pins that a drifted policy is not SERVED and not
    // REPORTED. Neither of those stops it being ENFORCED: the fault branch adds
    // the binding to `desiredPolicyNames` before it knows whether the live object
    // is trustworthy, so `cleanupExternalEgress` reads it as still-desired and
    // keeps it, while the `continue` skips the rewrite. The private range then
    // stays in the dataplane for as long as the fault repeats — every 30s,
    // forever, for a deterministic fault.
    //
    // At the merge-base this same input self-healed: the fault was laundered into
    // the permanent branch, which rebuilt the policy from the annotation window
    // and wrote 1.2.3.4/32 back over the drift. So #567 made this input strictly
    // worse, and that is what this test exists to stop.
    //
    // The invariant both revisions share is that 10.0.0.5/32 does not survive the
    // pass. They reach it differently, and this test pins the mechanism THIS
    // branch can actually use: revocation. Rewriting — what the merge-base did —
    // is not available here, because rebuilding the policy means recomputing, and
    // recomputing is exactly what faulted. Revoking is fail-CLOSED: these are pure
    // allow policies (`policyTypes: ['Egress']` over an ipBlock list) under the
    // namespace L0 deny-all, so removing one closes that destination rather than
    // opening it, and none of them is a deny whose removal would open traffic.
    await seedAccumulatedPolicy({ lapsed: false })
    const items = (await mockApi.listNamespacedNetworkPolicy({ namespace: 'mcp-server' })) as {
      items: Array<{ metadata?: { name?: string }; spec?: k8s.V1NetworkPolicySpec }>
    }
    const drifted = JSON.parse(JSON.stringify(items)) as typeof items
    drifted.items[0].spec!.egress![0]!.to![0]!.ipBlock!.cidr = '10.0.0.5/32'
    const policyName = drifted.items[0].metadata!.name!
    mockApi.listNamespacedNetworkPolicy.mockResolvedValue(drifted)
    injectPostResolutionTypeError()

    // Liveness witness for the negative assertions below: the fault branch really
    // ran and really blocked. Without this, "the blocked range is not enforced"
    // would be satisfied just as well by a pass that never reached the branch.
    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    // The revocation must happen BEFORE the throw. `cleanupExternalEgress` runs
    // after the binding loop and before the deferred fault is rethrown; a fix that
    // moved the throw earlier would restore the fail-loud-paid-with-fail-open
    // defect a previous round closed, and this assertion is what would catch it.
    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: policyName })
    )

    // Nothing rewrote it with the drift still in place, either.
    const rewritten = mockApi.replaceNamespacedNetworkPolicy.mock.calls
      .map(call => JSON.stringify((call[0] as { body?: unknown }).body))
      .join(' ')
    expect(rewritten).not.toContain('10.0.0.5')

    // And the operator is told what actually happened. The generic fault message
    // says "accumulated egress left untouched", which on this path would describe
    // the opposite of the pass — a status disagreeing with the dataplane is the
    // defect T7's sibling assertion was added to stop.
    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressReconcileFailed')
    expect(egress.at(-1)?.message).toContain('REVOKED')
    expect(egress.at(-1)?.message).not.toContain('left untouched')
  })

  it('T11a revokes a policy whose CIDR drifted to an over-broad public prefix', async () => {
    // #590. T11 pins the BLOCKED-range shape. This is the shape the guard read as
    // clean: `isAllowedExternalEgressCidr` checks that a CIDR parses and does not
    // overlap the blocked ranges, and 1.0.0.0/8 does neither — so the drifted
    // policy was judged trustworthy, served, and published in
    // `status.resolvedEgressIPs` as the resolution of the hostname, while the pass
    // stayed non-blocking. 16.7 million addresses reported as one host.
    //
    // The verdict now also requires the /32 this controller is the only thing that
    // ever writes. Anything wider is drift by definition, whatever it allows.
    await seedAccumulatedPolicy({ lapsed: false })
    const items = (await mockApi.listNamespacedNetworkPolicy({ namespace: 'mcp-server' })) as {
      items: Array<{ metadata?: { name?: string }; spec?: k8s.V1NetworkPolicySpec }>
    }
    const drifted = JSON.parse(JSON.stringify(items)) as typeof items
    drifted.items[0].spec!.egress![0]!.to![0]!.ipBlock!.cidr = '1.0.0.0/8'
    const policyName = drifted.items[0].metadata!.name!
    mockApi.listNamespacedNetworkPolicy.mockResolvedValue(drifted)
    injectPostResolutionTypeError()

    // Liveness witness: the fault branch ran and blocked. Without it, "the broad
    // prefix is not served" is satisfied equally by never reaching the branch.
    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: policyName })
    )
    // Not published as the hostname's resolution either — that is the half a
    // reader is most likely to trust. Read straight off the patch calls, the same
    // source `statusConditions` uses.
    const served = JSON.stringify(
      mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.map(
        (call: unknown[]) => (call[0] as { body?: unknown } | undefined)?.body
      )
    )
    expect(served).not.toContain('1.0.0.0')

    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressReconcileFailed')
    expect(egress.at(-1)?.message).toContain('REVOKED')
  })

  it('T11b revokes a policy that gained a non-ipBlock egress peer', async () => {
    // #590, the subtler half. The projection mapped every `to[]` peer through
    // `to.ipBlock?.cidr` and filtered out the undefineds — so a `namespaceSelector`
    // peer vanished BEFORE the comparison, leaving `enforced.length` compared
    // against itself and the verdict reading `true` for a policy that had grown a
    // whole extra allow rule.
    //
    // The /32 beside it is untouched and valid, which is the point: the CIDRs the
    // guard looked at were all fine. What made the policy untrustworthy was the
    // shape it had acquired, and shape was exactly what the projection discarded.
    await seedAccumulatedPolicy({ lapsed: false })
    const items = (await mockApi.listNamespacedNetworkPolicy({ namespace: 'mcp-server' })) as {
      items: Array<{ metadata?: { name?: string }; spec?: k8s.V1NetworkPolicySpec }>
    }
    const drifted = JSON.parse(JSON.stringify(items)) as typeof items
    drifted.items[0].spec!.egress!.push({
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'default' } } }],
    })
    const policyName = drifted.items[0].metadata!.name!
    mockApi.listNamespacedNetworkPolicy.mockResolvedValue(drifted)
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: policyName })
    )
    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressReconcileFailed')
    expect(egress.at(-1)?.message).toContain('REVOKED')
  })

  it('T11c retains a clean /32 for existing pods while blocking runtime', async () => {
    // Anti-over-correction. T11/T11a/T11b all assert revocation, so a guard that
    // simply declared everything untrustworthy would satisfy the three of them
    // and destroy fail-static, which is the property five review rounds converged
    // on. This is the case that must still be SERVED.
    await seedAccumulatedPolicy({ lapsed: false })
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    // The clean policy is kept, not revoked …
    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    // … and it is still reported as what is enforced right now.
    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.message).not.toContain('REVOKED')
    // The /32 the fixture seeded is what gets served, so a guard that narrowed
    // into rejecting everything would fail here rather than pass quietly.
    const served = JSON.stringify(
      mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.map(
        (call: unknown[]) => (call[0] as { body?: unknown } | undefined)?.body
      )
    )
    expect(served).toContain('1.2.3.4')
  })

  it('T11c1 revokes a canonical public /32 absent from persisted DNS state', async () => {
    await seedAccumulatedPolicy({ lapsed: false })
    const policyName = await driftLivePolicy(spec => {
      spec.egress!.push({
        to: [{ ipBlock: { cidr: '8.8.8.8/32' } }],
        ports: [{ port: 443, protocol: 'TCP' }],
      })
    })
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: policyName })
    )
    expect(servedPayload()).not.toContain('8.8.8.8')
  })

  it('T11c2 rejects an otherwise canonical state above the configured cap', async () => {
    await seedAccumulatedPolicy({ lapsed: false })
    const items = (await mockApi.listNamespacedNetworkPolicy({ namespace: 'mcp-server' })) as {
      items: k8s.V1NetworkPolicy[]
    }
    const drifted = structuredClone(items)
    const now = Date.now()
    const ips = Array.from({ length: 129 }, (_, index) => `11.0.0.${index + 1}`)
    drifted.items[0].metadata!.annotations!['clerum.io/egress-fqdn-state'] = JSON.stringify(
      ips.map(ip => ({
        ip,
        port: 443,
        protocol: 'TCP',
        fqdn: 'api.example.com',
        expiresAt: now + 600_000,
        lastObservedAt: now,
      }))
    )
    drifted.items[0].spec!.egress = ips.map(ip => ({
      to: [{ ipBlock: { cidr: `${ip}/32` } }],
      ports: [{ port: 443, protocol: 'TCP' }],
    }))
    const policyName = drifted.items[0].metadata!.name!
    mockApi.listNamespacedNetworkPolicy.mockResolvedValue(drifted)
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)
    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: policyName })
    )
  })

  it('T11c3 judges a fresh GET and fences deletion to that resourceVersion', async () => {
    await seedAccumulatedPolicy({ lapsed: false })
    const listed = (await mockApi.listNamespacedNetworkPolicy({ namespace: 'mcp-server' })) as {
      items: k8s.V1NetworkPolicy[]
    }
    const fresh = structuredClone(listed.items[0])
    fresh.metadata = {
      ...fresh.metadata,
      name: fresh.metadata!.name!,
      namespace: 'mcp-server',
      uid: 'fresh-policy-uid',
      resourceVersion: '99',
    }
    fresh.spec!.egress!.push({
      to: [{ ipBlock: { cidr: '8.8.4.4/32' } }],
      ports: [{ port: 443, protocol: 'TCP' }],
    })
    mockApi.readNamespacedNetworkPolicy.mockResolvedValue(fresh)
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: fresh.metadata!.name,
        body: { preconditions: { uid: 'fresh-policy-uid', resourceVersion: '99' } },
      })
    )
  })

  it('T11c3a leaves a fresh homonymous policy untouched when HCC does not own it', async () => {
    const policyName = 'ext-egress-classify-mcp-api.example.com-443'
    mockApi.readNamespacedNetworkPolicy.mockResolvedValue({
      metadata: {
        name: policyName,
        namespace: 'mcp-server',
        uid: 'foreign-policy-uid',
        resourceVersion: '77',
        labels: {
          'clerum.io/managed-by': 'another-controller',
          'clerum.io/policy-type': 'external-egress',
          'clerum.io/mcpserver': server.name,
        },
      },
      spec: {
        podSelector: { matchLabels: { app: 'foreign-workload' } },
        policyTypes: ['Egress'],
        egress: [],
      },
    } satisfies k8s.V1NetworkPolicy)
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(/conflicting or incomplete ownership/)

    // A fresh GET is authoritative for both integrity and ownership. A policy
    // that merely occupies HCC's deterministic name is not ours to retain,
    // rewrite, or revoke—even while the controller correctly blocks runtime.
    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressReconcileFailed')
    expect(egress.at(-1)?.message).toContain('not HCC-owned')
    expect(egress.at(-1)?.message).toContain('left untouched')
  })

  it('T11c4 preserves the last successful resolvedAt on a controller fault', async () => {
    await seedAccumulatedPolicy({ lapsed: false })
    const listed = (await mockApi.listNamespacedNetworkPolicy({ namespace: 'mcp-server' })) as {
      items: k8s.V1NetworkPolicy[]
    }
    const oldResolvedAt = '2000-01-01T00:00:00.000Z'
    listed.items[0].metadata!.annotations!['clerum.io/egress-fqdn-resolved-at'] = oldResolvedAt
    mockApi.listNamespacedNetworkPolicy.mockResolvedValue(listed)
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)
    expect(servedPayload()).toContain(oldResolvedAt)
  })

  /** The live policy the fixture seeded, cloned and handed to a drift mutation. */
  async function driftLivePolicy(mutate: (spec: k8s.V1NetworkPolicySpec) => void): Promise<string> {
    const items = (await mockApi.listNamespacedNetworkPolicy({ namespace: 'mcp-server' })) as {
      items: Array<{ metadata?: { name?: string }; spec?: k8s.V1NetworkPolicySpec }>
    }
    const drifted = JSON.parse(JSON.stringify(items)) as typeof items
    mutate(drifted.items[0].spec!)
    mockApi.listNamespacedNetworkPolicy.mockResolvedValue(drifted)
    return drifted.items[0].metadata!.name!
  }

  /** Everything the status wrote, as one string — what the operator ends up seeing. */
  function servedPayload(): string {
    return JSON.stringify(
      mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.map(
        (call: unknown[]) => (call[0] as { body?: unknown } | undefined)?.body
      )
    )
  }

  it('T11d revokes a policy that grew an egress rule with no `to` (allow-all)', async () => {
    // Review of #567 round 2, R2-H1. The same defect as #590, one level up.
    //
    // #590 fixed the PEER projection: a `to[]` entry that was not an ipBlock
    // stopped vanishing before the comparison. This is the RULE projection.
    // `flatMap(rule => rule.to ?? [])` gives a rule with NO `to` exactly zero
    // peers, so it contributes nothing to `enforced`, nothing to `every`, and the
    // length comparison went back to being 0 === 0 — a number compared with
    // itself, which is the shape of all three findings in this class.
    //
    // And it was the worst member of the class to miss. An egress rule with no
    // `to` means allow-all destinations. Under the namespace L0 deny-all the
    // served pod kept egress to EVERY destination on that port for as long as the
    // fault repeated, and the `continue` skips the rewrite, so nothing healed it.
    await seedAccumulatedPolicy({ lapsed: false })
    const policyName = await driftLivePolicy(spec => {
      spec.egress!.push({ ports: [{ port: 53, protocol: 'UDP' }] })
    })
    injectPostResolutionTypeError()

    // Liveness witness: the fault branch ran and blocked. Without it, "the
    // allow-all is not enforced" is satisfied by a pass that never got here.
    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: policyName })
    )
    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressReconcileFailed')
    // The CIDRs were all fine; it is the SHAPE that is not one we write, and the
    // operator message has to say which of the two it was.
    expect(egress.at(-1)?.message).toContain('REVOKED')
    expect(egress.at(-1)?.message).toContain('shape')
    expect(egress.at(-1)?.message).not.toContain('left untouched')
    // Nothing untrustworthy is published as the resolution of the hostname.
    expect(servedPayload()).not.toContain('1.2.3.4')
  })

  it('T11e revokes a policy whose `ports` were widened out-of-band', async () => {
    // R2-M1, same root as T11d and the same fix. Dropping the `ports` block from
    // a rule means every port, not just the one the binding declared. The old
    // verdict never looked at `ports` at all, so a policy whose `to` was still the
    // correct /32 stayed enforced with the widened ports while the fault repeated.
    //
    // On the merge-base this same input self-healed: the fault was laundered into
    // the permanent branch, which rebuilt from `binding.port` and rewrote it. So,
    // like T11, this is an input #567 made strictly worse.
    await seedAccumulatedPolicy({ lapsed: false })
    const policyName = await driftLivePolicy(spec => {
      delete spec.egress![0]!.ports
    })
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: policyName })
    )
    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.message).toContain('REVOKED')
    expect(servedPayload()).not.toContain('1.2.3.4')
  })

  // Every remaining dimension of the shape, in one table. The point of judging by
  // rebuild-and-compare rather than by predicate is that no dimension needs its
  // own arm — so the table is the evidence for that claim, not decoration. Each
  // row dies to replacing `sameNetworkPolicySpec(...)` with `true`; the
  // podSelector, policyTypes and ingress rows additionally die to a verdict that
  // compares only `spec.egress`.
  const shapeDrifts: Array<[string, (spec: k8s.V1NetworkPolicySpec) => void]> = [
    ['a changed port', spec => void (spec.egress![0]!.ports = [{ port: 80, protocol: 'TCP' }])],
    [
      'an added endPort range',
      spec => void (spec.egress![0]!.ports = [{ port: 443, protocol: 'TCP', endPort: 8443 }]),
    ],
    [
      'a changed protocol',
      spec => void (spec.egress![0]!.ports = [{ port: 443, protocol: 'UDP' }]),
    ],
    ['a widened policyTypes', spec => void (spec.policyTypes = ['Egress', 'Ingress'])],
    ['an emptied podSelector', spec => void (spec.podSelector = {})],
    [
      'a podSelector pointing at another server',
      spec => void (spec.podSelector = { matchLabels: { 'clerum.io/mcpserver': 'other-mcp' } }),
    ],
    [
      'an ipBlock.except carve-out',
      spec => void (spec.egress![0]!.to![0]!.ipBlock!.except = ['1.2.3.0/30']),
    ],
    [
      'two ipBlocks folded into one rule',
      spec => void spec.egress![0]!.to!.push({ ipBlock: { cidr: '5.6.7.8/32' } }),
    ],
    ['an added ingress rule', spec => void (spec.ingress = [{}])],
  ]

  it.each(shapeDrifts)('T11f revokes a policy with %s', async (_label, mutate) => {
    await seedAccumulatedPolicy({ lapsed: false })
    const policyName = await driftLivePolicy(mutate)
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: policyName })
    )
    expect(
      statusConditions()
        .filter(c => c.type === 'ExternalEgressReady')
        .at(-1)?.message
    ).toContain('REVOKED')
  })

  it('T11g retains a clean multi-CIDR UDP binding while blocking runtime', async () => {
    // Anti-over-correction, the half T11c cannot cover. T11c serves ONE /32 on the
    // default TCP/443 binding, so a verdict that rebuilt the shape with a
    // hardcoded TCP, a hardcoded port, or only the first CIDR would still satisfy
    // it. This binding is UDP and resolves to two addresses, so the rebuild has to
    // read `binding.protocol`, `binding.port` and the whole live CIDR list to
    // agree with what the controller actually wrote.
    //
    // Over-correction is the real risk of this change: a comparator stricter than
    // what the controller writes revokes legitimate policies, which is an egress
    // outage — worse than the bug it closes.
    const udpServer: McpServerCRD = {
      ...server,
      spec: {
        ...server.spec,
        egressBindings: [{ dns: 'api.example.com', port: 53, protocol: 'UDP' }],
      },
    }
    resolve4Mock.mockResolvedValue(rec('1.2.3.4', '9.9.9.9'))
    await seedAccumulatedPolicy({ lapsed: false, srv: udpServer })
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(udpServer, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    // Both accumulated addresses are still served, so a rebuild that kept only the
    // first CIDR fails here rather than passing quietly.
    const served = servedPayload()
    expect(served).toContain('1.2.3.4')
    expect(served).toContain('9.9.9.9')
    expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(
      statusConditions()
        .filter(c => c.type === 'ExternalEgressReady')
        .at(-1)?.message
    ).toContain('runtime remains blocked')
  })

  it('T11h revokes a live policy with no egress rules — a deny disguised as an allow', async () => {
    // The emptiness trap, and the reason the verdict gates on `cidrs.length > 0`
    // before comparing. A rebuild from an empty CIDR list produces an empty
    // `egress`, which compares EQUAL to a live policy that has no rules — so the
    // shape test alone would call the drift intact, report zero addresses as "what
    // is enforced right now", and mark the pass non-blocking on the strength of a
    // policy that allows nothing. The safety lane refuses the same shape for the
    // same reason.
    await seedAccumulatedPolicy({ lapsed: false })
    const policyName = await driftLivePolicy(spec => {
      spec.egress = []
    })
    injectPostResolutionTypeError()

    await expect(
      reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
    ).rejects.toThrow(TypeError)

    expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: policyName })
    )
    expect(servedPayload()).not.toContain('1.2.3.4')
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

    // Bootstrap is its own verdict, not a revocation, and the status has to say
    // so. The old boolean made this case indistinguishable from "we served the
    // accumulated set": with nothing live, `trustworthy` came out true by
    // vacuity and the message claimed the accumulated egress was left untouched —
    // describing an accumulation that never existed. Collapsing bootstrap back
    // into either of the other two states is caught here rather than by the
    // throw, which all three states share.
    const egress = statusConditions().filter(c => c.type === 'ExternalEgressReady')
    expect(egress.at(-1)?.reason).toBe('ExternalEgressReconcileFailed')
    expect(egress.at(-1)?.message).toContain('no live policy to serve')
    expect(egress.at(-1)?.message).not.toContain('REVOKED')
    expect(egress.at(-1)?.message).not.toContain('left untouched')
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
    //
    // NOT a RED-first test, and the PR body no longer claims it is (#567 review,
    // R1-M1): copy this file onto the merge-base and T4 passes, because there
    // `classifyDnsError` already defaults EBADNAME to 'permanent' and reaches the
    // same prune-and-reject outcome by the accident this PR exists to remove. No
    // assertion about EBADNAME can be red at the merge-base, since base and head
    // are observationally identical for this input; making it red would mean
    // changing what EBADNAME does, which is production code bent to a test.
    //
    // It is still live coverage, verified by mutation rather than asserted:
    // dropping `!isPermanentDnsCode(code)` from the gate kills it (along with
    // T3), and dropping 'EBADNAME' from PERMANENT_DNS_CODES kills T4 ALONE — no
    // other test in the HCC suite notices. That second mutation is what T4 is
    // here for.
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
