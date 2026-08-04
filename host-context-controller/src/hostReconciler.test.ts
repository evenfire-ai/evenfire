import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  asAppsApi,
  asCoreApi,
  asNetworkingApi,
  asRbacApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockNetworkingApi,
  createMockRbacApi,
} from '../test/__fixtures__/testMocks'
import {
  HostFleetReconcileError,
  HostReconciler,
  destructiveCleanupAllowed,
} from './hostReconciler'
import { HostK8sRequestTimeoutError } from './k8s/hostK8sApiClient'
import { registry } from './metrics'
import { HostCRD } from './types'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

vi.mock('./config', () => ({
  config: {
    hostNamespace: 'mcp-host',
    hostWorkspaceStorageClassName: 'standard',
    hostWorkspaceStorageSize: '1Gi',
    hostWorkspacePath: '/workspace',
    hostImage: 'clerum/mcp-host:test',
    desktopImage: 'clerum/mcp-host-desktop:test',
    hostImagePullPolicy: 'IfNotPresent',
    hostImagePullSecretName: '',
    hostPort: 8080,
    gfsNamespace: 'gfs',
    gfscPort: 8087,
    desktopPort: 3000,
    rpcProxyNamespace: 'rpc-proxy',
    channelsNamespace: 'channels',
    hostK8sRequestTimeoutMs: 30_000,
    hostFullReconcileConcurrency: 2,
    mcpHostGatewayUrl: 'http://mcp-host-gateway',
    hostResources: {
      requests: { memory: '128Mi', cpu: '50m' },
      limits: { memory: '256Mi', cpu: '200m' },
    },
    desktopResources: {
      requests: { memory: '256Mi', cpu: '100m' },
      limits: { memory: '512Mi', cpu: '500m' },
    },
  },
}))

vi.mock('./gfsHostBinding', () => ({
  mintHostGfsToken: vi
    .fn()
    .mockImplementation(async ({ name, namespace }: { name: string; namespace: string }) => ({
      token: 'gfs-runtime-value',
      expiresInSeconds: 300,
      subject: `host:1st:${namespace}/${name}`,
    })),
}))

function makeHost(overrides: Partial<HostCRD['spec']> & { name?: string } = {}): HostCRD {
  const { name, ...specOverrides } = overrides
  return {
    name: name ?? 'chatllm',
    namespace: 'mcp-host',
    spec: {
      host: name ?? 'chatllm',
      contextRef: 'ctx1',
      secretRef: 'llm-secret',
      ...specOverrides,
    },
  }
}

function hccOwnedHostResource(hostName = 'chatllm') {
  return {
    metadata: {
      labels: {
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/host': hostName,
      },
      resourceVersion: '1',
    },
  }
}

describe('HostReconciler secret fail-closed cleanup', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const networkingApi = createMockNetworkingApi()
  const rbacApi = createMockRbacApi()
  let reconciler: HostReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      networkingApi: asNetworkingApi(networkingApi),
      rbacApi: asRbacApi(rbacApi),
    })
  })

  it('removes runtime endpoints and RBAC on missing Host secret but preserves PVC', async () => {
    const missing = new Error('missing') as Error & { code?: number }
    missing.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(missing).mockResolvedValueOnce({
      metadata: {
        labels: {
          'clerum.io/managed-by': 'host-context-controller',
          'clerum.io/host': 'chatllm',
        },
      },
    })
    appsApi.readNamespacedDeployment.mockResolvedValue(hccOwnedHostResource())
    coreApi.readNamespacedService.mockResolvedValue(hccOwnedHostResource())
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue(hccOwnedHostResource())
    rbacApi.readNamespacedRoleBinding.mockResolvedValue(hccOwnedHostResource())
    rbacApi.readNamespacedRole.mockResolvedValue(hccOwnedHostResource())
    coreApi.readNamespacedServiceAccount.mockResolvedValue(hccOwnedHostResource())

    await reconciler.reconcile(makeHost({ name: 'chatllm' }))

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'chatllm',
      namespace: 'mcp-host',
    })
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'chatllm',
      namespace: 'mcp-host',
    })
    expect(rbacApi.deleteNamespacedRole).toHaveBeenCalled()
    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledWith({
      name: 'host-chatllm-mcp-host-runtime-tokens',
      namespace: 'mcp-host',
    })
    expect(coreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it('does not delete host resources missing HCC ownership labels', async () => {
    const missing = new Error('missing') as Error & { code?: number }
    missing.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(missing).mockResolvedValueOnce({
      metadata: {
        labels: {
          'clerum.io/managed-by': 'host-context-controller',
          'clerum.io/host': 'chatllm',
        },
      },
    })
    const userOwned = { metadata: { labels: { 'clerum.io/managed-by': 'user' } } }
    appsApi.readNamespacedDeployment.mockResolvedValue(userOwned)
    coreApi.readNamespacedService.mockResolvedValue(userOwned)
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue(userOwned)
    rbacApi.readNamespacedRoleBinding.mockResolvedValue(userOwned)
    rbacApi.readNamespacedRole.mockResolvedValue(userOwned)
    coreApi.readNamespacedServiceAccount.mockResolvedValue(userOwned)

    await reconciler.reconcile(makeHost({ name: 'chatllm' }))

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(networkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(rbacApi.deleteNamespacedRoleBinding).not.toHaveBeenCalled()
    expect(rbacApi.deleteNamespacedRole).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedServiceAccount).not.toHaveBeenCalled()
  })

  it('preserves existing runtime on transient Host secret read error', async () => {
    const err = new Error('api unavailable') as Error & { code?: number }
    err.code = 500
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)

    await reconciler.reconcile(makeHost({ name: 'chatllm' }))

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })
})

describe('HostReconciler Kubernetes request deadline wiring', () => {
  it('wraps every default finite Kubernetes client, including lazy CustomObjects', async () => {
    const rawClients = Array.from({ length: 5 }, () => ({
      probe: vi.fn(async (_request: unknown, _options?: unknown) => ({})),
    }))
    const pendingClients = [...rawClients]
    const kubeConfig = {
      makeApiClient: vi.fn(() => pendingClients.shift()),
    } as unknown as k8s.KubeConfig
    const reconciler = new HostReconciler(kubeConfig)
    const internals = reconciler as unknown as {
      appsApi: { probe(request: unknown): Promise<unknown> }
      coreApi: { probe(request: unknown): Promise<unknown> }
      networkingApi: { probe(request: unknown): Promise<unknown> }
      rbacApi: { probe(request: unknown): Promise<unknown> }
      customApi: { probe(request: unknown): Promise<unknown> }
    }

    for (const client of [
      internals.appsApi,
      internals.coreApi,
      internals.networkingApi,
      internals.rbacApi,
      internals.customApi,
    ]) {
      await client.probe({})
    }

    expect(kubeConfig.makeApiClient).toHaveBeenCalledTimes(5)
    for (const rawClient of rawClients) {
      expect(rawClient.probe).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          middleware: [expect.objectContaining({ pre: expect.any(Function) })],
          middlewareMergeStrategy: 'append',
        })
      )
    }
  })
})

function makeBasicReconciler() {
  return new HostReconciler({} as k8s.KubeConfig, {
    appsApi: asAppsApi(createMockAppsApi()),
    coreApi: asCoreApi(createMockCoreApi()),
    networkingApi: asNetworkingApi(createMockNetworkingApi()),
    rbacApi: asRbacApi(createMockRbacApi()),
  })
}

describe('HostReconciler fleet failure isolation', () => {
  it('continues reconciling later Hosts and aggregates the failure', async () => {
    const reconciler = makeBasicReconciler()
    // Cleanup stays deferred (authority unwired), isolating reconcile behavior.
    const firstFailure = new Error('first Host failed')
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockImplementation(async host => {
      if (host.name === 'host-a') throw firstFailure
    })

    let thrown: unknown
    try {
      await reconciler.fullReconcile([makeHost({ name: 'host-a' }), makeHost({ name: 'host-b' })])
    } catch (error) {
      thrown = error
    }

    expect(reconcile.mock.calls.map(([host]) => host.name)).toEqual(['host-a', 'host-b'])
    expect(thrown).toBeInstanceOf(HostFleetReconcileError)
    expect((thrown as HostFleetReconcileError).hostFailures).toEqual([firstFailure])
    // Authority is unwired, so cleanup fail-closes (defers) rather than deleting.
    expect((thrown as HostFleetReconcileError).cleanupFailures).toEqual([])
  })

  it('continues with Host B when Host A reaches its Kubernetes request deadline', async () => {
    const reconciler = makeBasicReconciler()
    const timeout = new HostK8sRequestTimeoutError('AppsV1Api.readNamespacedDeployment', 30_000)
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockImplementation(async host => {
      if (host.name === 'host-a') throw timeout
    })

    let thrown: unknown
    try {
      await reconciler.fullReconcile([makeHost({ name: 'host-a' }), makeHost({ name: 'host-b' })])
    } catch (error) {
      thrown = error
    }

    expect(reconcile.mock.calls.map(([host]) => host.name)).toEqual(['host-a', 'host-b'])
    expect(thrown).toBeInstanceOf(HostFleetReconcileError)
    expect((thrown as HostFleetReconcileError).hostFailures).toEqual([timeout])
  })

  it('aggregates candidate-discovery list failures under known authority', async () => {
    const reconciler = makeBasicReconciler()
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 1 }))
    reconciler.setResolveCurrentHost(name => (name === 'host-a' ? makeHost({ name }) : undefined))
    vi.spyOn(reconciler, 'reconcile').mockResolvedValue()
    const internals = reconciler as unknown as {
      listManagedHostDeployments(): Promise<k8s.V1Deployment[]>
    }
    const inventoryFailure = new Error('Host Deployment inventory failed')
    vi.spyOn(internals, 'listManagedHostDeployments').mockRejectedValue(inventoryFailure)

    let thrown: unknown
    try {
      await reconciler.fullReconcile([makeHost({ name: 'host-a' })])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(HostFleetReconcileError)
    expect((thrown as HostFleetReconcileError).hostFailures).toEqual([])
    expect((thrown as HostFleetReconcileError).cleanupFailures).toContain(inventoryFailure)
  })

  it('preserves simultaneous Host and cleanup failures after every phase has run', async () => {
    const reconciler = makeBasicReconciler()
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 1 }))
    reconciler.setResolveCurrentHost(name =>
      name === 'host-a' || name === 'host-b' ? makeHost({ name }) : undefined
    )
    const hostFailure = new Error('Host deployment failed')
    const cleanupFailure = new Error('Host inventory failed')
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockImplementation(async host => {
      if (host.name === 'host-a') throw hostFailure
    })
    const internals = reconciler as unknown as {
      listManagedHostDeployments(): Promise<k8s.V1Deployment[]>
    }
    vi.spyOn(internals, 'listManagedHostDeployments').mockRejectedValue(cleanupFailure)

    let thrown: unknown
    try {
      await reconciler.fullReconcile([makeHost({ name: 'host-a' }), makeHost({ name: 'host-b' })])
    } catch (error) {
      thrown = error
    }

    expect(reconcile.mock.calls.map(([host]) => host.name)).toEqual(['host-a', 'host-b'])
    expect(thrown).toBeInstanceOf(HostFleetReconcileError)
    expect((thrown as HostFleetReconcileError).hostFailures).toEqual([hostFailure])
    expect((thrown as HostFleetReconcileError).cleanupFailures).toContain(cleanupFailure)
  })

  it('deletes each confirmed orphan bundle and aggregates delete failures', async () => {
    const getObj = vi.fn().mockRejectedValue({ code: 404 })
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(createMockCoreApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
      customApi: { getNamespacedCustomObject: getObj } as unknown as k8s.CustomObjectsApi,
    })
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 1 }))
    reconciler.setResolveCurrentHost(() => undefined)
    const internals = reconciler as unknown as {
      listManagedHostDeployments(): Promise<k8s.V1Deployment[]>
      deleteHostRuntimeResources(name: string, namespace: string): Promise<void>
    }
    const orphanFailure = new Error('first orphan cleanup failed')
    vi.spyOn(internals, 'listManagedHostDeployments').mockResolvedValue([
      {
        metadata: {
          name: 'orphan-a',
          namespace: 'mcp-host',
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/host': 'orphan-a',
          },
        },
      } as k8s.V1Deployment,
      {
        metadata: {
          name: 'orphan-b',
          namespace: 'mcp-host',
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/host': 'orphan-b',
          },
        },
      } as k8s.V1Deployment,
    ])
    const del = vi
      .spyOn(internals, 'deleteHostRuntimeResources')
      .mockRejectedValueOnce(orphanFailure)
      .mockResolvedValueOnce()

    let thrown: unknown
    try {
      await reconciler.fullReconcile([])
    } catch (error) {
      thrown = error
    }

    expect(del.mock.calls.map(([name]) => name).sort()).toEqual(['orphan-a', 'orphan-b'])
    expect(getObj).toHaveBeenCalledTimes(2)
    expect(thrown).toBeInstanceOf(HostFleetReconcileError)
    expect((thrown as HostFleetReconcileError).cleanupFailures).toContain(orphanFailure)
  })
})

/**
 * Current value of clerum_hcc_host_delete_cleanup_total for one `outcome`
 * label. Read from the live HCC registry (metrics are NOT mocked here), so a
 * skip that fails to record is caught rather than passing silently.
 */
async function readHostDeleteCleanupOutcome(outcome: string): Promise<number> {
  const metric = registry.getSingleMetric('clerum_hcc_host_delete_cleanup_total')
  if (!metric) throw new Error('clerum_hcc_host_delete_cleanup_total is not registered')
  const snapshot = await metric.get()
  const match = snapshot.values.find(entry => entry.labels.outcome === outcome)
  return match?.value ?? 0
}

function makeCleanupReconciler(customApi: { getNamespacedCustomObject: ReturnType<typeof vi.fn> }) {
  return new HostReconciler({} as k8s.KubeConfig, {
    appsApi: asAppsApi(createMockAppsApi()),
    coreApi: asCoreApi(createMockCoreApi()),
    networkingApi: asNetworkingApi(createMockNetworkingApi()),
    rbacApi: asRbacApi(createMockRbacApi()),
    customApi: customApi as unknown as k8s.CustomObjectsApi,
  })
}

describe('HostReconciler bounded fleet workers', () => {
  it('admits at most the configured number of Host reconciles concurrently', async () => {
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(createMockCoreApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
    })
    // Isolate reconcile concurrency from the cleanup phase.
    vi.spyOn(
      reconciler as unknown as {
        collectHostCleanupFailures(...args: unknown[]): Promise<unknown[]>
      },
      'collectHostCleanupFailures'
    ).mockResolvedValue([])
    let active = 0
    let maxActive = 0
    const gates: Array<() => void> = []
    vi.spyOn(reconciler, 'reconcile').mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => gates.push(resolve))
      active -= 1
    })
    const hosts = ['h1', 'h2', 'h3', 'h4'].map(name => makeHost({ name }))
    const pass = reconciler.fullReconcile(hosts)

    // Only two workers may run at once; the pool must not admit h3/h4 yet.
    await vi.waitFor(() => expect(gates.length).toBe(2))
    expect(maxActive).toBe(2)

    // Drain: each release lets the pool admit the next queued Host key.
    for (let i = 0; i < hosts.length; i++) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0))
      gates.shift()!()
    }
    await pass
    expect(maxActive).toBe(2)
  })

  it('keeps urgent per-Host events outside the fleet worker budget', async () => {
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(createMockCoreApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
    })
    vi.spyOn(
      reconciler as unknown as {
        collectHostCleanupFailures(...args: unknown[]): Promise<unknown[]>
      },
      'collectHostCleanupFailures'
    ).mockResolvedValue([])
    let active = 0
    let maxActive = 0
    const gates = new Map<string, () => void>()
    vi.spyOn(reconciler, 'reconcile').mockImplementation(async host => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => gates.set(host.name, resolve))
      active -= 1
    })
    const fleetHosts = ['f1', 'f2', 'f3', 'f4'].map(name => makeHost({ name }))
    const pass = reconciler.fullReconcile(fleetHosts)
    await vi.waitFor(() => expect(gates.size).toBe(2)) // fleet budget saturated

    // An urgent event for an unrelated Host must still be admitted immediately,
    // even though the fleet workers already occupy the whole budget.
    const urgent = reconciler.reconcile(makeHost({ name: 'urgent' }), 'urgent')
    await vi.waitFor(() => expect(gates.has('urgent')).toBe(true))
    expect(maxActive).toBe(3) // 2 fleet + 1 urgent

    // Drain repeatedly so the remaining fleet workers (f3/f4) are admitted and
    // released as earlier ones finish.
    const settled = Promise.all([pass, urgent])
    for (let i = 0; i < 12; i++) {
      for (const [name, resolve] of [...gates]) {
        gates.delete(name)
        resolve()
      }
      await Promise.resolve()
      await Promise.resolve()
    }
    await settled
  })
})

describe('HostReconciler lifecycle-only vs full pass cleanup boundary', () => {
  it('reconcileHosts (lifecycle-only) runs NO orphan cleanup; fullReconcile does', async () => {
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(createMockCoreApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
    })
    const internals = reconciler as unknown as {
      collectHostReconcileFailures(...args: unknown[]): Promise<unknown[]>
      collectHostCleanupFailures(...args: unknown[]): Promise<unknown[]>
    }
    const reconcileFailures = vi
      .spyOn(internals, 'collectHostReconcileFailures')
      .mockResolvedValue([])
    const cleanup = vi.spyOn(internals, 'collectHostCleanupFailures').mockResolvedValue([])

    // The lifecycle-only pass is what CommunicationChannel recovery and the
    // heartbeat-driven fleet convergence dispatch through (k8sClient
    // reconcileHosts()). It MUST NOT run destructive orphan cleanup: a
    // lifecycle pass whose watch authority is stale could otherwise delete a
    // just-created Host's children (Risk register: "Stale full pass deletes a
    // new Host's resources" — critical). Only the authoritative full pass,
    // which captures watch authority up front, is allowed to clean up.
    await reconciler.reconcileHosts([makeHost({ name: 'h1' })])
    expect(reconcileFailures).toHaveBeenCalledTimes(1)
    expect(cleanup).not.toHaveBeenCalled()

    // The authoritative full pass is the ONLY caller that runs orphan cleanup.
    await reconciler.fullReconcile([makeHost({ name: 'h1' })])
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})

describe('HostReconciler bounded orphan cleanup (Addendum 2)', () => {
  it('deletes orphan bundles through the bounded worker pool, never an unbounded fan-out', async () => {
    const getObj = vi.fn().mockRejectedValue({ code: 404 })
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: getObj })
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 1 }))
    reconciler.setResolveCurrentHost(() => undefined) // every candidate is an orphan
    const internals = reconciler as unknown as {
      listManagedHostDeployments(): Promise<k8s.V1Deployment[]>
      deleteHostRuntimeResources(name: string, namespace: string): Promise<void>
    }
    vi.spyOn(internals, 'listManagedHostDeployments').mockResolvedValue(
      ['orphan-a', 'orphan-b', 'orphan-c', 'orphan-d'].map(
        name =>
          ({
            metadata: {
              name,
              namespace: 'mcp-host',
              labels: {
                'clerum.io/managed-by': 'host-context-controller',
                'clerum.io/host': name,
              },
            },
          }) as k8s.V1Deployment
      )
    )
    let active = 0
    let maxActive = 0
    const gates: Array<() => void> = []
    vi.spyOn(internals, 'deleteHostRuntimeResources').mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => gates.push(resolve))
      active -= 1
    })

    const pass = reconciler.fullReconcile([])

    // Bound = HCC_HOST_FULL_RECONCILE_CONCURRENCY (2): only two orphan bundles
    // delete at once; the pool must not admit orphan-c/orphan-d yet.
    await vi.waitFor(() => expect(gates.length).toBe(2))
    expect(maxActive).toBe(2)

    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0))
      gates.shift()!()
    }
    await pass
    expect(maxActive).toBe(2)
  })
})

describe('HostReconciler bounded channel-reader revision fan-out (Addendum 2)', () => {
  it('patches every affected Host through the bounded worker pool', async () => {
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(createMockCoreApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
    })
    ;(
      reconciler as unknown as {
        setFindCommunicationChannelsByCredentialsSecretName(fn: () => unknown[]): void
      }
    ).setFindCommunicationChannelsByCredentialsSecretName(() =>
      ['h1', 'h2', 'h3', 'h4'].map(hostRef => ({ spec: { hostRef } }))
    )
    let active = 0
    let maxActive = 0
    const patched: string[] = []
    const gates: Array<() => void> = []
    vi.spyOn(
      reconciler as unknown as {
        patchChannelReaderRevisionAnnotation(name: string): Promise<void>
      },
      'patchChannelReaderRevisionAnnotation'
    ).mockImplementation(async (name: string) => {
      patched.push(name)
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => gates.push(resolve))
      active -= 1
    })

    const pass = reconciler.reconcileChannelReaderRevision('shared-secret', 'channels')

    // Bound = 2: at most two affected Hosts patch concurrently.
    await vi.waitFor(() => expect(gates.length).toBe(2))
    expect(maxActive).toBe(2)

    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0))
      gates.shift()!()
    }
    await pass

    expect(maxActive).toBe(2)
    // Complete fan-out: every affected Host is patched exactly once.
    expect(patched.sort()).toEqual(['h1', 'h2', 'h3', 'h4'])
  })
})

describe('HostReconciler #827 cleanup hardening', () => {
  it('suppresses the delete when the Host reappears in cache after the fresh read (F2 TOCTOU)', async () => {
    const getObj = vi.fn().mockRejectedValue({ code: 404 })
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: getObj })
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 3 }))
    // resolveCurrentHost reports "absent" during discovery and the authority
    // gate, then "present" on the re-check INSIDE the per-Host serializer —
    // modelling a same-name Host recreated in the admission window. The F2
    // in-serializer re-check must suppress the destructive delete.
    let calls = 0
    reconciler.setResolveCurrentHost(name => {
      calls += 1
      return calls >= 3 ? makeHost({ name }) : undefined
    })
    const internals = reconciler as unknown as {
      listManagedHostDeployments(): Promise<k8s.V1Deployment[]>
      deleteHostRuntimeResources(name: string, namespace: string): Promise<void>
    }
    vi.spyOn(internals, 'listManagedHostDeployments').mockResolvedValue([
      {
        metadata: {
          name: 'gone',
          namespace: 'mcp-host',
          labels: { 'clerum.io/managed-by': 'host-context-controller', 'clerum.io/host': 'gone' },
        },
      } as k8s.V1Deployment,
    ])
    const del = vi.spyOn(internals, 'deleteHostRuntimeResources').mockResolvedValue()

    await reconciler.fullReconcile([])

    expect(getObj).toHaveBeenCalledTimes(1) // the fresh read happened (said absent)
    expect(del).not.toHaveBeenCalled() // but the in-serializer re-check suppressed the delete
  })

  it('discovers an orphan from a surviving owned resource when the Deployment is already gone (#827 item 4)', async () => {
    const getObj = vi.fn().mockRejectedValue({ code: 404 })
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: getObj })
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 1 }))
    reconciler.setResolveCurrentHost(() => undefined) // "gone" absent from cache
    const internals = reconciler as unknown as {
      listManagedHostDeployments(): Promise<k8s.V1Deployment[]>
      deleteHostRuntimeResources(name: string, namespace: string): Promise<void>
    }
    // The Deployment sentinel is already gone...
    vi.spyOn(internals, 'listManagedHostDeployments').mockResolvedValue([])
    // ...but a PVC leftover survives with ownership labels in the host namespace.
    ;(
      reconciler as unknown as {
        coreApi: { listNamespacedPersistentVolumeClaim: ReturnType<typeof vi.fn> }
      }
    ).coreApi.listNamespacedPersistentVolumeClaim.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'gone-workspace',
            namespace: 'mcp-host',
            labels: {
              'clerum.io/managed-by': 'host-context-controller',
              'clerum.io/host': 'gone',
            },
          },
        },
      ],
    })
    const del = vi.spyOn(internals, 'deleteHostRuntimeResources').mockResolvedValue()

    await reconciler.fullReconcile([])

    // The surviving PVC alone identified the orphan Host and drove its bundle delete.
    expect(getObj).toHaveBeenCalledWith(expect.objectContaining({ name: 'gone' }))
    expect(del).toHaveBeenCalledWith('gone', 'mcp-host')
  })
})

describe('HostReconciler delete serialization', () => {
  it('serializes a delete behind an in-flight reconcile for the same Host', async () => {
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(createMockCoreApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
    })
    const order: string[] = []
    const reconcileGate = deferred()
    vi.spyOn(
      reconciler as unknown as { reconcileCore(...args: unknown[]): Promise<void> },
      'reconcileCore'
    ).mockImplementation(async () => {
      order.push('reconcile:start')
      await reconcileGate.promise
      order.push('reconcile:end')
    })
    vi.spyOn(
      reconciler as unknown as { deleteHostRuntimeResources(...args: unknown[]): Promise<void> },
      'deleteHostRuntimeResources'
    ).mockImplementation(async () => {
      order.push('delete:start')
      order.push('delete:end')
    })

    const reconcilePromise = reconciler.reconcile(makeHost({ name: 'chatllm' }))
    const deletePromise = reconciler.reconcileDelete('chatllm', 'mcp-host')
    await Promise.resolve()
    await Promise.resolve()
    // The delete must NOT begin while the same Host's reconcile is in flight.
    expect(order).toEqual(['reconcile:start'])

    reconcileGate.resolve()
    await Promise.all([reconcilePromise, deletePromise])
    expect(order).toEqual(['reconcile:start', 'reconcile:end', 'delete:start', 'delete:end'])
  })

  // Recovery-path TOCTOU parity with the F2 fence in collectHostCleanupFailures.
  // The recovery delete (k8sClient.dispatchRecoveredHostDelete) diffs LIST-time
  // names only; a same-name Host recreated AFTER that diff and admitted to the
  // per-Host chain FIRST would otherwise have its freshly-reconciled bundle —
  // workspace PVC, per-Host RBAC, runtime-token Secret, channel-reader
  // resources, NetworkPolicies — wiped by the stale delete queued behind it.
  it('suppresses the delete when skipIf reports a recreation inside the admission window', async () => {
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: vi.fn() })
    const internals = reconciler as unknown as {
      deleteHostRuntimeResources(name: string, namespace: string): Promise<void>
    }
    const del = vi.spyOn(internals, 'deleteHostRuntimeResources').mockResolvedValue()
    const before = await readHostDeleteCleanupOutcome('superseded')

    // The fence is evaluated INSIDE the serializer, so it observes the cache as
    // of admission — not as of enqueue. Here it reports "recreated".
    let evaluatedInsideSerializer = false
    await reconciler.reconcileDelete('recreated-in-window', 'mcp-host', {
      skipIf: () => {
        evaluatedInsideSerializer = true
        return true
      },
    })

    expect(evaluatedInsideSerializer).toBe(true)
    expect(del).not.toHaveBeenCalled()
    // The skip is observable, not silent, and reuses the watch path's vocabulary.
    expect(await readHostDeleteCleanupOutcome('superseded')).toBe(before + 1)
  })

  it('still deletes the bundle when skipIf reports the Host really is gone', async () => {
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: vi.fn() })
    const internals = reconciler as unknown as {
      deleteHostRuntimeResources(name: string, namespace: string): Promise<void>
    }
    const del = vi.spyOn(internals, 'deleteHostRuntimeResources').mockResolvedValue()

    await reconciler.reconcileDelete('really-gone', 'mcp-host', { skipIf: () => false })

    expect(del).toHaveBeenCalledWith('really-gone', 'mcp-host')
  })

  it('keeps the existing unconditional behavior for callers that pass no options', async () => {
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: vi.fn() })
    const internals = reconciler as unknown as {
      deleteHostRuntimeResources(name: string, namespace: string): Promise<void>
    }
    const del = vi.spyOn(internals, 'deleteHostRuntimeResources').mockResolvedValue()

    await reconciler.reconcileDelete('no-opts', 'mcp-host')

    expect(del).toHaveBeenCalledWith('no-opts', 'mcp-host')
  })
})

describe('HostReconciler destructiveCleanupAllowed property', () => {
  it('permits deletion only with known authority, a stable generation, cache omission, and a confirmed 404', () => {
    expect(
      destructiveCleanupAllowed({
        watchAuthorityKnown: true,
        capturedWatchGeneration: 7,
        currentWatchGeneration: 7,
        currentCacheOmitsHost: true,
        freshAuthoritativeRead: 'confirmed404',
      })
    ).toBe(true)
  })

  it.each([
    ['authority unknown', { watchAuthorityKnown: false }],
    ['generation drifted', { currentWatchGeneration: 8 }],
    ['host still present in cache', { currentCacheOmitsHost: false }],
    ['fresh read present', { freshAuthoritativeRead: 'present' as const }],
    ['fresh read errored', { freshAuthoritativeRead: 'error' as const }],
  ])('refuses deletion when %s', (_label, override) => {
    expect(
      destructiveCleanupAllowed({
        watchAuthorityKnown: true,
        capturedWatchGeneration: 7,
        currentWatchGeneration: 7,
        currentCacheOmitsHost: true,
        freshAuthoritativeRead: 'confirmed404',
        ...override,
      })
    ).toBe(false)
  })
})

describe('HostReconciler cleanup authority gate', () => {
  function orphanDeployment(hostName: string) {
    return {
      metadata: {
        name: hostName,
        namespace: 'mcp-host',
        labels: {
          'clerum.io/managed-by': 'host-context-controller',
          'clerum.io/host': hostName,
        },
      },
    } as k8s.V1Deployment
  }

  function wireCleanup(
    reconciler: HostReconciler,
    opts: {
      authority: { known: boolean; generation: number }
      currentAuthority?: { known: boolean; generation: number }
      cache: Set<string>
      candidates: k8s.V1Deployment[]
    }
  ) {
    let firstCall = true
    reconciler.setHostWatchAuthority(() => {
      if (firstCall) {
        firstCall = false
        return opts.authority
      }
      return opts.currentAuthority ?? opts.authority
    })
    reconciler.setResolveCurrentHost(name =>
      opts.cache.has(name) ? makeHost({ name }) : undefined
    )
    const internals = reconciler as unknown as {
      listManagedHostDeployments(): Promise<k8s.V1Deployment[]>
      deleteHostRuntimeResources(name: string, namespace: string): Promise<void>
    }
    vi.spyOn(internals, 'listManagedHostDeployments').mockResolvedValue(opts.candidates)
    return vi.spyOn(internals, 'deleteHostRuntimeResources').mockResolvedValue()
  }

  it('deletes an orphan bundle after a fresh 404 while authority is known and stable', async () => {
    const getObj = vi.fn().mockRejectedValue({ code: 404 })
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: getObj })
    const del = wireCleanup(reconciler, {
      authority: { known: true, generation: 3 },
      cache: new Set(),
      candidates: [orphanDeployment('gone-host')],
    })

    await reconciler.fullReconcile([])

    expect(getObj).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith('gone-host', 'mcp-host')
  })

  it('retains a candidate that is still present in the current cache', async () => {
    const getObj = vi.fn()
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: getObj })
    const del = wireCleanup(reconciler, {
      authority: { known: true, generation: 3 },
      cache: new Set(['live-host']),
      candidates: [orphanDeployment('live-host')],
    })

    await reconciler.fullReconcile([])

    expect(getObj).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('defers all cleanup when watch authority is unknown', async () => {
    const getObj = vi.fn()
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: getObj })
    const del = wireCleanup(reconciler, {
      authority: { known: false, generation: 3 },
      cache: new Set(),
      candidates: [orphanDeployment('gone-host')],
    })

    await reconciler.fullReconcile([])

    expect(getObj).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('defers all cleanup when the watch generation changed during the pass', async () => {
    const getObj = vi.fn().mockRejectedValue({ code: 404 })
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: getObj })
    const del = wireCleanup(reconciler, {
      authority: { known: true, generation: 3 },
      currentAuthority: { known: true, generation: 4 },
      cache: new Set(),
      candidates: [orphanDeployment('gone-host')],
    })

    await reconciler.fullReconcile([])

    expect(del).not.toHaveBeenCalled()
  })

  it('defers an orphan whose fresh authoritative read fails', async () => {
    const getObj = vi.fn().mockRejectedValue({ code: 503 })
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: getObj })
    const del = wireCleanup(reconciler, {
      authority: { known: true, generation: 3 },
      cache: new Set(),
      candidates: [orphanDeployment('maybe-gone')],
    })

    await reconciler.fullReconcile([])

    expect(getObj).toHaveBeenCalledTimes(1)
    expect(del).not.toHaveBeenCalled()
  })

  it('retains an orphan whose fresh authoritative read shows it present', async () => {
    const getObj = vi.fn().mockResolvedValue({ metadata: { name: 'reappeared' } })
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: getObj })
    const del = wireCleanup(reconciler, {
      authority: { known: true, generation: 3 },
      cache: new Set(),
      candidates: [orphanDeployment('reappeared')],
    })

    await reconciler.fullReconcile([])

    expect(getObj).toHaveBeenCalledTimes(1)
    expect(del).not.toHaveBeenCalled()
  })

  it('never deletes a candidate whose owning Host cannot be derived from labels', async () => {
    const getObj = vi.fn()
    const reconciler = makeCleanupReconciler({ getNamespacedCustomObject: getObj })
    const del = wireCleanup(reconciler, {
      authority: { known: true, generation: 3 },
      cache: new Set(),
      candidates: [
        {
          metadata: {
            name: 'unlabeled',
            namespace: 'mcp-host',
            labels: { 'clerum.io/managed-by': 'host-context-controller' },
          },
        } as k8s.V1Deployment,
      ],
    })

    await reconciler.fullReconcile([])

    expect(getObj).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })
})
