import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import * as dns from 'node:dns/promises'
import { ExternalEgressConvergenceCoordinator } from './externalEgressConvergenceCoordinator'
import { NetworkPolicyReconciler } from './networkPolicyReconciler'
import type { EgressBinding, McpServerCRD, McpServerCrdStatus } from './types'

vi.mock('./config', () => ({
  config: {
    namespace: 'mcp-server',
    controlPlaneNamespace: 'control-plane',
    hostNamespace: 'mcp-host',
    rpcProxyNamespace: 'rpc-proxy',
    runtimeNamespaces: ['mcp-server'],
    externalEgressDnsResolveTimeoutMs: 5000,
    externalEgressOverlapSec: 300,
    externalEgressMaxEntries: 128,
  },
}))
vi.mock('node:dns/promises', () => ({ resolve4: vi.fn() }))
vi.mock('./metrics', () => ({
  writesTotal: { inc: vi.fn() },
  writeSkipsTotal: { inc: vi.fn() },
  externalEgressRetriesAtCap: { set: vi.fn() },
}))

const currentDns: EgressBinding = { dns: 'current.example.com', port: 443 }
const removedDns: EgressBinding = { dns: 'removed.example.com', port: 8443 }
const currentName = 'ext-egress-observation-mcp-current.example.com-443'
const removedName = 'ext-egress-observation-mcp-removed.example.com-8443'
const apiError = (code: number) => Object.assign(new Error(`Kubernetes API ${code}`), { code })

function fixture(bindings: EgressBinding[]) {
  const server: McpServerCRD = {
    name: 'observation-mcp',
    namespace: 'mcp-server',
    uid: 'server-uid',
    generation: 7,
    spec: {
      contextRef: 'dev',
      image: 'observation:1',
      transport: { type: 'streamableHttp', port: 3000 },
      egressBindings: bindings,
    },
  }
  const policies = new Map<string, k8s.V1NetworkPolicy>()
  const unavailableReads = new Set<string>()
  const unavailableDeletes = new Set<string>()
  let status: McpServerCrdStatus = {}
  let version = 0
  const api = {
    listNamespacedNetworkPolicy: vi.fn(async () => ({
      items: [...policies.values()].map(policy => structuredClone(policy)),
    })),
    readNamespacedNetworkPolicy: vi.fn(async ({ name }: { name: string }) => {
      if (unavailableReads.has(name)) throw apiError(503)
      const policy = policies.get(name)
      if (!policy) throw apiError(404)
      return structuredClone(policy)
    }),
    createNamespacedNetworkPolicy: vi.fn(async ({ body }: { body: k8s.V1NetworkPolicy }) => {
      const name = body.metadata!.name!
      if (policies.has(name)) throw apiError(409)
      const policy = structuredClone(body)
      policy.metadata = { ...policy.metadata, uid: `uid-${name}`, resourceVersion: `${++version}` }
      policies.set(name, policy)
      return structuredClone(policy)
    }),
    replaceNamespacedNetworkPolicy: vi.fn(
      async ({ name, body }: { name: string; body: k8s.V1NetworkPolicy }) => {
        const current = policies.get(name)
        if (!current) throw apiError(404)
        if (body.metadata?.resourceVersion !== current.metadata?.resourceVersion)
          throw apiError(409)
        const policy = structuredClone(body)
        policy.metadata = {
          ...policy.metadata,
          uid: current.metadata!.uid,
          resourceVersion: `${++version}`,
        }
        policies.set(name, policy)
        return structuredClone(policy)
      }
    ),
    deleteNamespacedNetworkPolicy: vi.fn(
      async ({ name, body }: { name: string; body: k8s.V1DeleteOptions }) => {
        if (unavailableDeletes.has(name)) throw apiError(503)
        const current = policies.get(name)
        if (!current) throw apiError(404)
        if (
          body.preconditions?.uid !== current.metadata?.uid ||
          body.preconditions?.resourceVersion !== current.metadata?.resourceVersion
        )
          throw apiError(409)
        policies.delete(name)
      }
    ),
  }
  const customApi = {
    getNamespacedCustomObjectStatus: vi.fn(async () => ({
      metadata: { uid: server.uid, generation: server.generation, resourceVersion: 'status-rv' },
      status: structuredClone(status),
    })),
    patchNamespacedCustomObjectStatus: vi.fn(
      async ({ body }: { body: Array<{ op: string; path: string; value: unknown }> }) => {
        for (const operation of body) {
          if (operation.path === '/status') status = operation.value as McpServerCrdStatus
          if (operation.path === '/status/conditions')
            status.conditions = operation.value as McpServerCrdStatus['conditions']
          if (operation.path === '/status/resolvedEgressIPs')
            status.resolvedEgressIPs = operation.value as McpServerCrdStatus['resolvedEgressIPs']
        }
      }
    ),
  }
  const kc = new k8s.KubeConfig()
  kc.loadFromOptions({
    clusters: [{ name: 'unit', server: 'https://unit.invalid' }],
    users: [{ name: 'unit' }],
    contexts: [{ name: 'unit', cluster: 'unit', user: 'unit' }],
    currentContext: 'unit',
  })
  const reconciler = new NetworkPolicyReconciler(kc, new Map())
  Object.assign(reconciler, { networkingApi: api, customApi })
  return {
    server,
    policies,
    api,
    unavailableReads,
    unavailableDeletes,
    reconciler,
    status: () => status,
    condition: () => status.conditions?.find(condition => condition.type === 'ExternalEgressReady'),
    run: () => reconciler.reconcileExternalEgress(server, { isCurrent: () => true }),
    clearCalls: () => Object.values(api).forEach(mock => mock.mockClear()),
  }
}

describe('external egress observation failures do not decide authorization', () => {
  beforeEach(() => {
    vi.mocked(dns.resolve4).mockResolvedValue([{ address: '1.2.3.4', ttl: 300 }] as never)
  })
  afterEach(() => vi.useRealTimers())

  it('keeps the current policy unmodified and revokes a removed sibling when fresh DNS-policy reads are unavailable', async () => {
    const f = fixture([removedDns, currentDns])
    await f.run()
    const before = structuredClone(f.policies.get(currentName))
    const removed = f.policies.get(removedName)!
    f.server.spec.egressBindings = [currentDns]
    f.unavailableReads.add(currentName)
    f.clearCalls()

    await expect(f.run()).rejects.toThrow('Kubernetes API 503')

    expect(f.policies.get(currentName)).toEqual(before)
    expect(f.api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(f.api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(f.api.deleteNamespacedNetworkPolicy).toHaveBeenCalledExactlyOnceWith({
      name: removedName,
      namespace: f.server.namespace,
      body: {
        preconditions: {
          uid: removed.metadata!.uid,
          resourceVersion: removed.metadata!.resourceVersion,
        },
      },
    })
    expect(f.condition()).toMatchObject({
      status: 'False',
      reason: 'ExternalEgressReconcileFailed',
    })
    expect(f.condition()?.message).toMatch(/unavailable|could not be verified/)
    expect(f.condition()?.message).not.toMatch(/REVOKED|provenance was absent or invalid/)
    expect(f.status().resolvedEgressIPs).toEqual([])

    f.unavailableReads.clear()
    await f.run()
    expect(f.condition()).toMatchObject({ status: 'True', reason: 'Reconciled' })
    expect(f.policies.get(currentName)).toEqual(before)
    expect(f.policies.has(removedName)).toBe(false)
  })

  it.each([
    {
      binding: { cidr: '8.8.8.8/32', port: 9443 },
      name: 'ext-egress-observation-mcp-8-8-8-8-32-9443',
    },
    {
      binding: { egressClass: 'public-web' as const },
      name: 'ext-egress-observation-mcp-public-web',
    },
  ])(
    'revokes an independent removed binding despite a $name read failure and recovers without a spec change',
    async ({ binding, name }) => {
      const f = fixture([removedDns, binding])
      await f.run()
      const before = structuredClone(f.policies.get(name))
      f.server.spec.egressBindings = [binding]
      f.unavailableReads.add(name)
      f.clearCalls()

      await expect(f.run()).rejects.toThrow('Kubernetes API 503')

      expect(f.policies.has(removedName)).toBe(false)
      expect(f.policies.get(name)).toEqual(before)
      expect(f.api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(f.api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(f.condition()).toMatchObject({
        status: 'False',
        reason: 'ExternalEgressReconcileFailed',
      })
      expect(f.status().resolvedEgressIPs).toEqual([])
      f.unavailableReads.clear()
      await f.run()
      expect(f.condition()).toMatchObject({ status: 'True', reason: 'Reconciled' })
      expect(f.policies.get(name)).toEqual(before)
    }
  )

  it('does not resolve or expand until the independent removal barrier succeeds', async () => {
    const f = fixture([removedDns])
    await f.run()
    f.server.spec.egressBindings = [currentDns]
    f.unavailableDeletes.add(removedName)
    f.clearCalls()
    vi.mocked(dns.resolve4).mockClear()

    await expect(f.run()).rejects.toThrow('Kubernetes API 503')

    expect(dns.resolve4).not.toHaveBeenCalled()
    expect(f.api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(f.condition()).toMatchObject({ status: 'False', reason: 'CleanupFailed' })
    f.unavailableDeletes.clear()
    await f.run()
    expect(f.policies.has(removedName)).toBe(false)
    expect(f.policies.has(currentName)).toBe(true)
  })

  it('finishes independent removals when one delete fails, without expanding another binding', async () => {
    const f = fixture([removedDns, currentDns])
    await f.run()
    f.server.spec.egressBindings = [{ dns: 'added.example.com', port: 443 }]
    f.unavailableDeletes.add(removedName)
    f.clearCalls()

    await expect(f.run()).rejects.toThrow('Kubernetes API 503')

    expect(f.policies.has(removedName)).toBe(true)
    expect(f.policies.has(currentName)).toBe(false)
    expect(f.api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(f.condition()?.reason).toBe('CleanupFailed')
  })

  it('does not add a sibling permission while a current policy observation is pending', async () => {
    const f = fixture([currentDns])
    await f.run()
    f.server.spec.egressBindings = [{ cidr: '8.8.8.8/32', port: 443 }, currentDns]
    f.unavailableReads.add(currentName)
    f.clearCalls()

    await expect(f.run()).rejects.toThrow('Kubernetes API 503')

    expect(f.api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(f.api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(f.policies.size).toBe(1)
    expect(f.status().resolvedEgressIPs).toEqual([])
  })

  it('rechecks a deferred no-op after sibling DNS latency and recovers from the changed snapshot', async () => {
    const sibling: EgressBinding = { dns: 'later.example.com', port: 443 }
    const f = fixture([currentDns, sibling])
    await f.run()
    f.clearCalls()
    vi.mocked(dns.resolve4).mockImplementation(async hostname => {
      if (hostname === sibling.dns) {
        const policy = f.policies.get(currentName)!
        policy.metadata!.resourceVersion = 'concurrent-rv'
        policy.spec!.egress!.push({
          to: [{ ipBlock: { cidr: '8.8.8.8/32' } }],
          ports: [{ port: 443, protocol: 'TCP' }],
        })
      }
      return [{ address: '1.2.3.4', ttl: 300 }] as never
    })

    await expect(f.run()).rejects.toThrow(/changed after the external-egress observation/)

    expect(f.condition()?.status).toBe('False')
    expect(f.status().resolvedEgressIPs).toEqual([])
    expect(f.api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    vi.mocked(dns.resolve4).mockResolvedValue([{ address: '1.2.3.4', ttl: 300 }] as never)
    await f.run()
    expect(f.condition()?.status).toBe('True')
    expect(f.policies.get(currentName)?.spec?.egress).toHaveLength(1)
  })

  it('does not write or report status after the generation fence closes during an unavailable read', async () => {
    const f = fixture([currentDns])
    await f.run()
    f.clearCalls()
    const statusBefore = structuredClone(f.status())
    let current = true
    f.api.readNamespacedNetworkPolicy.mockImplementation(async () => {
      current = false
      throw apiError(503)
    })

    await f.reconciler.reconcileExternalEgress(f.server, { isCurrent: () => current })

    expect(f.api.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(f.api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(f.api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(f.status()).toEqual(statusBefore)
  })

  it('does not copy a newer resourceVersion onto a policy calculated before an apply conflict', async () => {
    const f = fixture([currentDns])
    await f.run()
    const policy = f.policies.get(currentName)!
    policy.spec!.egress!.push({
      to: [{ ipBlock: { cidr: '8.8.8.8/32' } }],
      ports: [{ port: 443, protocol: 'TCP' }],
    })
    f.clearCalls()
    f.api.createNamespacedNetworkPolicy.mockImplementationOnce(async () => {
      // The conflict retry reads this newer object after the final plan check.
      // A matching owner alone cannot authorize reuse of the older DNS state.
      policy.metadata!.resourceVersion = 'changed-before-replace'
      throw apiError(409)
    })

    await expect(f.run()).rejects.toThrow(/changed after the external-egress observation/)

    expect(f.api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(f.condition()?.status).toBe('False')
    await f.run()
    expect(f.condition()?.status).toBe('True')
    expect(f.policies.get(currentName)?.spec?.egress).toHaveLength(1)
  })

  it('does not certify a policy deleted after create conflict and before replacement read, then recovers', async () => {
    const f = fixture([currentDns])
    await f.run()
    vi.mocked(dns.resolve4).mockResolvedValue([{ address: '8.8.8.8', ttl: 300 }] as never)
    f.api.createNamespacedNetworkPolicy.mockImplementationOnce(async () => {
      // POST sees the existing policy and conflicts. A concurrent deletion then
      // wins before the helper's replacement GET, which observes real absence.
      f.policies.delete(currentName)
      throw apiError(409)
    })

    await expect(f.run()).rejects.toThrow()

    expect(f.policies.has(currentName)).toBe(false)
    expect(f.condition()).toMatchObject({
      status: 'False',
      reason: 'ExternalEgressReconcileFailed',
    })
    expect(f.status().resolvedEgressIPs).toEqual([])
    await f.run()
    expect(f.condition()).toMatchObject({ status: 'True', reason: 'Reconciled' })
    expect(f.policies.get(currentName)?.spec?.egress).toEqual([
      { to: [{ ipBlock: { cidr: '8.8.8.8/32' } }], ports: [{ port: 443, protocol: 'TCP' }] },
    ])
    expect(f.status().resolvedEgressIPs?.[0].ips).toEqual(['8.8.8.8'])
  })

  it('keeps the existing retry coordinator pending until the API recovers and then admits the same generation once', async () => {
    vi.useFakeTimers()
    const f = fixture([currentDns])
    await f.run()
    f.unavailableReads.add(currentName)
    const admitted = vi.fn()
    let coordinator: ExternalEgressConvergenceCoordinator
    coordinator = new ExternalEgressConvergenceCoordinator({
      listServers: () => [f.server],
      getCurrentServer: () => f.server,
      inventoryAuthoritative: () => true,
      sameDesiredRevision: (left, right) =>
        left.uid === right.uid && left.generation === right.generation,
      enqueue: async (_server, work) => work(),
      mutate: async (_type, server, options) =>
        f.reconciler.reconcileExternalEgress(server, options),
      replay: async (type, server, retry) => {
        const completion = await coordinator.reconcile(type, server, { retry })
        admitted(server.generation)
        completion?.complete()
      },
      externalEgressRefreshMinTtlMs: () => f.reconciler.externalEgressRefreshMinTtlMs,
    })
    try {
      const gate = coordinator.prepareStartupGates([f.server])
      expect(await gate.waitFor(f.server)).toBe(false)
      await vi.advanceTimersByTimeAsync(5000)
      expect(admitted).not.toHaveBeenCalled()
      expect(f.condition()?.status).toBe('False')
      f.unavailableReads.clear()
      await vi.advanceTimersByTimeAsync(15000)
      expect(admitted).toHaveBeenCalledExactlyOnceWith(7)
      expect(f.condition()?.status).toBe('True')
      await vi.advanceTimersByTimeAsync(60000)
      expect(admitted).toHaveBeenCalledTimes(1)
    } finally {
      coordinator.stop()
    }
  })
})
